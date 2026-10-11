import type {
  BrowserPortOutcome,
  BrowserPortRequest,
  DeviceHandsActionKey,
  DeviceHandsVerdict,
  GrantFact,
} from '../devicehands'
import type { BrowserCommand, BrowserTarget } from './types'

/**
 * The dual-browser runtime.
 *
 * This is the only file in `core/browser` that touches a port, and it is deliberately
 * small in what it is *allowed* to do with them:
 *
 *   - The **only** route to a page is {@link BrowserAuthorityPort.perform}, which is the
 *     Phase 35 Device Hands runtime called with one of its four existing browser action
 *     keys. There is no second gate chain in this file, no shadow policy, and no code path
 *     that reaches an adapter without a `passed` verdict behind it.
 *   - The **only** things it decides itself are routing, lifecycle, references, media
 *     metadata and handoffs — none of which is authority over anything.
 *   - STOP ALL is read at the top of every command, before routing, so a latched stop
 *     refuses a `session.state` as firmly as it refuses a click.
 *
 * ## The two targets share one authority
 *
 * `page.navigate` here and `page.navigate` in the Phase 43 extension bridge map to the
 * same `browser.navigate` action key, ask for the same grant from the same source, and
 * pass the same ten gates. Choosing a different browser changes *where* the page opens. It
 * does not change *whether* Freya may.
 */

/* -------------------------------------------------------------------- ports */

export type BrowserPayload = Readonly<Record<string, string | number | boolean | null>>


/**
 * What the Phase 35 runtime answers.
 *
 * Deliberately the same three fields `DeviceHandsOutcome` carries. This module does not
 * have a richer answer and must not appear to: the moment it had one, there would be two
 * opinions about whether an action was permitted.
 */
export interface AuthorityVerdict {
  readonly performed: boolean
  readonly verdict: DeviceHandsVerdict
  readonly code: string | null
  readonly reason: string
}


export interface BrowserAuthorityPort {
  /** Core's own STOP ALL latch, composed by the host. Read fresh, every command. */
  stopAllActive(): boolean
  /**
   * One Device Hands action. The grant, the deadline, the policy and the approval are all
   * that runtime's business; this module supplies a key, an input and an id.
   */
  perform(request: {
    readonly actionId: string
    readonly principalId: string
    readonly scope: string
    readonly actionKey: DeviceHandsActionKey
    readonly input: Readonly<Record<string, unknown>>
    readonly at: string
    readonly deadlineAt: string
  }): Promise<AuthorityVerdict>
  /** The grant source, consulted for the owner's own reads only. Never for authority. */
  activeGrant(principalId: string, scope: string): GrantFact | null
}


/**
 * What an adapter observed while performing an already-authorised action.
 *
 * `revision` is the one field every command needs: it is the page's own counter, it only
 * goes up, and the runtime retires every element reference below it. An adapter that
 * cannot report a revision reports `holds: false` instead, because "I did the thing but I
 * cannot tell you which page I did it to" is not a result.
 */
export interface BrowserObservation {
  readonly revision: number
  readonly url: string | null
  readonly title?: string
  readonly elements?: unknown
  readonly text?: string
  /** For a click or a keystroke: whether anything about the page actually changed. */
  readonly changed?: boolean
  /** For a keystroke: the value read back out of the field afterwards. */
  readonly fieldValue?: string
}


export interface BrowserActionContext {
  readonly sessionId: string
  readonly target: BrowserTarget
  readonly command: BrowserCommand
  readonly deadlineAt: string
}


/**
 * The browser effect, for whichever target is running.
 *
 * Shaped exactly like the Phase 43 extension adapter's — `begin`, `performBrowser`,
 * `takeObserved`, `abandon` — because it *is* the same seam. The embedded Freya Browser and
 * the paired Chrome extension are two implementations of one port, which is the structural
 * statement that there is one browser authority and two doors.
 */
export interface BrowserAdapterPort {
  begin(sessionId: string, actionId: string, context: BrowserActionContext): void
  performBrowser(request: BrowserPortRequest): Promise<BrowserPortOutcome>
  /** Read back and discard. Read once, after the verdict, never before. */
  takeObserved(actionId: string): unknown
  abandon(actionId: string): void
}