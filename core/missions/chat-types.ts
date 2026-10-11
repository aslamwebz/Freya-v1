import type { ResearchSource } from '../research/evidence'

export type { ChatMissionProposal } from '../../shared/contracts/projections/chat-mission'

/**
 * The budget a chat Mission is created with.
 *
 * ## What changed, and what did not
 *
 * This was `{ maxModelCalls: 3, maxActions: 3, maxStepsPerPlan: 2, maxExternalRequests: 32 }`
 * — sized for "search once, read a couple of pages, report". That is too small for a Mission
 * the owner actually asked for: "find ten sites, visit each, find its contact page, verify
 * the details" needs on the order of twenty steps (a read and an extract per site), which a
 * two-step plan can never express — the plan would be truncated and the extra work silently
 * dropped.
 *
 * The numbers are **the ceiling for what the owner approved**, frozen at creation, and they
 * are rendered into the proposal text (`renderMissionProposal`) so the person pressing
 * Approve can read the actual bounds rather than trust them.
 *
 * What was deliberately *not* widened:
 *
 * - `maxModelCalls` stays **3** — plan, one revision, report. This is the dimension that
 *   costs money, and a larger multi-step Mission does not need more *model* calls, only more
 *   browser actions. Raising it would be spending more, not doing more.
 * - `maxRetries` stays **1** and `maxPlanRevisions` stays **2** (set by
 *   `ChatMissionIntegration.decideOnce`). A plan that keeps failing should reach a person,
 *   not keep re-planning.
 * - `maxDurationMs` stays **30 minutes**. A Mission that has not finished in half an hour is
 *   a Mission the owner should be told about.
 *
 * `maxExternalRequests` and `maxStepsPerPlan` are the only two that moved, and both are
 * still far below the code-owned ceilings `missionBudget` enforces.
 */
export const CHAT_MISSION_POLICY = Object.freeze({
  /** Plan, one revision, report. The only dimension that spends money. */
  maxModelCalls: 3,
  /**
   * Actions. Two per site (read, extract) across ten sites is twenty, plus headroom for the
   * verifier's own re-read and a retry. Below the 128 code-owned ceiling.
   */
  maxActions: 64,
  /**
   * Page fetches and searches.
   *
   * Admission is charged before **every** browser command, and each `browser.read` or
   * `browser.contact.extract` issues three (open, navigate, describe) while its verifier
   * issues three more. Ten sites is therefore ~60, and a partial run with one retry each
   * reaches ~120. Below the 512 code-owned ceiling.
   */
  maxExternalRequests: 256,
  /**
   * Steps in one plan. Twenty lets a plan cover ten sites (a read and an extract each); a
   * plan may still be revised twice. Below the 24 code-owned ceiling.
   */
  maxStepsPerPlan: 24,
  maxPlanRevisions: 2,
  maxDurationMs: 30 * 60 * 1000,
})

export interface ChatMissionBinding {
  readonly conversationId: string
  readonly proposalMessageId: string
  readonly ownerId: string
  readonly grantId: string
  readonly approvedAt: string
  readonly scope: string
  readonly paused: boolean
  readonly reportMessageId?: string
}

export interface MissionResearchEvidence {
  readonly sources: readonly ResearchSource[]
  readonly verified: boolean
  readonly failure: string | null
  /** Actual production strategy selected for this research execution. */
  readonly strategyUsed?: { readonly id: string; readonly version: string } | null
}

/**
 * What one browser step retained, for its own verifier to re-read against.
 *
 * ## Where this lives and why it is not in the journal
 *
 * Private content beside the encrypted intent, on the same terms as
 * {@link MissionResearchEvidence}: `MissionStepRecord` holds ids, statuses, counts and
 * lengths, so a page's words are written here and never into an event payload. The Work
 * engine's own contract says the same about `observation.data` — it is for the verifier and
 * for nothing else.
 *
 * ## What `verified` means here, precisely
 *
 * It means **an independent second read of the same page still contained what this step
 * recorded**. That is a narrower and more honest claim than "the contact details are
 * correct", and `failure` carries the specific way it fell short rather than a boolean:
 *
 *   - `page_not_read` — the browser refused; nothing was observed.
 *   - `page_reading_not_permitted` — this build's command ceiling was too low to read a body.
 *   - `no_contact_details_found` — the page was read and nothing of a recognisable shape was
 *     on it. **A real, reportable outcome**, not an error: "this site publishes no contact
 *     details" is one of the answers the mission asked for.
 *   - `contact_details_changed` — a re-read no longer contained everything reported, so the
 *     list was not verified. The findings are kept so the report can show what moved.
 *   - `null` — read, and (once `verified`) re-read successfully.
 */
export interface MissionBrowserEvidence {
  /** The address the plan asked for, which is not necessarily where the page ended up. */
  readonly requestedUrl: string
  /** Where the browser actually landed, or null when nothing was read. */
  readonly finalUrl: string | null
  readonly title: string | null
  /** Bounded page text. Retained so the verifier compares against the same slice. */
  readonly text: string
  /** Contact-page candidates this page offered, ranked. Addresses are as the page declared them. */
  readonly links: readonly { readonly label: string; readonly href: string; readonly rank: number }[]
  /** Strings of a recognisable contact shape. Not assertions that they work. */
  readonly contacts: readonly { readonly kind: 'email' | 'phone' | 'address'; readonly value: string }[]
  readonly verified: boolean
  readonly failure: string | null
  readonly readAt: string
}

export interface ConversationMissionView {
  readonly proposalMessageId: string
  readonly missionId: string | null
  readonly status: string
  readonly paused: boolean
  readonly steps: readonly { stepId: string; intent: string; status: string }[]
  readonly blockers: readonly string[]
}
