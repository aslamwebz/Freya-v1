import { randomUUID } from 'node:crypto'
import { withResearchAbort } from './async'
import type { ManagedBrowserService } from './browser'
import { buildSource, selectSources, serializeSource, type ResearchSource } from './evidence'
import { ResearchError, safeResearchError, type ResearchErrorCode } from './errors'
import { researchMessages, type ModelStage, type ResearchMessage } from './prompts'
import { parsePlan, parseSynthesis, researchLimits, type ResearchLimits, type ResearchPlan, type ResearchSynthesis } from './schemas'
import type { Searcher } from './searcher'
import type { SearchResult } from './types'
import { normalizeSourceUrl } from './url-policy'

export { RESEARCH_LIMITS } from './schemas'
export type { ResearchFinding } from './schemas'
export type { ResearchSource } from './evidence'
export interface ResearchModel {
  complete(messages: readonly ResearchMessage[], options: { signal: AbortSignal; researchId: string; requestId: string; maxOutputTokens: number }): Promise<string>
}
export interface ResearchUsage {
  iterations: number; queries: number; results: number; pages: number; evidenceChars: number
  modelTurns: number; failures: number; durationMs: number
}
export type ResearchState = 'completed' | 'partial' | 'failed' | 'cancelled'
export type ResearchStage = 'authorizing' | ModelStage | 'searching' | 'reading' | ResearchState
/** URL appears only in the result projection, never in events or status. */
export interface ResearchFailure { stage: ResearchStage; code: ResearchErrorCode; url?: string }
export interface ResearchResult extends ResearchSynthesis {
  id: string; question: string; state: ResearchState; sources: ResearchSource[]; failures: ResearchFailure[]; usage: ResearchUsage
}
export interface ResearchStatus { id: string; stage: ResearchStage; usage: ResearchUsage }
export interface ResearchEvent { researchId: string; stage: ResearchStage; usage: ResearchUsage; failureCode?: ResearchErrorCode }
export interface ResearchAuthorization { operation: 'research' | 'search' | 'read'; researchId: string; requestId: string; signal: AbortSignal }
export interface ResearchCoordinatorOptions {
  searcher: Pick<Searcher, 'searchWeb'>
  browser: Pick<ManagedBrowserService, 'readWebPage'>
  model: ResearchModel
  now?: () => number
  newId?: () => string
  onEvent?: (event: ResearchEvent) => void
  authorize?: (request: ResearchAuthorization) => void | Promise<void>
  limits?: Partial<ResearchLimits>
}
interface Job {
  id: string; question: string; controller: AbortController; signal: AbortSignal; started: number
  stage: ResearchStage; usage: ResearchUsage; sources: ResearchSource[]; failures: ResearchFailure[]
  limited: boolean; pending: Promise<ResearchResult>; sourceUrl?: string; timedOut?: boolean
}
class BudgetReached extends Error {}

/** One explicit foreground research job, with no scheduler, persistence or executable model actions. */
export class ResearchCoordinator {
  private readonly limits: Readonly<ResearchLimits>
  private readonly now: () => number
  private active: Job | null = null
  constructor(private readonly options: ResearchCoordinatorOptions) {
    this.limits = researchLimits(options.limits)
    this.now = options.now ?? Date.now
  }

  async research(question: string, options: { signal?: AbortSignal } = {}): Promise<ResearchResult> {
    if (this.active) throw new ResearchError('invalid_response')
    if (typeof question !== 'string' || !question.trim() || question.length > 4096) throw new ResearchError('invalid_query')
    const controller = new AbortController()
    const job: Job = {
      id: this.id(), question: question.trim(), controller,
      signal: options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal,
      started: this.now(), stage: 'authorizing',
      usage: { iterations: 0, queries: 0, results: 0, pages: 0, evidenceChars: 0, modelTurns: 0, failures: 0, durationMs: 0 },
      sources: [], failures: [], limited: false, pending: undefined as unknown as Promise<ResearchResult>,
    }
    this.active = job
    const timer = setTimeout(() => { job.timedOut = true; controller.abort() }, this.limits.durationMs)
    timer.unref?.()
    job.pending = this.run(job).finally(() => { clearTimeout(timer); if (this.active === job) this.active = null })
    return job.pending
  }

