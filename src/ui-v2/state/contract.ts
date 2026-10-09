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
  /**
   * Whether the Core process can currently serve commands. Distinct from the
   * aggregate `lifecycle`: a Core can be `degraded` and still operational, and
   * a Core that fell back to an ephemeral event store is operational even
   * though its history is not durable. Use this in the UI to decide whether
   * the workspace is usable.
   */
  readonly operational: boolean
  /** Whether the Core's history is being persisted to a durable store. */
  readonly persistenceDurable: boolean
  /** Short label for the persistence mode (durable / ephemeral-fallback). */
  readonly persistenceMode: 'durable' | 'ephemeral-fallback'
  /** Human-readable reason the persistence is in this mode, when it is not durable. */
  readonly persistenceReason: string | null
  /** Where the runtime diagnostics log is being written, when known. */
  readonly diagnosticsPath: string | null
  readonly diagnosticsWriteFailures: number
  readonly faults: readonly string[]
  /**
   * The Governor's posture. `unknown` is not `deny_all`: a Core that has not
   * finished booting has no answer, and reporting "denying everything" there
   * would claim a stop latch that may well not be set.
   */
  readonly governorStatus: 'ready' | 'deny_all' | 'unknown'
  /** Cognition grants currently held. A count, never a grant object. */
  readonly grantsActive: number
  /** Reported provider usage. Optional: a preview or an older projection may omit it. */
  readonly sessionUsage?: { readonly calls: number; readonly inputTokens: number | null; readonly outputTokens: number | null; readonly unknownUsageCalls: number }
  readonly durableUsage?: { readonly calls: number; readonly inputTokens: number | null; readonly outputTokens: number | null; readonly unknownUsageCalls: number }
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
  /**
   * The credential situation, kept as four distinct states.
   *
   * `detail` is a closed sentence for display, but it is not enough on its own:
   * "not configured" covers a person who never set a key, a machine that cannot
   * protect one, and a key that is on disk but will not unwrap — three situations
   * whose remedies are entirely different. A surface that has to show the right
   * instruction needs the state, not just the sentence.
   */
  readonly credentialState: 'none' | 'stored' | 'storage-unavailable' | 'unreadable'
  /** Why the credential is in that state, in the host's words. Null when stored. */
  readonly credentialReason: string | null
  /**
   * Whether the configured base URL would actually be usable.
   *
   * False when the stored host is not an approved provider origin, which is a
   * misconfiguration rather than an absence: a key exists, and it would be sent
   * somewhere it must not go. Reported separately so a surface can say "this
   * endpoint is not approved" instead of implying the provider is simply unset.
   */
  readonly endpointApproved: boolean
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
/**
 * One row in the Mind's active-thread list.
 *
 * Every field is an id, a closed status word taken verbatim from the
 * projection that owns the thread, or a sentence Core itself wrote. `detail` is
 * null rather than empty when the owning domain has nothing to say — and in
 * particular it is never a label this vocabulary invented.
 */
export interface MindThreadView {
  readonly id: string
  readonly kind: 'run' | 'mission' | 'worker' | 'approval'
  /** The owning domain's own status word. Printed, never rewritten. */
  readonly status: string
  readonly detail: string | null
  /** Whether this thread occupies its engine in *this* process. */
  readonly live: boolean
}

/** What Core reports about the provider that would answer. Never a credential. */
export interface MindProviderView {
  readonly id: string
  readonly kind: string
  readonly status: string
  readonly model: string | null
  readonly liveEnabled: boolean
  /** Why it is in this state, in the provider's words. */
  readonly detail: string
}

/**
 * The Mind overview: Core's own posture, plus the one mode word.
 *
 * The mode is derived here, in one place, from facts Core already reports — it
 * is not a field Core invents and it is not a temperature reading. `stopped`
 * outranks `unavailable`, which outranks everything else, because a person
 * reading a dashboard must see the panic button's state before anything else.
 */
export interface MindOverviewView {
  readonly lifecycle: string
  readonly operational: boolean
  /** STOP ALL is latched. Authoritative, and shown above every other row. */
  readonly stopped: boolean
  readonly governorStatus: string
  readonly grantsActive: number
  /** Provider requests executing right now, straight from the gateway registry. */
  readonly activeProviderCalls: number
  readonly journalIntegrity: string
  readonly persistenceMode: 'durable' | 'ephemeral-fallback'
  readonly persistenceReason: string | null
  readonly faults: readonly string[]
  readonly sequence: number
  readonly mode: 'stopped' | 'unavailable' | 'uncertain' | 'working' | 'idle'
  readonly modeDetail: string
  readonly providers: readonly MindProviderView[]
  readonly sessionCalls: number
  /** A lower bound whenever `unknownUsageCalls` is above zero. */
  readonly sessionInputTokens: number | null
  readonly sessionOutputTokens: number | null
  readonly sessionUnknownUsageCalls: number
}

