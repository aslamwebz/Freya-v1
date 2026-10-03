/**
 * THE CONSCIOUS CONTEXT PROTOCOL — one coherent account of what Freya knows.
 *
 * This file is a **view**, not a channel. It carries the read-only shapes a
 * renderer is typed against, the frozen snapshot for a Core that has no
 * conscious context, and the schema version. There is nothing here a window
 * could call to change any of it.
 *
 * ## Why this exists
 *
 * Eleven subsystems each answer one question about Freya's situation, and every
 * surface that wanted the whole answer was assembling it from whichever mirrors
 * it happened to be holding — which is how two parts of one product end up
 * disagreeing about the same moment. This is the one object that says what she
 * currently understands about herself and her situation, derived from the
 * authoritative state those eleven already hold.
 *
 * ## DEPENDENCY NOTE — Life, Self and World are not wired yet
 *
 * `PLAN.md` §6 requires this projection to consume authoritative projections from
 * **Phase 21 (Life)** and **Phase 22 (Self/World)** as well as the subsystems
 * listed below. On this baseline those two phases have not landed: there is no
 * `core/life/`, no `core/self/` and no `core/world/` module, so there is no
 * authoritative Life, Self or World projection to read.
 *
 * What this lane does about that, and what it deliberately does not do:
 *
 * - `life` is a **stated absence** on this baseline — `state: 'absent'`, a named
 *   `note`, a `provenance` row, and a health line that says the snapshot is
 *   incomplete *because* `life` is missing. It is never zeroed and never
 *   simulated, because a fabricated Life would be the exact failure this phase
 *   exists to prevent.
 * - `self`, `world` and `continuity` are read through narrow Core-private
 *   **input ports** (`core/consciousness/ports.ts`), not against a domain type.
 *   Today the Brain is the authority behind those three ports and an adapter
 *   says so. When Phase 22 lands it writes its own adapter and the port changes
 *   hands; nothing in this file, and no derivation rule, has to move.
 * - No Phase 21/22 domain shape is invented here. The ports are a *consumer-side*
 *   contract — the smallest set of readings this projection can use — and
 *   `docs/PHASE-20.md` records the exact seam each phase must satisfy.
 *
 * So: this is an integration-ready preparation, not a finished Phase 20. It is
 * truthful about what it cannot see, and it must be rebased onto merged Phase 21
 * and Phase 22 before anyone calls it final.
 *
 * ## What crosses, and what pointedly does not
 *
 * Crosses: ids, closed codes, measurements (a length, a count), instants, Core's
 * own fixed self-statements, and explicit provenance — for every source, whether
 * the value is authoritative or derived and whether it is fresh, stale, absent or
 * unknown.
 *
 * Does not cross: memory content *and* memory subject, Mission title and intent,
 * Context content and label and uri, relationship text and tags, Attention event
 * text, Workforce message bodies, Work approval justifications and proposals, run
 * and task labels, any Relay connector payload, any credential, any raw prompt,
 * any model request or response, and `CoreActivityEvent.text`.
 *
 * The last of those is a deliberate loss rather than an oversight. The activity
 * sentence is Core-authored and already reaches every renderer today, so keeping
 * it would leak nothing new — but a snapshot whose free text is limited to
 * Freya's own immutable account of herself is an invariant that can be checked
 * exhaustively, which is worth more than one more sentence per event.
 *
 * ## Inferred is always marked as inferred
 *
 * `basis` is on every source and on every derived section. A consumer never has
 * to guess whether it was told a fact or handed an inference, because the type
 * says which before it says what.
 *
 * ## The two absences, kept apart
 *
 * `'unavailable'` with {@link NO_CONSCIOUS_CONTEXT_REASON} means *this build has
 * no conscious context and none is simulated*. A section with `state: 'absent'`
 * means *that subsystem is not here* — never "there is nothing", which is a
 * different and much more dangerous thing to render.
 */

