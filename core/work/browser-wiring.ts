import type { WorkRegistry } from './capability'
import { registerBrowserInspection, type BrowserMissionPort } from './browser-inspection'
import type { MissionBrowserEvidence } from '../missions/chat-types'

/**
 * WIRING THE MISSION BROWSER CAPABILITIES INTO CORE.
 *
 * The registration itself lives in `core/work/browser-inspection.ts`; this file is the one
 * that has to be *told* how a Mission's authority and its evidence store work, because only
 * Core knows those. It exists as its own module so `core/index.ts` does not grow by the whole
 * admission closure every time the browser surface changes.
 *
 * ## What it holds and what it does not
 *
 * It holds no authority of its own. Every fact it consults is read live through the port it
 * is given — the Mission record, the encrypted content store, and the existing authorisation
 * and availability checks — so a Mission that stopped, was paused, lost its grant or ran out
 * of budget is refused at the moment of the check rather than at some earlier one.
 *
 * The browser is a `BrowserMissionPort` handed in by the host. This module never constructs
 * one, never opens a window and never holds a session; if the host mounted no browser, no
 * capability is registered and the planner is told there is nothing to plan with.
 */

/** What Core knows that only Core can answer. */
export interface MissionBrowserWiring {
  /** The Mission that owns this Run, or null when the Run has no Mission parent. */
  missionIdForRun(runId: string): string | null
  /** The Mission's live status, or null. Read at the moment of each check, never cached. */
  statusOf(missionId: string): string | null
  /** The Mission's private content, or null. `requireDurable` refuses an ephemeral store. */
  contentFor(missionId: string, requireDurable: boolean): Promise<{ browserEvidence?: Readonly<Record<string, MissionBrowserEvidence>> } | null>
  /** The Run must be one this Mission actually created and still lists as a child. */
  runBelongsToMission(runId: string, missionId: string): boolean
  /** The Mission must have this exact step, with one of the browser capabilities. */
  stepIsBrowserStep(missionId: string, stepId: string): boolean
  /** The Mission must still be live: authorized, un-paused, available and not stopped. */
  missionMayProceed(missionId: string): Promise<boolean>
  /** Charge one external request against the Mission's ceiling. */
  chargeExternalRequest(missionId: string): Promise<boolean>
  /** Persist this step's retained evidence. */
  saveEvidence(missionId: string, stepId: string, evidence: MissionBrowserEvidence): Promise<void>
}

/**
 * The eight facts about a Mission that only Core can answer.
 *
 * Narrow on purpose: everything else about a Mission is already on its durable record, and
 * passing Core itself would make this module's dependency on Core unbounded — every method
 * would silently be in reach, so the list would stop being a decision anyone made.
 */
export interface MissionBrowserContext {
  /** The Mission a Work Run belongs to, or null. */
  runMissionId(runId: string): string | null
  /** The Mission's live status, read at the moment of the question. */
  missionStatus(missionId: string): string | null
  /** This step's retained browser evidence, or null. `requireDurable` refuses an ephemeral store. */
  missionBrowserEvidence(missionId: string, requireDurable: boolean): Promise<{ browserEvidence?: Readonly<Record<string, MissionBrowserEvidence>> } | null>
  /** Whether this Mission lists this Run as one of its own children. */
  missionOwnsRun(missionId: string, runId: string): boolean
  /** Whether this Mission's active plan has this step, with a browser capability. */
  missionHasBrowserStep(missionId: string, stepId: string): boolean
  /** Whether this Mission may still make external requests: bound, authorized, not paused. */
  missionMaySpendExternally(missionId: string): Promise<boolean>
  /** Charge one external request against this Mission's ceiling. */
  chargeMissionExternalRequest(missionId: string): Promise<boolean>
  /** Persist this step's retained evidence beside the Mission's encrypted intent. */
  saveMissionBrowserEvidence(missionId: string, stepId: string, evidence: MissionBrowserEvidence): Promise<void>
}

/** The live statuses a browser step may run in. Named here so admission and execution agree. */
const LIVE_FOR_EXTERNAL_WORK: readonly string[] = ['active', 'planning']