export interface MindAttentionCounts {
  readonly ingested: number
  readonly decisions: number
  readonly doNothing: number
  readonly remembered: number
  readonly cued: number
  readonly spoke: number
  readonly interrupted: number
  readonly budgetExceeded: number
}

/**
 * Attention as Core reports it.
 *
 * There is no percentage here and that is the point. `focus` is Core's own
 * closed `FocusState` — `focused`, `available`, `away`, `unknown` — and every
 * other field is a count Core derived from already-authorized state. `health`
 * is read first everywhere: `'unavailable'` means nobody is watching, which is
 * not the same fact as "nothing needs attention".
 */
export interface MindAttentionView {
  readonly health: 'ready' | 'unavailable'
  readonly reason: string | null
  readonly focus: string
  readonly counts: MindAttentionCounts | null
  readonly inboxCount: number
  readonly lastDecision: {
    readonly source: string
    readonly kind: string
    readonly outcome: string
    readonly importance: string
    readonly urgency: string
    /** A closed code, never a sentence. */
    readonly reason: string
    readonly decidedAt: string
  } | null
}

/**
 * The self model: who Freya is, in Core's own words.
 *
 * `name`, `role`, `purpose`, `claims`, `capabilities` and `limitations` are
 * Core-authored fixed statements — the Brain's identity root and the seeded
 * self-definition, mirrored through the conscious context. They are not a
 * record of anything the owner said and not a temperament reading: there is no
 * trait percentage anywhere in this shape, because nothing in Phases 0–18
 * measures one and a surface that printed one would be printing fiction.
 */
export interface MindSelfView {
  readonly name: string | null
  readonly role: string | null
  readonly purpose: string | null
  readonly claimCount: number
  readonly complete: boolean
  readonly claims: readonly { readonly claimId: string; readonly statement: string }[]
  readonly capabilities: readonly {
    readonly capability: string
    readonly state: string
    readonly cannot: readonly string[]
  }[]
  readonly limitations: readonly { readonly limitationId: string; readonly statement: string }[]
  /** Whether a restart keeps what Freya has learned. */
  readonly durable: boolean
  readonly reason: string | null
  /**
   * The world model, as counts and states Core reports.
   *
   * Counts, never names: the Brain projects entity counts and no names, and
   * the World summary projects the same discipline. `withheld` is the honest
   * remainder — evidence too sensitive to project, counted here and nowhere
   * else — and a surface that showed it as zero would be claiming Freya holds
   * nothing private.
   */
  readonly world: {
    readonly health: 'ready' | 'unavailable'
    readonly reason: string | null
    readonly entities: number
    readonly edges: number
    readonly evidenceRecords: number
    readonly withdrawn: number
    readonly conflicts: number
    readonly beliefs: number
    readonly uncertainties: number
    readonly withheld: number
    readonly durable: boolean
  } | null
  /**
   * The seven-compartment world self model, when Core projects one.
   *
   * Read fresh rather than streamed — see `selfClient`. `separation` is the
   * block of rules Core states about itself, carried verbatim so the surface
   * can print them rather than implying them.
   */
  readonly worldSelf: {
    readonly source: string
    readonly assignedCapabilities: readonly { readonly capability: string; readonly held: boolean }[]
    readonly knownSkills: readonly { readonly name: string; readonly status: string; readonly verification: string }[]
    readonly models: readonly { readonly providerId: string; readonly kind: string; readonly live: boolean }[]
    readonly workerClaims: readonly { readonly workerId: string; readonly claimKind: string; readonly decision: string }[]
    readonly separation: Readonly<Record<string, string | boolean>>
    readonly readAt: string | null
  } | null
}

/**
 * One Mission, as goals rather than as threads.
 *
 * No title and no intent: those live in the encrypted Mission store and the
 * bridge exposes no read for them. What crosses is status, counts, what Core
 * decided to do next and why, and which blockers are in the way — which is
 * enough to answer "what is Freya working toward" without becoming a copy of
 * what the owner asked for.
 */