import type { ActivityKind } from './activity'
import type {
  AttentionCueCode,
  AttentionEventKind,
  AttentionOutcome,
  AttentionReason,
  AttentionSource,
  FocusState,
  ImportanceLevel,
  SeverityHint,
  UrgencyLevel,
} from '../attention/types'
import type { PersonalityCounts } from './personality'
import type {
  CannotWeaken,
  ContinuityState,
  CueKind,
  FormalityPreference,
  TemperamentDimension,
  TemperamentLevel,
} from '../personality/types'
import type { MissionAction } from '../missions/types'
import type {
  AssignmentStatus,
  WorkforceAction,
  WorkforceLimitName,
  WorkerSpecialisation,
  WorkerStatus,
} from '../workforce/types'
import type { Capability, PrincipalId } from './core-protocol'
import type { ApprovalStatus, RunStatus, TaskStatus, WorkRisk } from '../work/types'
import type {
  Confidence,
  MemoryKind,
  MemoryStatus,
  SelfCapabilityState,
  SourceTrust,
} from '../brain/types'
import type { SkillCountsView, SkillThresholdView } from './skills'
import type {
  SkillKind,
  SkillStatus,
  SkillTrustClass,
  SkillVerificationState,
} from '../skills/types'

/* ------------------------------------------------------------ provenance */

/**
 * Where a value came from.
 *
 * - `'authoritative'` — lifted from state another subsystem owns and can be held
 *   to. Work's run statuses are authoritative; they are not Freya's opinion.
 * - `'derived'` — computed *here*, from authoritative state, by a rule that
 *   lives in this repository and is testable.
 *
 * Everything this phase computes is `'derived'`. Nothing is invented: a derived
 * value is always a function of something authoritative that is named alongside
 * it in {@link ConsciousProvenanceView.sources}.
 */
export type ConsciousBasis = 'authoritative' | 'derived'

/**
 * How much to trust a source right now.
 *
 * - `'fresh'` — healthy, and what it reports is current.
 * - `'stale'` — present, but it lost the volatile half of its detail. Work and
 *   Workforce land here after a restart; Brain, Personality, Context and Missions
 *   land here when their store is not durable. A surface can then say "this is
 *   from before the last restart" instead of rendering nothing as though nothing
 *   had ever been there.
 * - `'absent'` — not in this build. Never an empty list.
 * - `'unknown'` — present but unreadable. A degraded Brain is `'unknown'`, not
 *   `'absent'`: "Freya cannot remember" and "we cannot ask her" are different
 *   facts to a person reading them.
 */
export type ConsciousFreshness = 'fresh' | 'stale' | 'absent' | 'unknown'

/** Whether a section could be built at all. */
export type ConsciousSectionState = 'available' | 'absent' | 'degraded'

/** One contributing subsystem, and how far it can be trusted. */
export interface ConsciousSourceAttribution {
  /** The subsystem, as Core names it. Matches the `domain` it is listed under. */
  readonly domain: string
  readonly basis: ConsciousBasis
  readonly freshness: ConsciousFreshness
  /** Highest sequence folded into that source, or `null` when it reports none. */
  readonly sequence: number | null
  /** Whether the source's volatile detail survives in this process. */
  readonly detailAvailable: boolean | null
  /** Whether a restart will keep what the source has learned. */
  readonly durable: boolean | null
  /** Why it is not fresh, in one sentence. Null when it is. */
  readonly note: string | null
}

/**
 * The provenance of the whole snapshot.
 *
 * `basis` and `freshness` here are the *weakest* value across the sources, not a
 * summary: if one contributor is unknown then the snapshot is only as
 * trustworthy as that one, and saying so once at the top is what stops a
 * consumer from treating a partially-known picture as a complete one.
 */
export interface ConsciousProvenanceView {
  readonly basis: ConsciousBasis
  readonly freshness: ConsciousFreshness
  /** The newest durable sequence any source folded in. Zero when nothing has. */
  readonly durableSequence: number
  /** The instant the snapshot was derived for, passed in by the caller. */
  readonly asOf: string
  readonly sources: readonly ConsciousSourceAttribution[]
}

/** The three fields every section carries, so absence is always visible. */
export interface ConsciousSectionMeta {
  readonly state: ConsciousSectionState
  /**
   * Why this section is in this state, when the state is not the ordinary one.
   *
   * Null when the section is simply present and healthy. It is also used on a
   * section that *is* available but is deliberately empty — `nextActions` under
   * STOP ALL is the case that matters, because an empty list with no
   * explanation reads as "there is nothing to do" rather than "she is not
   * permitted to do anything", and those are very different things to be told.
   */
  readonly note: string | null
}

/* ------------------------------------------------------------------ self */

/**
 * What Freya says she is.
 *
 * These sentences are Core's own: `FREYA_IDENTITY` is a frozen constant and
 * `buildSelfDefinition()` is seeded once into an immutable Brain record. They
 * are not a record of anything the owner said, and `brain()` already projects
 * them verbatim — so this is the one section with free text, and the text is
 * Freya's.
 */
