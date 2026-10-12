import type { ToolObservation } from './tools/types'

export type EvidenceKind = 'snippet' | 'observation' | 'verification' | 'artifact'
export type ExecutionFailureKind = 'malformed_request' | 'native_tool_error' | 'truncated' | 'tool_error' | 'unavailable'
  | 'empty_observation' | 'stale_reference' | 'timeout' | 'rate_limit' | 'budget_exhausted' | 'permission' | 'cancelled' | 'no_progress' | 'incomplete' | 'impossible'
export interface ExecutionRequirement {
  id: string
  description: string
  kind: 'answer' | EvidenceKind
  evidenceIds: string[]
  satisfied: boolean
}
export interface ExecutionObservation {
  id: string
  tool: string
  arguments: Record<string, string>
  executed: boolean
  evidenceKind: EvidenceKind
  observation: ToolObservation
}
/** Shared Mind state. No principal, capabilities, grant creation or memory writes. */
export interface MindExecutionState {
  version: 1
  taskId: string
  executionId: string
  scopeId: string
  objective: string
  constraints: string[]
  approach: string
  status: 'running' | 'incomplete' | 'completed' | 'blocked' | 'cancelled'
  requirements: ExecutionRequirement[]
  observations: ExecutionObservation[]
  failures: { kind: ExecutionFailureKind; reason: string; fingerprint?: string }[]
  blockers: string[]
  outstanding: string[]
  grantId: string
  providerCalls: number
  toolCalls: number
  reservedOutputTokens: number
  segment: number
}

const MAX_STATE_CHARS = 96_000
function text(value: unknown, limit = 2000): string {
  if (typeof value !== 'string' || value.length > limit) throw new Error('Invalid or oversized task decision field.')
  return value
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Task decision must be an object.')
  return value as Record<string, unknown>
}
function strings(value: unknown, limit = 32): string[] {
  if (!Array.isArray(value) || value.length > limit) throw new Error('Invalid task decision list.')
  return value.map(item => text(item))
}
const KINDS = ['answer', 'snippet', 'observation', 'verification', 'artifact'] as const

export function validateExecutionCheckpoint(raw: unknown): MindExecutionState {
  if (JSON.stringify(raw).length > MAX_STATE_CHARS) throw new Error('Execution checkpoint is too large.')
  const s = object(raw)
  if (s.version !== 1 || !['running', 'incomplete', 'completed', 'blocked', 'cancelled'].includes(String(s.status))) throw new Error('Invalid execution checkpoint version or status.')
  for (const key of ['taskId', 'executionId', 'scopeId', 'grantId']) text(s[key], 256)
  text(s.objective, 16_000); text(s.approach)
  for (const key of ['constraints', 'blockers', 'outstanding']) strings(s[key])
  for (const key of ['providerCalls', 'toolCalls', 'reservedOutputTokens', 'segment']) {
    if (!Number.isSafeInteger(s[key]) || Number(s[key]) < 0) throw new Error('Invalid execution counters.')
  }
  if (!Array.isArray(s.requirements) || s.requirements.length > 32 || !Array.isArray(s.observations) || s.observations.length > 64
    || !Array.isArray(s.failures) || s.failures.length > 64) throw new Error('Invalid execution records.')
  const ids = new Set<string>()
  for (const value of s.observations) {
    const o = object(value), observation = object(o.observation)
    text(o.id, 128); text(o.tool, 64)
    if (ids.has(String(o.id)) || typeof o.executed !== 'boolean' || !KINDS.slice(1).includes(o.evidenceKind as EvidenceKind)
      || !['ok', 'failed', 'denied'].includes(String(observation.kind)) || observation.tool !== o.tool) throw new Error('Invalid execution observation.')
    for (const [key, value] of Object.entries(object(o.arguments))) { text(key, 64); text(value, 64_000) }
    ids.add(String(o.id))
  }
  const requirements = new Set<string>()
  for (const value of s.requirements) {
    const r = object(value)
    const id = text(r.id, 128)
    text(r.description); strings(r.evidenceIds)
    if (requirements.has(id) || !KINDS.includes(r.kind as ExecutionRequirement['kind']) || typeof r.satisfied !== 'boolean'
      || (r.evidenceIds as string[]).some(id => !ids.has(id))) throw new Error('Invalid execution requirement.')
    requirements.add(id)
  }
  for (const value of s.failures) { const f = object(value); text(f.kind, 64); text(f.reason); if (f.fingerprint !== undefined) text(f.fingerprint, 66_000) }
  return structuredClone(raw as MindExecutionState)
}

