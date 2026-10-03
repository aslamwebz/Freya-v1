/** Renderer vocabulary only: no protocol, platform or backend imports. */
export type Resource<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly data: T; readonly source: 'live' | 'preview' }
  | { readonly status: 'unavailable'; readonly reason: string }
  | { readonly status: 'error'; readonly reason: string }
  | { readonly status: 'stale'; readonly data: T; readonly source: 'live' | 'preview'; readonly reason: string }
export interface CoreView {
  readonly lifecycle: string; readonly sequence: number; readonly activeRequests: number
  readonly stopped: boolean; readonly integrity: string; readonly faultCount: number
}
export interface MissionRow {
  readonly id: string; readonly status: string; readonly runs: number
  readonly verifiedRuns: number; readonly needsAttention: boolean
}
export interface MissionView {
  readonly rows: readonly MissionRow[]; readonly total: number; readonly hidden: number; readonly durable: boolean
}
export interface WorkerRow { readonly id: string; readonly state: string; readonly specialization: string | null }
export interface WorkforceView { readonly rows: readonly WorkerRow[]; readonly total: number; readonly working: number }
export interface ActivityRow { readonly id: string; readonly text: string; readonly at: number; readonly sequence: number; readonly tone: string }

/**
 * What Core's Attention domain actually reports.
 *
 * There is no percentage here, and that is the point. `focus` is Core's own closed
 * `FocusState` — `focused`, `available`, `away`, `unknown` — and every other field is
 * a count Core derived from already-authorized state. The concept art drew an "88%
 * focused" ring; nothing in Phases 0–18 measures that, so a live adapter must not
 * invent one. An `unknown` focus renders as unknown.
 */
export interface AttentionView {
  readonly focus: string
  readonly ingested: number
  readonly decisions: number
  readonly cued: number
  readonly spoke: number
  readonly interrupted: number
  readonly budgetExceeded: number
  readonly inboxCount: number
}

/**
 * The Home composite.
 *
 * Every optional field is optional for the same reason: there is no domain behind it
 * yet, or the domain deliberately withholds it, and a preview is not evidence that one
 * should exist. `people` and `world` have no projection at all; Mission titles live in
 * an encrypted store the bridge exposes no read for; a focus *percentage* has no
 * denominator anywhere in the codebase. A live adapter omits these rather than filling
 * them with something plausible, and the surface drops the panel instead of dressing
 * the absence up as a fact.
 */
export interface HomeView {
  readonly focus: { readonly title: string; readonly detail: string; readonly progress: number | null } | null
  readonly mission: string | null
  readonly goals?: readonly { readonly id: string; readonly text: string }[]
  readonly attention: { readonly focused: number; readonly caption: string; readonly categories: readonly string[]; readonly profiles: readonly { readonly id: string; readonly label: string; readonly presence: 'attentive' | 'planning' | 'creating' | 'searching'; readonly focused: number; readonly distribution: readonly number[] }[] }
  readonly people?: readonly { readonly id: string; readonly name: string; readonly avatar: number }[]
  readonly morePeople?: number
  readonly messages?: number
  readonly followUps?: number
  readonly meetingPrep?: number
  readonly world?: readonly { readonly id: string; readonly title: string; readonly detail: string; readonly icon: string }[]
}
export interface UiSnapshot {
  readonly home: Resource<HomeView>
  readonly core: Resource<CoreView>; readonly mission: Resource<MissionView>
  readonly workforce: Resource<WorkforceView>; readonly activity: Resource<readonly ActivityRow[]>
  readonly attention: Resource<AttentionView>
}
export interface UiAdapter {
  getSnapshot(): UiSnapshot
  subscribe(listener: () => void): () => void
}