  current(): ResearchStatus | null {
    return this.active ? { id: this.active.id, stage: this.active.stage, usage: this.usage(this.active) } : null
  }
  cancel(id: string): boolean {
    if (!this.active || this.active.id !== id || this.active.signal.aborted) return false
    this.active.controller.abort()
    return true
  }
  cancelAll(): void { this.active?.controller.abort() }
  async drain(): Promise<void> { await this.active?.pending }

  private id(): string {
    const id = this.options.newId?.() ?? randomUUID()
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new ResearchError('invalid_response')
    return id
  }
  private usage(job: Job): ResearchUsage {
    return { ...job.usage, durationMs: Math.min(this.limits.durationMs, Math.max(0, this.now() - job.started)) }
  }
  private stage(job: Job, stage: ResearchStage, failureCode?: ResearchErrorCode): void {
    job.stage = stage
    try { this.options.onEvent?.({ researchId: job.id, stage, usage: this.usage(job), ...(failureCode ? { failureCode } : {}) }) } catch { /* Observers do not own jobs. */ }
  }
  private check(job: Job): void {
    if (job.signal.aborted) throw new ResearchError('cancelled')
    if (this.now() - job.started >= this.limits.durationMs) throw new ResearchError('timeout')
    if (job.usage.failures >= this.limits.failures) throw new BudgetReached()
  }
  private async operation<T>(job: Job, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.check(job)
    const value = await withResearchAbort(job.signal, Math.max(1, this.limits.durationMs - (this.now() - job.started)), run)
    this.check(job)
    return value
  }
  private async authorize(job: Job, operation: ResearchAuthorization['operation'], requestId: string): Promise<void> {
    await this.operation(job, async signal => { await this.options.authorize?.({ operation, researchId: job.id, requestId, signal }) })
  }
  private failure(job: Job, error: unknown): void {
    if (error instanceof BudgetReached) { job.limited = true; return }
    const safe = safeResearchError(error, 'invalid_response')
    if (job.usage.failures < this.limits.failures) {
      job.usage.failures++
      job.failures.push({ stage: job.stage, code: safe.code, ...(job.stage === 'reading' && job.sourceUrl ? { url: job.sourceUrl } : {}) })
      this.stage(job, job.stage, safe.code)
    }
  }
  private reserve(job: Job, key: 'modelTurns' | 'queries' | 'pages' | 'iterations'): void {
    this.check(job)
    if (job.usage[key] >= this.limits[key]) { job.limited = true; throw new BudgetReached() }
    job.usage[key]++
  }
  private async model(job: Job, stage: ModelStage): Promise<string> {
    this.reserve(job, 'modelTurns')
    this.stage(job, stage)
    return this.operation(job, signal => this.options.model.complete(researchMessages(stage, job.question, job.sources), {
      signal, researchId: job.id, requestId: this.id(), maxOutputTokens: this.limits.maxOutputTokens,
    }))
  }
  private terminal(job: Job, error: unknown): boolean {
    return error instanceof BudgetReached || (error instanceof ResearchError && (error.code === 'cancelled' ||
      (error.code === 'timeout' && (job.timedOut || this.now() - job.started >= this.limits.durationMs))))
  }
  private hasRetrievalBudget(job: Job): boolean {
    return job.usage.queries < this.limits.queries && job.usage.results < this.limits.results && job.usage.pages < this.limits.pages && job.usage.evidenceChars < this.limits.evidenceChars
  }
  private async gather(job: Job, plan: ResearchPlan, queries: Set<string>, visited: Set<string>): Promise<void> {
    this.reserve(job, 'iterations')
    const hits: SearchResult[] = []
    const origin = new Map<string, string>()
    for (const query of plan.queries) {
      if (queries.has(query)) continue
      if (job.usage.queries >= this.limits.queries || job.usage.results >= this.limits.results) { job.limited = true; break }
      this.check(job)
      const requestId = this.id()
      this.stage(job, 'searching')
      await this.authorize(job, 'search', requestId)
      this.reserve(job, 'queries'); queries.add(query)
      try {
        const remaining = this.limits.results - job.usage.results
        const found = await this.operation(job, signal => this.options.searcher.searchWeb(query, { signal, limit: Math.min(10, remaining) }))
        for (const row of found.slice(0, Math.min(10, remaining))) {
          job.usage.results++
          const url = normalizeSourceUrl(row.url)
          if (!origin.has(url)) { origin.set(url, query); hits.push({ ...row, url }) }
        }
      } catch (error) { if (this.terminal(job, error)) throw error; this.failure(job, error) }
    }
    const selected = selectSources(hits.filter(hit => !visited.has(hit.url)), 24)
    for (const hit of selected) {
      if (job.usage.pages >= this.limits.pages || job.usage.evidenceChars >= this.limits.evidenceChars) { job.limited = true; break }
      this.check(job)
      job.sourceUrl = hit.url
      this.stage(job, 'reading')
      await this.authorize(job, 'read', this.id())
      this.reserve(job, 'pages'); visited.add(hit.url)
      try {
        const document = await this.operation(job, signal => this.options.browser.readWebPage(hit.url, { signal }))
        if (!document.text.trim()) throw new ResearchError('unsupported_document')
        const source = buildSource(document, origin.get(hit.url) ?? '', Math.min(this.limits.documentChars, this.limits.evidenceChars - job.usage.evidenceChars))
        if (!source) { job.limited = true; continue }
        const retrieval = normalizeSourceUrl(source.url)
        visited.add(retrieval)
        if (job.sources.some(existing => existing.sourceId === source.sourceId)) continue
        job.usage.evidenceChars += serializeSource(source).length
        job.sources.push(source)
        if (source.truncated) job.limited = true
      } catch (error) { if (this.terminal(job, error)) throw error; this.failure(job, error) }
    }
  }
  private async run(job: Job): Promise<ResearchResult> {
    let synthesis: ResearchSynthesis = { findings: [], conflicts: [], uncertainties: [] }
    let cancelled = false
    try {
      this.stage(job, 'authorizing')
      await this.authorize(job, 'research', this.id())
      const plan = parsePlan(await this.model(job, 'planning'))
      const queries = new Set<string>(), visited = new Set<string>()
      await this.gather(job, plan, queries, visited)
      // Keep a turn for synthesis; gap planning cannot spend the final turn.
      if (job.usage.iterations < this.limits.iterations && this.hasRetrievalBudget(job) && this.limits.modelTurns - job.usage.modelTurns >= 2) {
        const gap = parsePlan(await this.model(job, 'gap'))
        if (!gap.done && gap.queries.length && gap.evidence?.length) await this.gather(job, gap, queries, visited)
      }
      if (job.sources.length) synthesis = parseSynthesis(await this.model(job, 'synthesizing'), job.sources)
    } catch (error) {
      cancelled = !job.timedOut && (job.signal.aborted || (error instanceof ResearchError && error.code === 'cancelled'))
      this.failure(job, job.timedOut ? new ResearchError('timeout') : error)
    }
    const state: ResearchState = cancelled ? 'cancelled' : !job.sources.length ? 'failed' : job.limited || job.failures.length || !synthesis.findings.length ? 'partial' : 'completed'
    if (state !== 'completed' && synthesis.uncertainties.length < 16) synthesis.uncertainties.push('Research is incomplete; retrieved sources are unverified evidence.')
    this.stage(job, state)
    return { id: job.id, question: job.question, state, sources: job.sources, ...synthesis, failures: job.failures, usage: this.usage(job) }
  }
}