/**
 * Build the ports `registerBrowserInspection` needs, from Core's own authority.
 *
 * ## The admission check, and why it is this long
 *
 * Every clause is a distinct fact that could independently make the step illegitimate, and a
 * shorter list would mean trusting a stale reading of one of them:
 *
 * 1. **The Run has a Mission parent.** A Work Run with no Mission is not a Mission step.
 * 2. **The Mission's content is durable and readable.** Without the encrypted store there is
 *    nowhere to record what was read, and a step that read a page it could not account for is
 *    exactly the unverifiable outcome this architecture exists to prevent.
 * 3. **The Mission is bound to a conversation.** A Mission created by some other route has no
 *    owner-approved scope to spend an external request against.
 * 4. **The Run is one of that Mission's own children.** Otherwise any Run could claim any
 *    Mission's budget.
 * 5. **This step exists and is a browser step.** Re-checked per command, so a step cannot be
 *    swapped between two commands of one execution.
 * 6. **The Mission may still proceed** — authorized, not paused, surface available, not
 *    stopped. Read live, every time.
 * 7. **The external-request ceiling has room.** Charged before the request, so a step that
 *    crashes mid-command is still charged for the command it began.
 */
export function browserMissionPorts(browser: BrowserMissionPort, wiring: MissionBrowserWiring): {
  browser: BrowserMissionPort
  admit(runId: string, stepKey: string, signal?: AbortSignal): Promise<void>
  save(runId: string, stepKey: string, evidence: MissionBrowserEvidence): Promise<void>
  read(runId: string, stepKey: string): Promise<MissionBrowserEvidence | null>
} {
  return {
    browser,

    async admit(runId, stepKey, signal) {
      signal?.throwIfAborted()
      const missionId = wiring.missionIdForRun(runId)
      if (missionId === null) throw new Error('Browser authorization unavailable.')
      const content = await wiring.contentFor(missionId, true)
      if (content === null) throw new Error('Browser authorization unavailable.')
      if (!wiring.runBelongsToMission(runId, missionId)) throw new Error('Browser authorization unavailable.')
      if (!wiring.stepIsBrowserStep(missionId, stepKey)) throw new Error('Browser authorization unavailable.')
      if (!LIVE_FOR_EXTERNAL_WORK.includes(wiring.statusOf(missionId) ?? '')) throw new Error('Browser authorization unavailable.')
      if (!await wiring.missionMayProceed(missionId)) throw new Error('Browser authorization unavailable.')
      const charged = await wiring.chargeExternalRequest(missionId)
      if (!charged) throw new Error('Browser request budget exhausted.')
      signal?.throwIfAborted()
    },

    async save(runId, stepKey, evidence) {
      const missionId = wiring.missionIdForRun(runId)
      if (missionId === null) throw new Error('Attached Mission unavailable.')
      await wiring.saveEvidence(missionId, stepKey, evidence)
    },

    async read(runId, stepKey) {
      const missionId = wiring.missionIdForRun(runId)
      if (missionId === null) return null
      const content = await wiring.contentFor(missionId, false)
      return content?.browserEvidence?.[stepKey] ?? null
    },
  }
}

/**
 * Register the browser capabilities against a live browser, or register nothing.
 *
 * A Core with no browser mounted returns `false`, and the caller treats that as "this Core
 * has no browser capabilities" — which is what keeps the Mission planner from offering a step
 * that could not run.
 *
 * `ctx` is Core itself, narrowed to the four things only Core knows. Passing the whole Core
 * would be simpler to call and much worse to review: every method on it would silently be
 * reachable from here, so the surface this module depends on would stop being a decision.
 */
export function registerMissionBrowser(
  registry: WorkRegistry,
  browser: BrowserMissionPort | null,
  ctx: MissionBrowserContext,
): boolean {
  if (browser === null || browser === undefined) return false
  registerBrowserInspection(registry, browserMissionPorts(browser, {
    missionIdForRun: ctx.runMissionId,
    statusOf: ctx.missionStatus,
    contentFor: ctx.missionBrowserEvidence,
    runBelongsToMission: (runId, missionId) => ctx.missionOwnsRun(missionId, runId),
    stepIsBrowserStep: ctx.missionHasBrowserStep,
    missionMayProceed: ctx.missionMaySpendExternally,
    chargeExternalRequest: ctx.chargeMissionExternalRequest,
    saveEvidence: ctx.saveMissionBrowserEvidence,
  }))
  return true
}