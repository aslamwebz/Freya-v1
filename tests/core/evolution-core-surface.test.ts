// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCore, type Core } from '../../core/index'
import { FakeModelProvider } from '../../core/model/fake-provider'
import { MemoryConversationStore } from '../../core/conversation/memory-store'
import { evolutionInternals } from '../../core/testing'
import { generateCandidateFromWeakness } from '../../core/evolution/strategy'

let core: Core | null = null
let folder: string | null = null
afterEach(async () => {
  await core?.stop('test-teardown')
  core = null
  if (folder) await rm(folder, { recursive: true, force: true })
  folder = null
})

describe('Phase 7 ? no self-authorized promotion through Core public queries', () => {
  it('provides safe read-only snapshots, not lifecycle or store mutation capabilities', async () => {
    folder = await mkdtemp(join(tmpdir(), 'freya-evolution-surface-'))
    core = createCore({
      dataPath: join(folder, 'events.jsonl'),
      providers: [new FakeModelProvider()],
      conversationStore: new MemoryConversationStore({ mode: 'memory' }),
    })
    await core.start()
    const lifecycleView = core.evolution()
    const storeView = core.evolutionStore()
    expect(lifecycleView).toBeDefined()
    expect(storeView).toBeDefined()
    expect(Object.isFrozen(lifecycleView)).toBe(true)
    expect(Object.isFrozen(storeView)).toBe(true)
    expect(Object.keys(lifecycleView!)).toEqual(['getActiveStrategy', 'getPromotionHistory', 'getRollbackHistory'])
    expect(Object.keys(storeView!).sort()).toEqual([
      'durable', 'faultReason', 'getCandidate', 'mode', 'readCandidates',
    ])
    // A model/worker with a Core reference cannot call an approval, promotion,
    // rollback, or store-write verb through the public read views.
    for (const forbidden of [
      'decidePromotionApproval', 'requestPromotionApproval', 'promoteCandidate',
      'rollbackStrategy', 'monitorAndEvaluateRegression', 'submitEvaluation',
    ]) {
      expect(forbidden in lifecycleView!).toBe(false)
    }
    for (const forbidden of ['writeCandidate', 'writeApproval', 'writePromotionRecord']) {
      expect(forbidden in storeView!).toBe(false)
    }

    // Even a caller mutating a returned nested record cannot change the real store.
    const candidate = generateCandidateFromWeakness({
      weaknessId: 'weak-evo-scope',
      kind: 'poor_source_selection',
      description: 'Repeated verified source selection defects',
      occurrenceCount: 3,
      supportingEvidenceIds: ['mission-1', 'mission-2', 'mission-3'],
      confidence: 'moderate',
      causalEvidenceStatus: 'correlated',
      sampleSize: 3,
      firstObservedAt: '2026-10-09T12:00:00Z',
      lastObservedAt: '2026-10-10T12:00:00Z',
    })
    expect(candidate).not.toBeNull()
    await evolutionInternals(core).store!.writeCandidate(candidate!)
    const publicRecord = await storeView!.getCandidate(candidate!.candidateId)
    expect(publicRecord).not.toBeNull()
    const publicOriginal = publicRecord!.parameters.prioritizeVerifiedDomains
    ;(publicRecord!.parameters as { prioritizeVerifiedDomains: boolean }).prioritizeVerifiedDomains = !publicOriginal
    expect((await storeView!.getCandidate(candidate!.candidateId))?.parameters.prioritizeVerifiedDomains).toBe(publicOriginal)
    expect((await storeView!.readCandidates()).length).toBe(1)
  })
})