export interface ConsciousSelfView extends ConsciousSectionMeta {
  readonly name: string | null
  readonly role: string | null
  readonly purpose: string | null
  /** How many root claims the Brain holds. A count, not the claims. */
  readonly claimCount: number
  readonly capabilities: readonly {
    readonly capability: string
    readonly state: SelfCapabilityState
    /** What it cannot do. Fixed strings from the seeded definition. */
    readonly cannot: readonly string[]
  }[]
  readonly limitations: readonly { readonly limitationId: string; readonly statement: string }[]
  /** False when Core has not finished building its own account of itself. */
  readonly complete: boolean
}

/* --------------------------------------------------------------- posture */

/** How Freya currently holds herself with this person. */
export interface ConsciousPostureView extends ConsciousSectionMeta {
  /** `'new'`, `'renewed'` or `'sustained'`. Null when uninterpretable. */
  readonly continuity: ContinuityState | null
  readonly formality: FormalityPreference | null
  readonly greetingEligible: boolean
  /**
   * The standing style tendency.
   *
   * The two `true` invariants travel with it deliberately: "style cannot weaken
   * safety" and "identity supersedes temperament" are the claims that stop a
   * surface tuning Freya's manner into something unsafe, so they are an
   * inspectable fact about what arrived rather than a sentence in a document
   * nobody reads at the moment it matters.
   */
  readonly temperament: {
    readonly dimensions: readonly {
      readonly dimension: TemperamentDimension
      readonly level: TemperamentLevel
    }[]
    readonly constitutionFirst: true
    readonly identitySupersedesTemperament: true
    readonly cannotWeaken: readonly CannotWeaken[]
  } | null
  /** The one cue Presence may draw, as a kind. Never the words. */
  readonly presenceCueKind: CueKind | null
  readonly counts: PersonalityCounts | null
  /** Whether a restart keeps the relationship record. */
  readonly durable: boolean | null
}

/* ----------------------------------------------------------------- focus */

/**
 * What she is on.
 *
 * Identifiers, never titles. A surface that wants the words already holds the
 * Work, Mission or Workforce projection this section was derived from, and
 * reading them from there means the authority to show them stays where it
 * already is instead of being copied into a twelfth mirror.
 */
export interface ConsciousFocusView extends ConsciousSectionMeta {
  /** The focus reading Attention derived. `'unknown'` is a real answer. */
  readonly attentionFocus: FocusState
  /** The one run a surface would call *the* run, or null when none is live. */
  readonly primaryRunId: string | null
  /** The one Mission that is active, or null. */
  readonly primaryMissionId: string | null
  readonly liveRuns: number
  readonly runningRuns: number
  readonly waitingRuns: number
  readonly activeMissions: number
  readonly workingAgents: number
  /** The scope "here" currently means. Ids only; the items stay in Context. */
  readonly scope: { readonly scopeKind: string; readonly scopeId: string } | null
}

/* ------------------------------------------------------------- attention */

/** The last decision Attention made, as metadata. */
export interface ConsciousAttentionDecisionView {
  readonly decisionId: string
  readonly source: AttentionSource
  readonly kind: AttentionEventKind
  readonly outcome: AttentionOutcome
  readonly importance: ImportanceLevel
  readonly urgency: UrgencyLevel
  /** A closed code. Never a sentence. */
  readonly reason: AttentionReason
  readonly cueCode: AttentionCueCode | null
  readonly decidedAt: string
}

/** One retained event, as metadata. The text stays in Core. */
export interface ConsciousInboxItemView {
  readonly eventId: string
  readonly source: AttentionSource
  readonly kind: AttentionEventKind
  readonly goalRef: string | null
  readonly severityHint: SeverityHint
  /** A measurement, like a transcript turn's `contentLength`. */
  readonly textLength: number
  readonly observedAt: string
  readonly dueAt: string | null
  readonly outcome: AttentionOutcome | null
}