export interface MindMissionView {
  readonly id: string
  readonly status: string
  readonly priority: string
  readonly needsAttention: boolean
  readonly awaitingOwner: boolean
  readonly totalRuns: number
  readonly verifiedRuns: number
  /** The last continuation decision, so a board can say why nothing is moving. */
  readonly nextDecision: string | null
  readonly nextReason: string | null
  readonly blockers: readonly string[]
}

/**
 * Owner context: the bounded facts the Context and Personality projections
 * are allowed to expose.
 *
 * Nothing here is a relationship record's *text*, a preference's wording, a
 * habit, an inside joke or a context item's contents. What crosses is health,
 * closed labels, counts and durability — which is exactly what those two
 * domains permit, and the surface says "not projected" for everything else
 * rather than describing a person Core has not described.
 */
export interface MindOwnerView {
  readonly personalityHealth: 'ready' | 'unavailable'
  readonly personalityReason: string | null
  readonly continuity: string | null
  readonly formality: string | null
  readonly temperament: readonly { readonly dimension: string; readonly level: string }[]
  readonly relationshipItems: number
  readonly admittedItems: number
  readonly cuesAdmitted: number
  readonly relationshipDurable: boolean | null
  readonly contextHealth: 'ready' | 'unavailable'
  readonly contextReason: string | null
  readonly contextItems: number
  readonly contextCurrent: number
  /** The scopes Core says the live items sit in, in Core's own words. */
  readonly contextScopes: readonly string[]
  readonly contextUnresolvedReferences: number
  readonly contextDurable: boolean | null
}

/** One thing Core could not settle. A closed code, never a worry sentence. */
export interface MindUncertaintyView {
  readonly code: string
  readonly subjectKind: string
  readonly subjectId: string | null
  readonly since: string | null
}

/** Where an offered action came from. There is no `'mind'` scope: Core invents no action here. */
export interface MindNextActionView {
  readonly scope: string
  readonly subjectId: string
  readonly action: string
}

/** One recent durable change. A closed kind, a sequence, an instant and a tone. */
export interface MindRecentChangeView {
  readonly id: string
  readonly kind: string
  readonly sequence: number
  readonly at: number
  readonly tone: string
}

/** Which subsystem said what, and how far it can be trusted right now. */
export interface MindProvenanceSourceView {
  readonly domain: string
  readonly basis: string
  readonly freshness: string
  readonly durable: boolean | null
  readonly note: string | null
}

export interface MindProvenanceView {
  readonly basis: string
  readonly freshness: string
  readonly asOf: string
  readonly sources: readonly MindProvenanceSourceView[]
}

/** What is blocked, waiting, or waiting on a person. Ids and states only. */
export interface MindWaitingView {
  readonly pendingApprovals: number
  readonly waitingRuns: readonly { readonly runId: string; readonly status: string; readonly waitingSince: string | null }[]
  readonly blockedAgents: readonly { readonly workerId: string; readonly status: string }[]
  readonly unfulfilledPresenceRequests: number
}

/**
 * Everything the Mind workspace shows, as one bounded projection.
 *
 * Built by the live adapter from the mirrors Core already publishes, and by
 * the preview adapter from static fixtures that are labelled as preview
 * everywhere they appear. A live window never falls back between the two: the
 * preview is what a browser gets, and the live adapter reports `unavailable`
 * with a reason when Core is not reachable.
 */
export interface MindView {
  readonly overview: MindOverviewView
  readonly threads: readonly MindThreadView[]
  readonly attention: MindAttentionView
  readonly self: MindSelfView
  readonly missions: readonly MindMissionView[]
  readonly missionsTotal: number
  readonly missionsHidden: number
  readonly owner: MindOwnerView
  readonly uncertainties: readonly MindUncertaintyView[]
  readonly uncertaintiesOmitted: number
  readonly nextActions: readonly MindNextActionView[]
  readonly recentChanges: readonly MindRecentChangeView[]
  readonly waiting: MindWaitingView
  readonly provenance: MindProvenanceView | null
  /** Core's conscious context health, which bounds everything derived from it. */
  readonly consciousHealth: 'ready' | 'degraded' | 'unavailable'
  readonly consciousReason: string | null
  /** Sections Core said are not in this build. Never rendered as empty lists. */
  readonly absentSections: readonly string[]
}

export interface UiSnapshot {
  readonly home: Resource<HomeView>
  readonly core: Resource<CoreView>; readonly mission: Resource<MissionView>
  readonly workforce: Resource<WorkforceView>; readonly activity: Resource<readonly ActivityRow[]>
  readonly attention: Resource<AttentionView>
  readonly mind: Resource<MindView>
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
