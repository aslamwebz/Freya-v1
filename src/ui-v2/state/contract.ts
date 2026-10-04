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
 * What the Settings surface may say about the nano-gpt provider.
 *
 * The key itself is deliberately absent: `hasKey` is the whole of what a window is
 * told about the credential, and there is no field a raw key could occupy. `detail`
 * is a closed sentence — `connected`, `not configured` or `live-disabled` — so the
 * surface reports the real state in Core's own terms rather than inferring one.
 */
export interface ProviderView {
  readonly connected: boolean
  readonly baseUrl: string
  readonly model: string
  readonly liveEnabled: boolean
  readonly hasKey: boolean
  readonly detail: string
}

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
  readonly attention: {
    /**
     * A focus *percentage*, which only the design preview has. Core reports a closed
     * `FocusState`, never a denominator, so a live projection leaves this `null` rather
     * than printing a confident `0%` that nothing measured.
     */
    readonly focused: number | null
    readonly caption: string
    readonly categories: readonly string[]
    readonly profiles: readonly { readonly id: string; readonly label: string; readonly presence: 'attentive' | 'planning' | 'creating' | 'searching'; readonly focused: number; readonly distribution: readonly number[] }[]
  }
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
  readonly provider: Resource<ProviderView>
}
export interface UiAdapter {
  getSnapshot(): UiSnapshot
  subscribe(listener: () => void): () => void
}

/**
 * Which mode this window is actually in, read off the snapshot rather than assumed.
 *
 * A window is a design preview only when *every* resource is a preview fixture. The
 * moment any resource is a live projection — or is missing because a live Core has not
 * reported — the window is a live desktop window, and each workspace is responsible for
 * declaring its own state. The shell must never announce the whole window as
 * "projected from Freya Core" when part of it is still sample content: that is the one
 * claim a person cannot afford to misread.
 *
 * This is a provenance read, not a second brain. It carries no domain state and makes no
 * decision beyond the two-way mode every surface already branches on.
 */
export type UiMode = 'preview' | 'live'
export function uiMode(snapshot: UiSnapshot): UiMode {
  const preview = Object.values(snapshot).every((resource) => resource.status === 'ready' && resource.source === 'preview')
  return preview ? 'preview' : 'live'
}