/** What Attention is holding and what it decided about it. */
export interface ConsciousAttentionView extends ConsciousSectionMeta {
  readonly focus: FocusState | null
  readonly counts: {
    readonly ingested: number
    readonly decisions: number
    readonly doNothing: number
    readonly remembered: number
    readonly cued: number
    readonly spoke: number
    readonly interrupted: number
    readonly budgetExceeded: number
  } | null
  readonly lastDecision: ConsciousAttentionDecisionView | null
  /** One bounded gesture. Drawing it is drawing *that attention was drawn*. */
  readonly directive: {
    readonly kind: AttentionEventKind
    readonly outcome: Extract<AttentionOutcome, 'subtle-cue' | 'speak' | 'interrupt'>
    readonly cueCode: AttentionCueCode | null
  } | null
  readonly inbox: readonly ConsciousInboxItemView[]
  /** Schedules whose `dueAt` has passed. A derivation, not a firing. */
  readonly schedulesDue: number
  readonly schedulesPending: number
}

/* --------------------------------------------------------------- waiting */

/**
 * One approval, as far as it may travel.
 *
 * `capability`, `requiredCapability` and `risk` are what the Guard actually
 * judges, and they are enough to know what is being asked for and how dangerous
 * it is. `justification` and `proposal` — the two fields that would answer the
 * question properly — are not here, because this projection is not the place an
 * approval gets decided.
 */
export interface ConsciousApprovalView {
  readonly approvalId: string
  readonly runId: string
  readonly capability: Capability | string
  readonly requiredCapability: Capability | string
  readonly risk: WorkRisk
  readonly status: ApprovalStatus
  readonly requestedAt: string
  readonly requestedAgoMs: number | null
}

/** What is blocked, waiting, or waiting on a person. Ids and states only. */
export interface ConsciousWaitingView extends ConsciousSectionMeta {
  readonly approvals: readonly ConsciousApprovalView[]
  readonly pendingApprovals: number
  readonly waitingRuns: readonly { readonly runId: string; readonly status: RunStatus; readonly waitingSince: string | null }[]
  readonly blockedTasks: readonly { readonly taskId: string; readonly status: TaskStatus; readonly updatedAt: string }[]
  readonly blockedAgents: readonly { readonly workerId: string; readonly status: WorkerStatus }[]
  /** Presence the owner asked for and no agent has taken. */
  readonly unfulfilledPresenceRequests: readonly { readonly workerId: string; readonly requestedAt: string }[]
}

/* ---------------------------------------------------------------- agents */

/** One delegated assignment. Metadata only; a message body never appears. */
export interface ConsciousAssignmentView {
  readonly assignmentId: string
  readonly status: AssignmentStatus
  readonly createdAt: string
  readonly deadlineAt: string
  readonly missionId: string | null
  readonly capabilities: readonly Capability[]
  readonly expired: boolean
}

/** One worker, as far as it may travel. */
export interface ConsciousAgentView {
  readonly workerId: string
  /** Core-normalised, bounded, and already projected by `workforce()`. */
  readonly name: string
  readonly specialisation: WorkerSpecialisation
  readonly status: WorkerStatus
  readonly teams: readonly string[]
  readonly capabilities: readonly Capability[]
  readonly openAssignments: number
  readonly refusedClaims: number
  readonly limitsHit: readonly WorkforceLimitName[]
  readonly remaining: { readonly assignments: number; readonly cognitionCalls: number; readonly cognitionTokens: number }
  readonly assignments: readonly ConsciousAssignmentView[]
}

/** The current agents and what they are carrying. */
export interface ConsciousAgentsView extends ConsciousSectionMeta {
  readonly workers: readonly ConsciousAgentView[]
  readonly counts: {
    readonly workers: number
    readonly idle: number
    readonly working: number
    readonly blocked: number
    readonly stopped: number
    readonly retired: number
    readonly teams: number
    readonly openAssignments: number
    readonly messagesSent: number
    readonly refusedClaims: number
  } | null
  /** False after a restart: the journal kept message metadata and no bodies. */
  readonly detailAvailable: boolean | null
  readonly assignmentsRetained: number
  readonly assignmentsTotal: number
  readonly assignmentsHidden: number
}

/* -------------------------------------------------------------- practice */

/**
 * One procedure, as far as it may travel.
 *
 * A slug, a lifecycle status, a version and the evidence counts behind it. The
 * owner's own description of the procedure — `summary`, and every entry of the
 * contract — is reachable only through the owner asking for that one skill by
 * id, and `summaryLength` is here in its place.
 */
