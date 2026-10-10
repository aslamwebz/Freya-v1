/**
 * FREYA EVOLUTION — Candidate & Strategy Store Interface & Memory Implementation
 */

import type { CandidateStatus, StrategyCandidate } from './strategy'
import type { PromotionRecord, RollbackRecord, StrategyPromotionApproval } from './approval'

export interface EvolutionStoreHealth {
  readonly mode: 'encrypted' | 'ephemeral'
  readonly durable: boolean
  readonly faultReason: string | null
}

export interface EvolutionStore {
  readonly mode: 'encrypted' | 'ephemeral'
  readonly durable: boolean
  readonly faultReason: string | null

  readCandidates(): Promise<readonly StrategyCandidate[]>
  writeCandidate(candidate: StrategyCandidate): Promise<void>
  getCandidate(candidateId: string): Promise<StrategyCandidate | null>
  updateCandidateStatus(
    candidateId: string,
    status: CandidateStatus,
    rejectionReason?: string | null,
  ): Promise<boolean>
  deleteCandidate(candidateId: string): Promise<boolean>

  // Approvals (Finding 1 & 6)
  readApprovals(): Promise<readonly StrategyPromotionApproval[]>
  writeApproval(approval: StrategyPromotionApproval): Promise<void>
  getApproval(approvalId: string): Promise<StrategyPromotionApproval | null>

  // Promotion & Rollback Lifecycle Records (Finding 6)
  readPromotionHistory(): Promise<readonly PromotionRecord[]>
  writePromotionRecord(record: PromotionRecord): Promise<void>
  readRollbackHistory(): Promise<readonly RollbackRecord[]>
  writeRollbackRecord(record: RollbackRecord): Promise<void>

  close(): Promise<void>
}

export class MemoryEvolutionStore implements EvolutionStore {
  readonly mode = 'ephemeral' as const
  readonly durable = false
  readonly faultReason: string | null

  private readonly candidates = new Map<string, StrategyCandidate>()
  private readonly approvals = new Map<string, StrategyPromotionApproval>()
  private readonly promotions: PromotionRecord[] = []
  private readonly rollbacks: RollbackRecord[] = []

  constructor(options?: { faultReason?: string | null }) {
    this.faultReason = options?.faultReason ?? null
  }

  async readCandidates(): Promise<readonly StrategyCandidate[]> {
    return [...this.candidates.values()]
  }

  async writeCandidate(candidate: StrategyCandidate): Promise<void> {
    this.candidates.set(candidate.candidateId, candidate)
  }

  async getCandidate(candidateId: string): Promise<StrategyCandidate | null> {
    return this.candidates.get(candidateId) ?? null
  }

  async updateCandidateStatus(
    candidateId: string,
    status: CandidateStatus,
    rejectionReason?: string | null,
  ): Promise<boolean> {
    const existing = this.candidates.get(candidateId)
    if (!existing) return false
    const updated: StrategyCandidate = {
      ...existing,
      status,
      rejectionReason: rejectionReason !== undefined ? rejectionReason : existing.rejectionReason,
      updatedAt: new Date().toISOString(),
    }
    this.candidates.set(candidateId, updated)
    return true
  }

  async deleteCandidate(candidateId: string): Promise<boolean> {
    return this.candidates.delete(candidateId)
  }

  async readApprovals(): Promise<readonly StrategyPromotionApproval[]> {
    return [...this.approvals.values()]
  }

  async writeApproval(approval: StrategyPromotionApproval): Promise<void> {
    this.approvals.set(approval.approvalId, approval)
  }

  async getApproval(approvalId: string): Promise<StrategyPromotionApproval | null> {
    return this.approvals.get(approvalId) ?? null
  }

  async readPromotionHistory(): Promise<readonly PromotionRecord[]> {
    return [...this.promotions]
  }

  async writePromotionRecord(record: PromotionRecord): Promise<void> {
    this.promotions.push(record)
  }

  async readRollbackHistory(): Promise<readonly RollbackRecord[]> {
    return [...this.rollbacks]
  }

  async writeRollbackRecord(record: RollbackRecord): Promise<void> {
    this.rollbacks.push(record)
  }

  async close(): Promise<void> {
    // No-op for in-memory
  }
}
