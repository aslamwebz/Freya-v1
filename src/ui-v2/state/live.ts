import type {
  ActivityRow,
  AttentionView,
  CoreView,
  HomeView,
  MindAttentionCounts,
  MindMissionView,
  MindOverviewView,
  MindProviderView,
  MindSelfView,
  MindThreadView,
  MindView,
  MissionView,
  ProviderView,
  Resource,
  UiAdapter,
  UiSnapshot,
  WorkforceView,
} from './contract'
import { coreMirror } from '../../platform/coreClient'
import { missionMirror } from '../../platform/missionClient'
import { workforceMirror } from '../../platform/workforceClient'
import { attentionMirror } from '../../platform/attentionClient'
import { brainMirror } from '../../platform/brainClient'
import { workMirror } from '../../platform/workClient'
import { personalityMirror } from '../../platform/personalityClient'
import { contextMirror } from '../../platform/contextClient'
import { consciousnessMirror } from '../../platform/consciousnessClient'
import { worldMirror } from '../../platform/worldClient'
import { selfMirror } from '../../platform/selfClient'
import { hostBridge, type ProviderConfigView } from '../../platform/host'
import { ABSENT_CONSCIOUS_CONTEXT_PROJECTION } from '../../../core/protocol/consciousness'
import { checkProviderBaseUrl } from '../../../core/model/provider-endpoint'

/**
 * The Phase 19.1 live adapter: the UI's first real projection of Phases 0–18.
 *
 * Three rules govern everything in this file, and they exist because the domains on
 * the other side of the bridge were built to withhold things:
 *
 * 1. **Report only what a projection carries.** Every field below is copied out of a
 *    Core projection. Nothing is inferred, smoothed, defaulted into confidence, or
 *    back-filled from the preview fixtures.
 * 2. **Absence is a state, not a gap.** `unavailable` carries the reason Core or the
 *    host gave. Rendering "no attention" when nothing is watching would be telling the
 *    owner they are caught up when in fact nothing is looking.
 * 3. **One mirror per domain, one snapshot.** The mirrors are the renderer's only
 *    window onto Core, and they already own their subscriptions. This adapter
 *    subscribes to them and derives, so the UI holds a projection rather than a
 *    second copy of the truth.
 *
 * It also does *less* than the concept art implied, on purpose. There is no focus
 * percentage, because `FocusState` has no denominator. There are no Mission titles,
 * because Mission content lives in an encrypted store and `coreMissionDetail` is not
 * on the bridge. There are no people and no world, because no such projection exists
 * yet. Each of those omissions is visible in the surface as an absent panel, which is
 * the honest rendering of "not built yet".
 */

const LOADING: Resource<never> = { status: 'loading' }

/** Core's closed labels, mapped to words. The code is the fact; this is only its shape. */
function lifecycleWords(lifecycle: string): string {
  switch (lifecycle) {
    case 'running': return 'running'
    case 'booting': return 'starting'
    case 'stopped': return 'stopped'
    case 'degraded': return 'degraded'
    default: return lifecycle
  }
}