export interface ConsciousSkillView {
  readonly skillId: string
  /** Core's own slug, normalised at admission. Never the owner's wording. */
  readonly name: string
  readonly kind: SkillKind
  readonly status: SkillStatus
  readonly version: number
  readonly verification: SkillVerificationState
  readonly trustClass: SkillTrustClass
  readonly establishedCount: number
  readonly contradictedCount: number
  readonly inconclusiveCount: number
  readonly executionsPlanned: number
  readonly stepCount: number
  readonly requiredCapabilityCount: number
  readonly summaryLength: number
}

/**
 * What Freya has learned to do.
 *
 * Phase 17's Skills, read-only. It is here because a projection of *what Freya
 * currently understands about herself* that omitted her own procedures would
 * answer the question with a gap in the middle of it — and because an
 * unverified procedure and a promoted one are very different things to have
 * available, so the verification state travels with every entry.
 */
export interface ConsciousPracticeView extends ConsciousSectionMeta {
  readonly skills: readonly ConsciousSkillView[]
  readonly counts: SkillCountsView | null
  /** The thresholds Core will not bend, echoed so a surface can show them. */
  readonly thresholds: SkillThresholdView | null
  /** How many bodies survive a restart. */
  readonly durable: boolean | null
  readonly listed: number
  readonly omitted: number
}

/* ----------------------------------------------------------------- world */

/**
 * The world as Core holds it.
 *
 * Counts, not names. Core's Brain projects entity *counts* and no names, so this
 * section does not widen that, and a surface that needs a name goes and recalls
 * it deliberately.
 */
export interface ConsciousWorldView extends ConsciousSectionMeta {
  readonly entities: number | null
  readonly relations: number | null
  readonly observations: number | null
  readonly memories: number | null
  readonly admitted: number | null
  readonly conflicted: number | null
  readonly rejected: number | null
  readonly withdrawn: number | null
  readonly experiences: number | null
  /** Contradictions currently on record, disclosed because they are real. */
  readonly conflicts: readonly {
    readonly memoryId: string
    readonly conflictsWith: readonly string[]
    readonly detail: string
  }[]
  readonly durable: boolean | null
}

/* ------------------------------------------------------------------ life */

/**
 * One entry of Freya's life history, as metadata.
 *
 * There is **no `text` field and no `summary` field, and that is the whole
 * design.** A life history is the most owner-shaped thing Freya will ever hold:
 * it is a record of what happened to her. Everything here is an id, a code, an
 * instant or a measurement, which is the same line this projection draws
 * everywhere else and the same line Phase 21 must draw on its own standing
 * projection before anything is adapted in here.
 *
 * `kind` is carried as a plain `string` on purpose. Phase 21 owns that
 * vocabulary, it does not exist yet, and declaring a closed set for it here
 * would be inventing a domain shape Phase 21 would then have to conform to
 * rather than define. Phase 20 does not validate, widen or reinterpret it; it
 * sorts by it and shows it.
 */
export interface ConsciousLifeEntryView {
  readonly entryId: string
  /** Phase 21's own closed code, carried verbatim. Not interpreted here. */
  readonly kind: string
  /** The instant the entry is about, or the instant it was recorded. */
  readonly at: string
  /** A measurement of the narrative, never the narrative. */
  readonly textLength: number
  /** How sure Life is about this entry, as a number it already publishes. */
  readonly confidence: number | null
}

/**
 * What happened in Freya's life, bounded.
 *
 * `state: 'absent'` on this baseline, with `note` naming Phase 21 as the reason.
 * It is a stated absence rather than an empty list because "nothing has happened
 * in Freya's life" and "no one has built a Life subsystem yet" are entirely
 * different claims, and only the second of them is true here.
 *
 * The section exists in the shape Phase 21 will fill rather than being added
 * later, so that the integration is a matter of supplying an adapter rather than
 * of reshaping a snapshot a renderer has already learned to read.
 */
export interface ConsciousLifeView extends ConsciousSectionMeta {
  readonly entries: number | null
  readonly admitted: number | null
  readonly recalled: number | null
  readonly durable: boolean | null
  readonly recent: readonly ConsciousLifeEntryView[]
  readonly listed: number
  readonly omitted: number
}

/* ------------------------------------------------------------ continuity */

/**
 * One recently admitted memory, as metadata.
 *
 * `subjectLength` is a measurement, exactly like `textLength` and
 * `contentLength` elsewhere: enough to see that something substantial was
 * admitted about a subject of a certain size, and not one character of either.
 * The content and the subject are reachable only through an explicit recall by
 * the owner.
 */