export class MindExecution {
  private state: MindExecutionState
  constructor(input: { taskId: string; scopeId: string; objective: string; grantId: string }, saved?: MindExecutionState) {
    this.state = saved ? validateExecutionCheckpoint(saved) : {
      version: 1, taskId: input.taskId, executionId: input.taskId, scopeId: input.scopeId, objective: input.objective,
      constraints: [], approach: '', status: 'running', requirements: [], observations: [], failures: [], blockers: [], outstanding: [],
      grantId: input.grantId, providerCalls: 0, toolCalls: 0, reservedOutputTokens: 0, segment: 0,
    }
    if (this.state.scopeId !== input.scopeId || this.state.grantId !== input.grantId) throw new Error('Execution checkpoint scope mismatch.')
  }
  snapshot(): MindExecutionState { return structuredClone(this.state) }
  reserve(tokens: number): void { this.state.providerCalls++; this.state.reservedOutputTokens += tokens }
  segment(): void { this.state.segment++ }
  fail(kind: ExecutionFailureKind, reason: string, fingerprint?: string): void {
    if (this.state.failures.length >= 64) throw new Error('Execution failure record limit reached.')
    this.state.failures.push({ kind, reason: reason.slice(0, 2000), ...(fingerprint ? { fingerprint } : {}) })
  }
  boundary(reason: string, status: MindExecutionState['status'] = 'incomplete'): void {
    this.state.status = status
    this.state.blockers = [reason.slice(0, 2000)]
    this.state.outstanding = this.state.requirements.filter(r => !r.satisfied).map(r => r.description)
  }
  observe(tool: string, args: Readonly<Record<string, string>>, executed: boolean, observation: ToolObservation, evidenceKind: EvidenceKind): void {
    if (this.state.observations.length >= 64) throw new Error('Execution observation record limit reached.')
    // The registry bounded the observation. Large artifact bodies stay in their existing
    // artifact/transcript stores; the checkpoint keeps the receipt, not a second copy.
    const retained = observation.kind === 'ok' ? {
      ...observation,
      ...(observation.canvas ? { canvas: { ...observation.canvas, content: '[Artifact body retained by the existing tool result store.]' } } : {}),
    } : observation
    this.state.observations.push({ id: `o${this.state.observations.length + 1}`, tool, arguments: { ...args }, executed, evidenceKind, observation: retained })
    if (executed) this.state.toolCalls++
  }
  repeatedFailures(tool: string, args: Readonly<Record<string, string>>): number {
    const fingerprint = canonicalArguments(args)
    return this.state.observations.filter(o => o.tool === tool && canonicalArguments(o.arguments) === fingerprint && o.observation.kind !== 'ok').length
  }
  /** Model decisions are typed protocol data, never inferred from its final prose. */
  decide(raw: unknown): { answer?: string; resumeTaskId?: string } {
    const d = object(raw), action = text(d.action, 32)
    if (action === 'resume') return { resumeTaskId: text(d.taskId, 256) }
    if (action === 'plan') {
      const next = structuredClone(this.state)
      if (d.approach !== undefined) next.approach = text(d.approach)
      if (d.constraints !== undefined) next.constraints = [...new Set([...next.constraints, ...strings(d.constraints)])].slice(0, 32)
      if (d.outstanding !== undefined) next.outstanding = strings(d.outstanding)
      if (d.requirements !== undefined) {
        if (!Array.isArray(d.requirements) || d.requirements.length > 32) throw new Error('Invalid task requirements.')
        for (const item of d.requirements) {
          const r = object(item), id = text(r.id, 128), description = text(r.description), kind = text(r.kind, 32)
          if (!id || !description || !KINDS.includes(kind as ExecutionRequirement['kind'])) throw new Error('Invalid task requirement.')
          const existing = next.requirements.find(r => r.id === id)
          if (existing && (existing.kind !== kind || existing.description !== description)) throw new Error('Known requirements cannot be silently weakened or replaced.')
          if (!existing) next.requirements.push({ id, description, kind: kind as ExecutionRequirement['kind'], satisfied: false, evidenceIds: [] })
        }
      }
      if (next.requirements.length > 32) throw new Error('Task requirement limit reached.')
      next.status = 'running'; next.blockers = []
      this.state = next
      return {}
    }
    if (action === 'satisfy') {
      const requirement = this.state.requirements.find(r => r.id === d.requirementId)
      if (!requirement) throw new Error('Unknown requirement reference.')
      const ids = strings(d.evidenceIds ?? [])
      const evidence = ids.map(id => this.state.observations.find(o => o.id === id))
      if (requirement.kind !== 'answer' && (ids.length === 0 || evidence.some(o => !o?.executed || o.observation.kind !== 'ok'))) throw new Error('Requirement needs successfully executed evidence; missing or failed references do not qualify.')
      if (requirement.kind === 'verification' && !evidence.some(o => o?.evidenceKind === 'verification')) throw new Error('Requirement needs verification evidence; snippets and observations are not verification.')
      if (requirement.kind === 'observation' && evidence.some(o => o?.evidenceKind === 'snippet')) throw new Error('A search snippet is not an observed primary result.')
      if (requirement.kind === 'artifact' && !evidence.some(o => o?.evidenceKind === 'artifact')) throw new Error('Requirement needs an actual artifact receipt.')
      if (evidence.some(o => o === undefined)) throw new Error('Unknown evidence reference.')
      requirement.evidenceIds = ids; requirement.satisfied = true
      return {}
    }
    if (action === 'complete') {
      const answer = text(d.answer, 32_000)
      const unfinished = this.state.requirements.filter(r => !r.satisfied)
      if (!answer.trim() || unfinished.length || this.state.outstanding.length || this.state.blockers.length) throw new Error(`Task is unfinished: ${[...unfinished.map(r => r.description), ...this.state.outstanding, ...this.state.blockers].join('; ')}`)
      if (this.state.observations.length && !this.state.requirements.some(r => r.kind !== 'answer' && r.satisfied)) throw new Error('Completion after acting needs evidence-backed requirements for the objective.')
      this.state.status = 'completed'
      return { answer }
    }
    if (action === 'block') {
      this.boundary(text(d.reason), 'blocked')
      return { answer: d.answer === undefined ? undefined : text(d.answer, 32_000) }
    }
    throw new Error('Unknown task decision action.')
  }
  resume(saved: MindExecutionState): void {
    const next = validateExecutionCheckpoint(saved)
    if (next.scopeId !== this.state.scopeId || next.status === 'completed') throw new Error('No incomplete execution in this scope to resume.')
    const current = this.state
    this.state = { ...next, executionId: current.executionId, grantId: current.grantId,
      providerCalls: current.providerCalls, reservedOutputTokens: current.reservedOutputTokens, toolCalls: current.toolCalls,
      segment: current.segment, status: 'running', blockers: [] }
  }
}

/**
 * What kind of evidence an observation actually is.
 *
 * The distinction is drawn from what the tool reports, never from what the
 * objective was. A tool that fetched material off a thing says so in its
 * provenance; one that relayed a search engine's index line does not. That is
 * the whole difference between "I read this page" and "something said this page
 * exists", and it is the difference the reducer needs in order to refuse to let
 * the second stand in for the first.
 *
 * General by construction: nothing here knows what task is running.
 */
export function classifyEvidence(observation: ToolObservation): EvidenceKind {
  if (observation.kind !== 'ok') return 'observation'
  // A typed artifact is its own thing: a chart or a document is not a source,
  // and cannot be satisfied by reading somebody else's page.
  if (observation.chart !== undefined || observation.canvas !== undefined) return 'artifact'
  // Material actually read off the thing itself. The strongest kind.
  if (observation.provenance?.extract !== undefined && observation.provenance.extract.length > 0) return 'verification'
  // Sources with nothing read off them are an index, not a document.
  if (observation.sources.length > 0) return 'snippet'
  return 'observation'
}

export function canonicalArguments(args: Readonly<Record<string, string>>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(args).sort(([a], [b]) => a.localeCompare(b))))
}