function countPhrase(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`
}

/**
 * The run statuses that are not live and not finished.
 *
 * A local closed list rather than an import from `core/work/types`, and the
 * reason is the one every other rule in this file gives: the renderer's
 * vocabulary should not have to know the domain's state machine to render it.
 * Core has already told us which runs occupy the engine through `live`; this
 * list only decides which of the *historical* ones are still worth calling
 * "in progress".
 */
const OPEN_RUN_STATUSES: readonly string[] = ['queued', 'waiting', 'paused']

/**
 * The one mode word, derived in one place from facts Core already reports.
 *
 * Ordered by how much the condition matters, so that two surfaces reading it
 * cannot disagree. A latched STOP ALL outranks a Core that is not reachable,
 * which outranks a faulted one, which outranks real work — because a person
 * reading a dashboard has to see the panic button before anything else.
 */
function mindMode(core: CoreView): { mode: MindOverviewView['mode']; detail: string } {
  if (core.stopped) {
    return {
      mode: 'stopped',
      detail: 'STOP ALL is latched. Core refuses new cognition until the owner resumes.',
    }
  }
  if (!core.operational) {
    return {
      mode: 'unavailable',
      detail: `Core is not serving commands (${core.lifecycle}). Nothing here is live.`,
    }
  }
  if (core.faultCount > 0 || core.integrity !== 'ok') {
    return {
      mode: 'uncertain',
      detail: core.faultCount > 0
        ? `${countPhrase(core.faultCount, 'fault')} recorded, so this projection may be incomplete.`
        : `The journal reads ${core.integrity}; folded state may be incomplete.`,
    }
  }
  if (core.activeRequests > 0) {
    return {
      mode: 'working',
      detail: `${countPhrase(core.activeRequests, 'provider request')} executing right now.`,
    }
  }
  return { mode: 'idle', detail: 'Nothing is executing. Core is up and listening.' }
}

/**
 * The provider status in words a surface can render.
 *
 * `hasKey` is a usable configuration, because the host only reports `true` when it
 * can actually unwrap a stored credential. The three details are the only states
 * that exist: a key plus live enabled is `connected`; a key with live inference
 * switched off is `live-disabled`; no usable key is `not configured`. Nothing here
 * inspects, logs or forwards the key — it is a boolean on the far side.
 */
function providerView(config: ProviderConfigView): ProviderView {
  const connected = config.hasKey
  /**
   * The endpoint is re-checked here rather than trusted, because the value came off
   * disk and a file can predate this build, be restored from a backup, or be edited
   * by hand. A renderer must never have to wonder whether the host it is talking to
   * applied the same rule it did.
   */
  const endpointApproved = config.baseUrl.length === 0 || checkProviderBaseUrl(config.baseUrl).ok
  const detail = !endpointApproved
    ? 'endpoint not approved'
    : config.credentialState === 'storage-unavailable'
      ? 'secure storage unavailable'
      : config.credentialState === 'unreadable'
        ? 'stored key unreadable'
        : !connected
          ? 'not configured'
          : config.liveEnabled
            ? 'connected'
            : 'live-disabled'
  return {
    connected,
    baseUrl: config.baseUrl,
    model: config.model,
    liveEnabled: config.liveEnabled,
    hasKey: config.hasKey,
    credentialState: config.credentialState,
    credentialReason: config.credentialReason,
    endpointApproved,
    detail,
  }
}

export interface LiveAdapter extends UiAdapter {
  /** Idempotent. Attaches every mirror this projection needs, once. */
  attach(): Promise<() => void>
}

export function createLiveAdapter(): LiveAdapter {
  const core = coreMirror()
  const missions = missionMirror()
  const workforce = workforceMirror()
  const attention = attentionMirror()

  /**
   * Whether this window can ever receive a projection.
   *
   * Captured once, because it cannot change without a reload. With no bridge the Core
   * mirror publishes an `ABSENT` status whose lifecycle is `booting` — which would tell
   * the owner Freya is starting when in fact nothing is there to start, and `loading`
   * would imply an arrival that is never coming. `unavailable` is the only honest
   * answer, and it names the reason so the surface can say so in words.
   */
  const available = liveAvailable()
  const NO_CORE_REASON = 'No Freya Core is reachable from this window.'
  const noCore = <T,>(): Resource<T> => ({ status: 'unavailable', reason: NO_CORE_REASON })
  const absent: UiSnapshot = {
    home: noCore(), core: noCore(), mission: noCore(),
    workforce: noCore(), activity: noCore(), attention: noCore(),
    mind: noCore(), provider: noCore(),
  }

  let snapshot: UiSnapshot = available
    ? {
        home: LOADING, core: LOADING, mission: LOADING, workforce: LOADING,
        activity: LOADING, attention: LOADING, mind: LOADING, provider: LOADING,
      }
    : absent
  const listeners = new Set<() => void>()

  /**
   * The provider resource, read once through the bridge rather than polled.
   *
   * The provider is a setting, not a stream: it changes only when the owner saves a
   * new one, and the Settings surface re-reads it through the bridge at that moment.
   * There is no subscription to hold open, so an idle window never asks the main
   * process for a credential status it already has.
   */
  let providerResource: Resource<ProviderView> = available ? LOADING : noCore()

  const refreshProvider = async (): Promise<void> => {
    const bridge = hostBridge()
    if (!bridge) {
      providerResource = noCore()
      derive()
      return
    }
    try {
      providerResource = { status: 'ready', source: 'live', data: providerView(await bridge.providerConfig()) }
    } catch (error) {
      providerResource = {
        status: 'error',
        reason: error instanceof Error ? error.message : 'the provider configuration could not be read',
      }
    }
    derive()
  }

  const coreView = (): Resource<CoreView> => {
    const status = core.status
    if (!status) return LOADING
    return {
      status: 'ready',
      source: 'live',
      data: {
        lifecycle: lifecycleWords(status.lifecycle),
        sequence: status.eventSequence,
        activeRequests: status.activeProviderCalls,
        stopped: status.stopAll.active,
        integrity: status.integrity.integrity,
        faultCount: status.faults.length,
        operational: status.operational,
        persistenceDurable: status.persistence.durable,
        persistenceMode: status.persistence.mode,
        persistenceReason: status.persistence.reason,
        diagnosticsPath: status.diagnostics.path,
        diagnosticsWriteFailures: status.diagnostics.writeFailures,
        faults: status.faults,
        // `unknown` is not `deny_all`: a Core that has not finished booting has
        // no answer, and reporting "denying everything" there would claim a
        // stop latch that may well not be set.
        governorStatus: status.governor.status,
        grantsActive: status.governor.grantsActive,
        sessionUsage: status.sessionUsage,
        durableUsage: status.durableUsage,
      },
    }
  }

  /**
   * The provider rows the Mind may print.
   *
   * A shape and a state, never a credential: `detail` is the provider's own
   * sentence, `model` is the name it would serve, and there is no field here a
   * key could occupy. Reported because "which provider would answer, and is it
   * allowed to" is an operator question, not because a window may choose one.
   */
  const coreViewProviders = (): readonly MindProviderView[] => {
    const status = coreMirror().status
    if (!status) return []
    return status.providers.map((provider) => ({
      id: provider.id,
      kind: provider.kind,
      status: provider.status,
      model: provider.model,
      liveEnabled: provider.liveEnabled,
      detail: provider.detail,
    }))
  }

  const missionView = (): Resource<MissionView> => {
    const projection = missions.projection
    if (!projection) return LOADING
    return {
      status: 'ready',
      source: 'live',
      data: {
        rows: projection.missions.map((mission) => ({
          id: mission.missionId,
          status: mission.status,
          runs: mission.counts.total,
          // Core reports runs whose every step verified. Not a completion claim.
          verifiedRuns: mission.counts.verified,
          needsAttention: mission.needsAttention,
        })),
        total: projection.counts.total,
        hidden: projection.missionsHidden,
        durable: projection.persistence.durable,
      },
    }
  }

  const workforceView = (): Resource<WorkforceView> => {
    const projection = workforce.projection
    if (!projection) return LOADING
    // `health: 'unavailable'` means nobody counted, which is not the same as zero
    // workers. Reporting the counts as live data would be the exact lie the
    // protocol's comment warns about, so the projection is passed through whole.
    if (projection.health !== 'ready') {
      return { status: 'unavailable', reason: projection.reason ?? 'the Workforce domain is not reporting' }
    }
    return {
      status: 'ready',
      source: 'live',
      data: {
        rows: projection.workers.map((worker) => ({
          id: worker.workerId, state: worker.state, specialization: worker.specialization,
        })),
        total: projection.counts.workers,
        working: projection.counts.working,
      },
    }
  }

  const activityView = (): Resource<readonly ActivityRow[]> => {
    // An empty feed from a Core that never reported is not "no activity" — it is no
    // evidence at all. Publishing it would tell the owner nothing has happened, which
    // is the one thing this projection cannot establish without a Core behind it.
    if (!core.status) return LOADING
    return {
      status: 'ready',
      source: 'live',
      // `text` here is Core's own one-sentence description, derived by
      // `describeActivity`. It never contains command text, prompt text or a response.
      data: core.activity.map((event) => ({
        id: event.id, text: event.text, at: event.at, sequence: event.sequence, tone: event.tone,
      })),
    }
  }

  const attentionView = (): Resource<AttentionView> => {
    const projection = attention.projection
    if (!projection) return LOADING
    if (projection.health !== 'ready') {
      return { status: 'unavailable', reason: projection.reason ?? 'the Attention domain is not reporting' }
    }
    return {
      status: 'ready',
      source: 'live',
      data: {
        focus: projection.focus,
        ingested: projection.counts.ingested,
        decisions: projection.counts.decisions,
        cued: projection.counts.cued,
        spoke: projection.counts.spoke,
        interrupted: projection.counts.interrupted,
        budgetExceeded: projection.counts.budgetExceeded,
        inboxCount: projection.inbox.length,
      },
    }
  }

  /**
   * The Mind projection.
   *
   * Built from the mirrors Core already publishes, and from nowhere else. Three
   * rules, the same three every other view in this file is written around:
   *
   * 1. **Report only what a projection carries.** Every field below is copied
   *    out of a Core projection. Nothing is inferred, smoothed, defaulted into
   *    a trait, or back-filled from the preview fixtures.
   * 2. **Absence is a state, not a gap.** A section Core has not built arrives
   *    as `unavailable` with Core's own reason, named in `absentSections`, so a
   *    surface can say "not projected" rather than drawing an empty list that
   *    reads as "nothing there".
   * 3. **No hidden reasoning crosses.** There is no thought, no monologue, no
   *    prompt and no model output anywhere in this shape. What a window sees is
   *    Core's own account of itself: what it is doing, what it is holding, what
   *    it could not settle, and which subsystem said so.
   *
   * It is *not* gated on the conscious context. A Core that has not reported
   * one still has a lifecycle, a Brain, a Work engine and a workforce, and a
   * Mind that showed nothing until Phase 20's snapshot arrived would be a Mind
   * that lied about how little it knows.
   */
  const mindAttentionView = (): MindView['attention'] => {
    const projection = attention.projection
    if (!projection) {
      return {
        health: 'unavailable',
        reason: 'Core has not reported an Attention domain yet',
        focus: 'unknown',
        counts: null,
        inboxCount: 0,
        lastDecision: null,
      }
    }
    if (projection.health !== 'ready') {
      return {
        health: 'unavailable',
        reason: projection.reason ?? 'the Attention domain is not reporting',
        focus: projection.focus,
        counts: null,
        inboxCount: 0,
        lastDecision: null,
      }
    }
    const counts: MindAttentionCounts = {
      ingested: projection.counts.ingested,
      decisions: projection.counts.decisions,
      doNothing: projection.counts.doNothing,
      remembered: projection.counts.remembered,
      cued: projection.counts.cued,
      spoke: projection.counts.spoke,
      interrupted: projection.counts.interrupted,
      budgetExceeded: projection.counts.budgetExceeded,
    }
    const last = projection.lastDecision
    return {
      health: 'ready',
      reason: null,
      // Core's own closed `FocusState`. Never a percentage: there is no
      // denominator anywhere in the codebase for one.
      focus: projection.focus,
      counts,
      // Metadata only. The event's text stays in Core and comes back only from
      // an explicit `attention.inbox.read`, which no standing feed performs.
      inboxCount: projection.inbox.length,
      lastDecision: last === null
        ? null
        : {
            source: last.source,
            kind: last.kind,
            outcome: last.outcome,
            importance: last.importance,
            urgency: last.urgency,
            reason: last.reason,
            decidedAt: last.decidedAt,
          },
    }
  }

  const mindSelfView = (): MindSelfView => {
    const brain = brainMirror().projection
    const conscious = consciousnessMirror().projection ?? ABSENT_CONSCIOUS_CONTEXT_PROJECTION
    const world = worldMirror().projection
    const self = selfMirror()

    const claims = brain?.identity?.claims ?? []
    const capabilities = brain?.self?.capabilities ?? []
    const limitations = brain?.self?.limitations ?? []

    const worldView = world === null
      ? null
      : world.health !== 'ready'
        ? {
            health: 'unavailable' as const,
            reason: world.reason ?? 'Core has not reported a world model yet',
            entities: 0,
            edges: 0,
            evidenceRecords: 0,
            withdrawn: 0,
            conflicts: 0,
            beliefs: 0,
            uncertainties: 0,
            withheld: 0,
            durable: world.persistence.durable,
          }
        : {
            health: 'ready' as const,
            reason: null,
            entities: world.counts.entities,
            edges: world.counts.edges,
            evidenceRecords: world.counts.evidenceRecords,
            withdrawn: world.counts.withdrawnRecords,
            conflicts: world.counts.conflicts,
            beliefs: world.counts.beliefs,
            uncertainties: world.uncertainties.total,
            withheld: world.counts.withheld,
            durable: world.persistence.durable,
          }

    const model = self.self
    const worldSelf = model === null
      ? null
      : {
          source: 'world.self.status.read',
          assignedCapabilities: model.assignedCapabilities.items.map((item) => ({
            capability: item.capability,
            held: item.held,
          })),
          knownSkills: model.knownSkills.items.map((item) => ({
            name: item.name,
            status: item.status,
            verification: item.verification,
          })),
          models: model.modelIdentity.items.map((item) => ({
            providerId: item.providerId,
            kind: item.kind,
            live: item.live,
          })),
          workerClaims: model.workerClaims.items.map((item) => ({
            workerId: item.workerId,
            claimKind: item.claimKind,
            decision: item.decision,
          })),
          separation: { ...model.separation },
          readAt: self.readAt,
        }

    return {
      // Core's own fixed statements about itself, mirrored through whichever
      // projection reported them first. Never a temperament reading and never
      // a trait percentage.
      name: conscious.self.name ?? brain?.identity?.name ?? null,
      role: conscious.self.role ?? brain?.identity?.role ?? null,
      purpose: conscious.self.purpose ?? brain?.identity?.purpose ?? null,
      claimCount: conscious.self.claimCount > 0 ? conscious.self.claimCount : claims.length,
      complete: brain?.self?.complete ?? conscious.self.complete,
      claims: claims.map((claim) => ({ claimId: claim.claimId, statement: claim.statement })),
      capabilities: capabilities.map((capability) => ({
        capability: capability.capability,
        state: capability.state,
        cannot: [...capability.cannot],
      })),
      limitations: limitations.map((limitation) => ({
        limitationId: limitation.limitationId,
        statement: limitation.statement,
      })),
      durable: brain?.durable === true,
      reason: brain?.reason ?? null,
      world: worldView,
      worldSelf,
    }
  }

  const mindMissionsView = (): { rows: readonly MindMissionView[]; total: number; hidden: number } => {
    const projection = missions.projection
    if (!projection) return { rows: [], total: 0, hidden: 0 }
    return {
      rows: projection.missions.map((mission) => ({
        id: mission.missionId,
        status: mission.status,
        priority: mission.priority,
        needsAttention: mission.needsAttention,
        awaitingOwner: mission.awaitingOwner,
        totalRuns: mission.counts.total,
        verifiedRuns: mission.counts.verified,
        nextDecision: mission.nextAction?.decision ?? null,
        nextReason: mission.nextAction?.reason ?? null,
        blockers: [...mission.blockers],
      })),
      total: projection.missionsTotal,
      hidden: projection.missionsHidden,
    }
  }

  const mindThreadsView = (): readonly MindThreadView[] => {
    const threads: MindThreadView[] = []
    const work = workMirror().projection
    if (work && work.health === 'ready') {
      for (const run of work.runs) {
        // `live` is the engine's own process fact. A run the journal says was
        // executing when the process died is not one, and Core has already
        // settled it as failed rather than leaving it looking busy.
        if (run.live !== true && !OPEN_RUN_STATUSES.includes(run.status)) continue
        threads.push({
          id: run.runId,
          kind: 'run',
          status: run.status,
          detail: run.limitHit !== null
            ? `a ceiling was hit: ${run.limitHit}`
            : run.waitingOn !== null
              ? `waiting on ${run.waitingOn}`
              : null,
          live: run.live === true,
        })
      }
      for (const approval of work.approvals) {
        if (approval.status !== 'pending') continue
        threads.push({
          id: approval.approvalId,
          kind: 'approval',
          status: approval.status,
          detail: `${approval.capability} · risk ${approval.risk}`,
          // Durable state, not a process fact: an approval nobody has answered
          // is waiting, not executing.
          live: false,
        })
      }
    }
    const mission = missions.projection
    if (mission) {
      for (const row of mission.missions) {
        if (row.status !== 'active') continue
        threads.push({
          id: row.missionId,
          kind: 'mission',
          status: row.status,
          detail: row.needsAttention ? 'needs attention' : null,
          live: false,
        })
      }
    }
    const workforce = workforceMirror().projection
    if (workforce && workforce.health === 'ready') {
      for (const worker of workforce.workers) {
        const active = worker.concurrency?.active ?? 0
        if (active <= 0) continue
        threads.push({
          id: worker.workerId,
          kind: 'worker',
          status: worker.state,
          detail: worker.assignment?.label ?? null,
          live: active > 0,
        })
      }
    }
    // Deterministic order, so two windows render the same list in the same
    // order and a test can assert on one.
    return threads.sort((left, right) =>
      left.kind === right.kind
        ? left.id < right.id ? -1 : left.id > right.id ? 1 : 0
        : left.kind < right.kind ? -1 : 1,
    )
  }

  const mindOwnerView = (): MindView['owner'] => {
    const personality = personalityMirror().projection
    const context = contextMirror().projection
    return {
      personalityHealth: personality === null
        ? 'unavailable'
        : personality.health === 'ready' ? 'ready' : 'unavailable',
      personalityReason: personality === null
        ? 'Core has not reported a Personality projection yet'
        : personality.reason,
      // The safe, checkable dimensions Core computed for this moment. Null when
      // Core has not interpreted it — never a default mood.
      continuity: personality?.interpretation?.continuity ?? null,
      formality: personality?.interpretation?.formality ?? null,
      // Freya's standing temperament. Closed vocabularies at both ends, so a
      // row here is a word Core chose rather than a trait this UI measured.
      temperament: (personality?.temperament?.dimensions ?? []).map((row) => ({
        dimension: row.dimension,
        level: row.level,
      })),
      relationshipItems: personality?.counts.items ?? 0,
      admittedItems: personality?.interpretation?.admittedItems ?? personality?.counts.admitted ?? 0,
      cuesAdmitted: personality?.counts.cuesAdmitted ?? 0,
      // A durability answer from a domain that is not reporting is a default,
      // not a measurement: "no store exists" is not the fact "a store exists
      // and would not survive a restart". Null says not projected, which is
      // what the surface renders as an em dash.
      relationshipDurable: personality?.health === 'ready' ? (personality.persistence.durable ?? null) : null,
      contextHealth: context === null
        ? 'unavailable'
        : context.health === 'ready' ? 'ready' : 'unavailable',
      contextReason: context === null
        ? 'Core has not reported a Context projection yet'
        : context.reason,
      // Metadata and counts. No item's content, label or uri crosses, and
      // nothing here is a record of what the owner shared. The scope is Core's
      // own word for where the live items sit, taken from those items — the
      // window's Context projection carries no active-scope field, so nothing
      // is inferred into one.
      contextItems: context?.counts.items ?? 0,
      contextCurrent: context?.counts.current ?? 0,
      contextScopes: [...new Set(
        (context?.items ?? [])
          .filter((item) => item.state === 'current' && item.scope !== null)
          .map((item) => item.scope!.label),
      )],
      contextUnresolvedReferences: context?.counts.unresolvedReferences ?? 0,
      // Same rule as relationship durability: an unreported domain has no
      // measurement to pass on, so it projects nothing rather than a default.
      contextDurable: context?.health === 'ready' ? (context.persistence?.durable ?? null) : null,
    }
  }

  const mindView = (): Resource<MindView> => {
    const coreResource = coreView()
    if (coreResource.status !== 'ready' && coreResource.status !== 'stale') return coreResource
    const core = (coreResource as { readonly data: CoreView }).data
    const mode = mindMode(core)
    const conscious = consciousnessMirror().projection ?? ABSENT_CONSCIOUS_CONTEXT_PROJECTION

    const providers: readonly MindProviderView[] = coreViewProviders()
    const missions = mindMissionsView()

    return {
      status: 'ready',
      source: 'live',
      data: {
        overview: {
          lifecycle: core.lifecycle,
          operational: core.operational,
          stopped: core.stopped,
          governorStatus: core.governorStatus,
          grantsActive: core.grantsActive,
          activeProviderCalls: core.activeRequests,
          journalIntegrity: core.integrity,
          persistenceMode: core.persistenceMode,
          persistenceReason: core.persistenceReason,
          faults: core.faults,
          sequence: core.sequence,
          mode: mode.mode,
          modeDetail: mode.detail,
          providers,
          sessionCalls: core.sessionUsage?.calls ?? 0,
          sessionInputTokens: core.sessionUsage?.inputTokens ?? null,
          sessionOutputTokens: core.sessionUsage?.outputTokens ?? null,
          sessionUnknownUsageCalls: core.sessionUsage?.unknownUsageCalls ?? 0,
        },
        threads: mindThreadsView(),
        attention: mindAttentionView(),
        self: mindSelfView(),
        missions: missions.rows,
        missionsTotal: missions.total,
        missionsHidden: missions.hidden,
        owner: mindOwnerView(),
        // A closed code and a subject, never a sentence about what Freya is
        // worried about. An inference wearing the same clothes as a fact is the
        // one thing this list must never be.
        uncertainties: conscious.uncertainty.items.map((item) => ({
          code: item.code,
          subjectKind: item.subjectKind,
          subjectId: item.subjectId,
          since: item.since,
        })),
        uncertaintiesOmitted: conscious.uncertainty.omitted,
        nextActions: conscious.nextActions.items.map((item) => ({
          scope: item.scope,
          subjectId: item.subjectId,
          action: item.action,
        })),
        recentChanges: conscious.recentChanges.items.map((item) => ({
          id: item.id,
          kind: item.kind,
          sequence: item.sequence,
          at: item.at,
          tone: item.tone,
        })),
        waiting: {
          pendingApprovals: conscious.waiting.pendingApprovals,
          waitingRuns: conscious.waiting.waitingRuns.map((run) => ({
            runId: run.runId,
            status: run.status,
            waitingSince: run.waitingSince,
          })),
          blockedAgents: conscious.waiting.blockedAgents.map((agent) => ({
            workerId: agent.workerId,
            status: agent.status,
          })),
          unfulfilledPresenceRequests: conscious.waiting.unfulfilledPresenceRequests.length,
        },
        provenance: {
          basis: conscious.provenance.basis,
          freshness: conscious.provenance.freshness,
          asOf: conscious.provenance.asOf,
          sources: conscious.provenance.sources.map((source) => ({
            domain: source.domain,
            basis: source.basis,
            freshness: source.freshness,
            durable: source.durable,
            note: source.note,
          })),
        },
        consciousHealth: conscious.health,
        consciousReason: conscious.reason,
        absentSections: [
          ['self', conscious.self.state === 'absent'],
          ['posture', conscious.posture.state === 'absent'],
          ['focus', conscious.focus.state === 'absent'],
          ['attention', conscious.attention.state === 'absent'],
          ['waiting', conscious.waiting.state === 'absent'],
          ['agents', conscious.agents.state === 'absent'],
          ['practice', conscious.practice.state === 'absent'],
          ['world', conscious.world.state === 'absent'],
          ['life', conscious.life.state === 'absent'],
          ['continuity', conscious.continuity.state === 'absent'],
          ['recent changes', conscious.recentChanges.state === 'absent'],
          ['uncertainty', conscious.uncertainty.state === 'absent'],
          ['next actions', conscious.nextActions.state === 'absent'],
        ].filter((row): row is [string, true] => row[1] === true).map(([name]) => name),
      },
    }
  }

  /**
   * Home is assembled only from what the domains actually reported.
   *
   * The composite is the one place a UI is most tempted to stitch several partial
   * truths into a confident sentence, so it is built to fail closed: if Core has not
   * reported, Home is loading; if Core reported but Attention is absent, Home still
   * renders and simply has no attention reading. `people`, `world` and `goals` are
   * omitted rather than filled — no panel is better than an invented one.
   */
  const homeView = (): Resource<HomeView> => {
    const coreResource = coreView()
    const missionResource = missionView()
    if (coreResource.status !== 'ready' && coreResource.status !== 'stale') return coreResource
    if (missionResource.status !== 'ready' && missionResource.status !== 'stale') return missionResource

    const coreData = (coreResource as { readonly data: CoreView }).data
    const missionData = (missionResource as { readonly data: MissionView }).data
    const attentionResource = attentionView()
    const attentionData = attentionResource.status === 'ready' || attentionResource.status === 'stale'
      ? (attentionResource as { readonly data: AttentionView }).data
      : null

    const active = missionData.rows.filter((row) => row.status === 'active').length
    const attentionRows = missionData.rows.filter((row) => row.needsAttention).length

    return {
      status: 'ready',
      source: 'live',
      data: {
        focus: {
          title: `Freya Core is ${coreData.lifecycle}`,
          detail: coreData.stopped
            ? 'Stop-all is active. Nothing is running until it is cleared.'
            : coreData.activeRequests > 0
              ? `${countPhrase(coreData.activeRequests, 'request')} in flight.`
              : coreData.faultCount > 0
                ? `${countPhrase(coreData.faultCount, 'fault')} recorded.`
                : 'Idle and listening.',
          // No denominator exists for a Mission or for attention, so there is no
          // percentage to print. The surface renders this as absent, not as zero.
          progress: null,
        },
        mission: missionData.total === 0
          ? null
          : [
              countPhrase(missionData.total, 'Mission'),
              active > 0 ? `${active} active` : null,
              attentionRows > 0 ? `${attentionRows} needing attention` : null,
              missionData.hidden > 0 ? `${missionData.hidden} not listed` : null,
            ].filter(Boolean).join(' · '),
        attention: {
          // No percentage. Core's `FocusState` is a closed union with no denominator, so
          // a live Home reports the state as words and leaves the figure absent. `null`
          // is the honest value; `0` would read as "Freya is 0% focused", which is a
          // measurement nothing took.
          focused: null,
          caption: attentionData
            ? `Core reports ${attentionData.focus}`
            : 'Attention is not reporting, so nothing is being watched.',
          categories: [],
          profiles: [],
        },
        // Deliberately omitted: goals (no titles cross the bridge), people and world
        // (no projection exists). Each would otherwise render as fiction.
      },
    }
  }

  const derive = (): void => {
    const next: UiSnapshot = !available ? absent : {
      home: homeView(),
      core: coreView(),
      mission: missionView(),
      workforce: workforceView(),
      activity: activityView(),
      attention: attentionView(),
      mind: mindView(),
      provider: providerResource,
    }
    // A new object each pass would re-render every subscriber on every Core push, so
    // identity is compared before publishing. `useSyncExternalStore` depends on it.
    if (shallowEqual(next, snapshot)) return
    snapshot = next
    for (const listener of [...listeners]) listener()
    // The one-shot self read rides the transition Core already publishes, so a
    // Core that becomes operational a moment after the window attached still
    // gets its compartments filled — exactly once, and never on a timer.
    if (available) void readSelfModel()
  }

  const disposers: (() => void)[] = []

  /**
   * The self model has no push channel, by Core's own design — see
   * `selfClient`. So it is read once, and the Mind says when it was read rather
   * than implying the reading is current.
   *
   * The read waits for a Core that reports itself operational, because an
   * attach that races boot would otherwise ask a Core that is not up yet and
   * leave the compartment permanently blank on a machine where Core comes up a
   * second later. That is a bounded wait on a transition Core already
   * publishes, not a poll: exactly one read happens per window.
   */
  let selfReadSettled = false
  const readSelfModel = async (): Promise<void> => {
    if (selfReadSettled) return
    const status = coreMirror().status
    if (status === null || !status.operational) return
    selfReadSettled = true
    await selfMirror().read()
  }

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    async attach() {
      // Replacing rather than stacking: a second attach must not leave a live
      // subscription with nothing holding its disposer.
      for (const dispose of disposers.splice(0)) dispose()
      // Every subscription this adapter opens is retained, the `subscribe` disposers
      // included. A re-attach used to drop those, so the old derive listener stayed
      // registered and each Core push ran derive twice — a slow leak that only showed
      // up over a long session.
      disposers.push(await core.attach(), await core.attachActivity())
      disposers.push(core.subscribe(derive), core.subscribeActivity(derive))
      disposers.push(await missions.attach())
      disposers.push(missions.subscribe(derive))
      disposers.push(await workforce.attach())
      disposers.push(workforce.subscribe(derive))
      disposers.push(await attention.attach())
      disposers.push(attention.subscribe(derive))
      // The Mind's own lanes: the unified conscious context, the world summary,
      // and the Brain and Work projections the Mind composes its threads and
      // self model from. Each is a read plus a follow and nothing else.
      disposers.push(await consciousnessMirror().attach())
      disposers.push(consciousnessMirror().subscribe(derive))
      disposers.push(await worldMirror().attach())
      disposers.push(worldMirror().subscribe(derive))
      disposers.push(await brainMirror().attach())
      disposers.push(brainMirror().subscribe(derive))
      disposers.push(await workMirror().attach())
      disposers.push(workMirror().subscribe(derive))
      disposers.push(await personalityMirror().attach())
      disposers.push(personalityMirror().subscribe(derive))
      disposers.push(await contextMirror().attach())
      disposers.push(contextMirror().subscribe(derive))
      disposers.push(selfMirror().subscribe(derive))
      derive()
      // The provider is a read, not a subscription: one backstop read per attach, and
      // the Settings surface re-reads it directly when a save lands.
      if (available) {
        void refreshProvider()
        void readSelfModel()
      }
      return () => {
        for (const dispose of disposers.splice(0)) dispose()
      }
    },
  }
}

function shallowEqual(left: UiSnapshot, right: UiSnapshot): boolean {
  const keys = Object.keys(left) as (keyof UiSnapshot)[]
  return keys.every((key) => left[key] === right[key])
}

/**
 * Whether this window can talk to Core at all.
 *
 * A browser, a test and a build preview have no bridge, so `createLiveAdapter` there
 * would render a permanently-loading UI and look broken. `entry` uses this to choose
 * the preview fixtures instead, which is what keeps `npm run dev` useful.
 */
export function liveAvailable(): boolean {
  return hostBridge() !== undefined
}

/**
 * Whether this window is an Electron renderer, regardless of whether a bridge is present.
 *
 * `entry` uses this to choose the adapter, and the distinction matters: a browser has
 * no Core and never will, so it gets the labelled preview fixtures; an Electron
 * `file://` window is a real desktop window, and even when its preload is missing it
 * must use the live adapter so the absence is reported as `unavailable` rather than
 * silently falling back to sample data.
 *
 * The user agent is the signal because it is the one thing a renderer can read that a
 * browser cannot fake without also being Electron. It is a environment check, not a
 * security boundary — the bridge's own authority is unchanged.
 */
export function isElectron(): boolean {
  return typeof navigator !== 'undefined' && /Electron\//.test(navigator.userAgent)
}