export interface ConsciousContinuityItemView {
  readonly memoryId: string
  readonly kind: MemoryKind
  readonly source: SourceTrust
  readonly confidence: Confidence
  readonly status: MemoryStatus
  readonly subjectLength: number
  readonly admittedAt: string
}

/** Recent continuity, bounded. Not a narrative and not autobiographical. */
export interface ConsciousContinuityView extends ConsciousSectionMeta {
  readonly items: readonly ConsciousContinuityItemView[]
  readonly listed: number
  readonly omitted: number
  readonly durable: boolean | null
}

/* --------------------------------------------------------- recent changes */

/**
 * One recent durable event.
 *
 * A closed `kind`, the durable sequence it can be traced by, the instant and a
 * tone. The event's sentence is deliberately omitted — see the file header.
 */
export interface ConsciousChangeView {
  readonly id: string
  readonly kind: ActivityKind
  readonly sequence: number
  readonly at: number
  readonly tone: 'neutral' | 'good' | 'busy' | 'warn' | 'bad'
}

/** What changed, most recent first. */
export interface ConsciousRecentChangesView extends ConsciousSectionMeta {
  readonly items: readonly ConsciousChangeView[]
  readonly listed: number
  readonly omitted: number
}

/* ------------------------------------------------------------ uncertainty */

/**
 * The closed set of ways this snapshot can be unsure.
 *
 * A code and a subject, never a sentence about the owner's situation. A code is
 * countable, comparable and assertable on; a paragraph about what Freya is
 * worried about would be an inference wearing the same clothes as a fact, which
 * is the one thing this section must never be.
 */
export const CONSCIOUS_UNCERTAINTY_CODES = [
  /** Two memories or relations contradict each other. */
  'memory.conflict',
  /** A Mission could not establish its success criteria. */
  'mission.verification-unestablished',
  /** A Mission's verification did not answer in time. */
  'mission.verification-timeout',
  /** A Mission needs a person, and is sitting there. */
  'mission.needs-attention',
  /** Work hit one of its ceilings. */
  'work.limit-hit',
  /** A worker hit one of its ceilings. */
  'agent.limit-hit',
  /** An agent asked for something it may not have and was refused. */
  'agent.refused-claim',
  /** A procedure's evidence currently contradicts it. */
  'practice.contradicted',
  /** A procedure is proposed but not decided. */
  'practice.proposal-open',
  /** An attempt to admit a procedure was refused. */
  'practice.admission-refused',
  /** A promotion was refused at the moment it was asked for. */
  'practice.promotion-refused',
  /** A provider call ended and nobody will ever know what it cost. */
  'cognition.usage-unknown',
  /** A provider call was started and never settled. */
  'cognition.request-pending',
  /** The Governor is refusing everything, so nothing derived is current work. */
  'cognition.governor-closed',
  /** The journal was found damaged, so the folded state may be incomplete. */
  'journal.integrity',
  /** Core recorded a fault. */
  'core.fault',
  /** An attention budget ran out, so something went deliberately uncued. */
  'attention.budget-exceeded',
  /** Someone asked an agent to be present and it did not happen. */
  'presence.unfulfilled',
] as const

export type ConsciousUncertaintyCode = (typeof CONSCIOUS_UNCERTAINTY_CODES)[number]

/** One thing this snapshot does not know, named. */
export interface ConsciousUncertaintyItemView {
  readonly code: ConsciousUncertaintyCode
  /** What the uncertainty is about: `'memory'`, `'mission'`, `'worker'`, … */
  readonly subjectKind: string
  readonly subjectId: string | null
  readonly since: string | null
}

/** Everything Core could not settle. Bounded, and ordered for determinism. */
export interface ConsciousUncertaintiesView extends ConsciousSectionMeta {
  readonly items: readonly ConsciousUncertaintyItemView[]
  readonly listed: number
  readonly omitted: number
}

/* ----------------------------------------------------------- next actions */

/**
 * Where an offered action came from.
 *
 * There is no `'consciousness'` scope, because this phase invents no action. It
 * only collects the ones Mission, Workforce and Work already advertise on their
 * own projections, so there is no verb here that Core does not already have.
 */
export type ConsciousActionScope = 'mission' | 'agent' | 'work'

export interface ConsciousNextActionView {
  readonly scope: ConsciousActionScope
  readonly subjectId: string
  /** A closed action name, lifted verbatim from a projection. */
  readonly action: MissionAction | WorkforceAction | string
}

/**
 * What Freya intends to do next, where that is already derivable.
 *
 * Empty under STOP ALL. These are derivations of what Core's projections
 * advertise, and advertising an intention while the owner has said stop would be
 * a snapshot describing something Freya is not permitted to do.
 */
export interface ConsciousNextActionsView extends ConsciousSectionMeta {
  readonly items: readonly ConsciousNextActionView[]
  readonly listed: number
  readonly omitted: number
}

/* ------------------------------------------------------------------ whole */

/** The ceilings this snapshot was built under, so a surface can show them. */
export interface ConsciousLimitsView {
  readonly maxSources: number
  readonly maxRecentChanges: number
  readonly maxUncertainties: number
  readonly maxNextActions: number
  readonly maxAttentionInboxItems: number
  readonly maxApprovalItems: number
  readonly maxAgents: number
  readonly maxSkills: number
  readonly maxContinuityItems: number
  readonly maxConflictItems: number
  readonly maxWaitItems: number
  readonly maxLifeEntries: number
}

/** STOP ALL, stated above everything else and authoritative. */
export interface ConsciousStopAllView {
  readonly active: boolean
  readonly activatedAt: string | null
  readonly activatedBy: PrincipalId | null
}

/**
 * Everything Freya currently understands about herself and her situation.
 *
 * A mirror in exactly the sense every other projection is: Core builds it, a
 * window holds what Core last sent, and nothing a window can do writes a field
 * of it. There is no command in the Core vocabulary that returns a fresher one,
 * because a pull channel and a push channel are enough for a read.
 */
export interface ConsciousContextProjection {
  readonly schemaVersion: number
  /**
   * `'ready'` when every contributing source could be read, `'degraded'` when
   * some could not and the snapshot says which, `'unavailable'` when there is
   * no conscious context at all.
   *
   * Stated rather than implied, for the reason every other subsystem gives: a
   * partial picture that renders as a complete one is the failure this phase
   * exists to prevent.
   */
  readonly health: 'ready' | 'degraded' | 'unavailable'
  /** Why, in words a person can act on. Null when ready. */
  readonly reason: string | null
  readonly stopAll: ConsciousStopAllView
  readonly self: ConsciousSelfView
  readonly posture: ConsciousPostureView
  readonly focus: ConsciousFocusView
  readonly attention: ConsciousAttentionView
  readonly waiting: ConsciousWaitingView
  readonly agents: ConsciousAgentsView
  readonly practice: ConsciousPracticeView
  readonly world: ConsciousWorldView
  readonly life: ConsciousLifeView
  readonly continuity: ConsciousContinuityView
  readonly recentChanges: ConsciousRecentChangesView
  readonly uncertainty: ConsciousUncertaintiesView
  readonly nextActions: ConsciousNextActionsView
  readonly provenance: ConsciousProvenanceView
  readonly limits: ConsciousLimitsView
}

/* ------------------------------------------------------------- constants */

/** The projection schema this lane speaks. */
export const CONSCIOUS_CONTEXT_SCHEMA_VERSION = 1

/**
 * The sentence Core reports when nothing has built a conscious context.
 *
 * Exported so the host, a future surface and the tests quote the same words
 * instead of paraphrasing the absence into four slightly different claims.
 */
export const NO_CONSCIOUS_CONTEXT_REASON =
  'Core has not reported a conscious context: nothing is known about her situation, and none is simulated'

/**
 * The instant the absent snapshot is stamped with.
 *
 * A frozen constant rather than a clock read, so `ABSENT_CONSCIOUS_CONTEXT_PROJECTION`
 * is a constant in fact and not merely in declaration — a module-level `new Date()`
 * would make two reads of the same frozen object differ, which is exactly the
 * drift this phase is supposed to remove.
 */
const ABSENT_AS_OF = '1970-01-01T00:00:00.000Z'

/* ---------------------------------------------------------------- absent */

/**
 * A valid snapshot for a Core that has no conscious context.
 *
 * `'unavailable'`, never `'ready'` with empty lists: "nothing is happening" and
 * "nothing is watching" are different facts, and rendering the second as the
 * first would be telling a person they are caught up when Freya is not listening
 * at all.
 */
export const ABSENT_CONSCIOUS_CONTEXT_PROJECTION: ConsciousContextProjection = Object.freeze({
  schemaVersion: CONSCIOUS_CONTEXT_SCHEMA_VERSION,
  health: 'unavailable' as const,
  reason: NO_CONSCIOUS_CONTEXT_REASON,
  stopAll: Object.freeze({ active: false, activatedAt: null, activatedBy: null }),
  self: Object.freeze({
    state: 'absent' as const,
    note: null,
    name: null,
    role: null,
    purpose: null,
    claimCount: 0,
    capabilities: Object.freeze([]),
    limitations: Object.freeze([]),
    complete: false,
  }),
  posture: Object.freeze({
    state: 'absent' as const,
    note: null,
    continuity: null,
    formality: null,
    greetingEligible: false,
    temperament: null,
    presenceCueKind: null,
    counts: null,
    durable: null,
  }),
  focus: Object.freeze({
    state: 'absent' as const,
    note: null,
    attentionFocus: 'unknown' as const,
    primaryRunId: null,
    primaryMissionId: null,
    liveRuns: 0,
    runningRuns: 0,
    waitingRuns: 0,
    activeMissions: 0,
    workingAgents: 0,
    scope: null,
  }),
  attention: Object.freeze({
    state: 'absent' as const,
    note: null,
    focus: null,
    counts: null,
    lastDecision: null,
    directive: null,
    inbox: Object.freeze([]),
    schedulesDue: 0,
    schedulesPending: 0,
  }),
  waiting: Object.freeze({
    state: 'absent' as const,
    note: null,
    approvals: Object.freeze([]),
    pendingApprovals: 0,
    waitingRuns: Object.freeze([]),
    blockedTasks: Object.freeze([]),
    blockedAgents: Object.freeze([]),
    unfulfilledPresenceRequests: Object.freeze([]),
  }),
  agents: Object.freeze({
    state: 'absent' as const,
    note: null,
    workers: Object.freeze([]),
    counts: null,
    detailAvailable: null,
    assignmentsRetained: 0,
    assignmentsTotal: 0,
    assignmentsHidden: 0,
  }),
  practice: Object.freeze({
    state: 'absent' as const,
    note: null,
    skills: Object.freeze([]),
    counts: null,
    thresholds: null,
    durable: null,
    listed: 0,
    omitted: 0,
  }),
  world: Object.freeze({
    state: 'absent' as const,
    note: null,
    entities: null,
    relations: null,
    observations: null,
    memories: null,
    admitted: null,
    conflicted: null,
    rejected: null,
    withdrawn: null,
    experiences: null,
    conflicts: Object.freeze([]),
    durable: null,
  }),
  continuity: Object.freeze({
    state: 'absent' as const,
    note: null,
    items: Object.freeze([]),
    listed: 0,
    omitted: 0,
    durable: null,
  }),
  life: Object.freeze({
    state: 'absent' as const,
    note: null,
    entries: null,
    admitted: null,
    recalled: null,
    durable: null,
    recent: Object.freeze([]),
    listed: 0,
    omitted: 0,
  }),
  recentChanges: Object.freeze({
    state: 'absent' as const,
    note: null,
    items: Object.freeze([]),
    listed: 0,
    omitted: 0,
  }),
  uncertainty: Object.freeze({
    state: 'absent' as const,
    note: null,
    items: Object.freeze([]),
    listed: 0,
    omitted: 0,
  }),
  nextActions: Object.freeze({
    state: 'absent' as const,
    note: null,
    items: Object.freeze([]),
    listed: 0,
    omitted: 0,
  }),
  provenance: Object.freeze({
    basis: 'authoritative' as const,
    freshness: 'absent' as const,
    durableSequence: 0,
    asOf: ABSENT_AS_OF,
    sources: Object.freeze([]),
  }),
  limits: Object.freeze({
    maxSources: 0,
    maxRecentChanges: 0,
    maxUncertainties: 0,
    maxNextActions: 0,
    maxAttentionInboxItems: 0,
    maxApprovalItems: 0,
    maxAgents: 0,
    maxSkills: 0,
    maxContinuityItems: 0,
    maxConflictItems: 0,
    maxWaitItems: 0,
    maxLifeEntries: 0,
  }),
})

/** Re-exported so a consumer can narrow without reaching into the Brain. */
export type {
  AssignmentStatus,
  Confidence,
  ContinuityState,
  CueKind,
  FormalityPreference,
  MemoryKind,
  MemoryStatus,
  MissionAction,
  SourceTrust,
  TemperamentDimension,
  TemperamentLevel,
  WorkforceAction,
}
