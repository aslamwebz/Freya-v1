import { BROWSER_LIMITS } from './types'
import { foldBrowserState, type BrowserRuntimeState } from './state'
import { foldHandoffs, settleUnfinished, type HandoffLedgerState } from './handoff'

/**
 * Restart: what this phase is willing to say about a run that ended without finishing.
 *
 * This file exists because the *effects* a browser can have are not all reversible, and
 * the difference matters between them:
 *
 *   - **Reading** a page changed nothing. A read that was interrupted cost nothing, and
 *     saying so is true.
 *   - **Describing** a page changed nothing either, but the element references it minted
 *     died with the process. Freya reports the count and mints none: an old reference
 *     cannot be revived, because the page it named may not exist any more.
 *   - **Navigating** put a browser somewhere. Nobody wrote down whether it arrived.
 *   - **Clicking** or **typing** may have submitted something. This is the one that
 *     matters, and the answer is the same answer `core/devicehands/recovery.ts` already
 *     gives: `interrupted`, treated as **not done**, never replayed.
 *   - **Accepting a handoff** may have opened a tab in the person's browser, or may not
 *     have. It becomes `uncertain` and is **never retried automatically**.
 *
 * ## The rule this file exists to enforce
 *
 * **An uncertain effect is not replayed, and is not reported as done.** Not by this
 * runtime, not by the host, not by a retry. A retry is a *new* action id with a *new*
 * authority question, exactly as Phase 35 says — and a handoff has to be offered again by
 * whoever wanted it, because "I asked for it twenty minutes ago" is not the same sentence
 * as "do it again".
 *
 * There is no timer here. Nothing can wake itself up and try.
 */

/** One effect that ended without a record of its outcome. */
export interface UncertainEffect {
  readonly kind: 'session' | 'handoff'
  readonly id: string
  /** What is known. Never more than this. */
  readonly known: string
}

export interface BrowserRecoveryReport {
  readonly uncertain: readonly UncertainEffect[]
  /**
   * Sessions that were open when the run ended.
   *
   * Reported rather than reopened. A browser window does not survive its process, so
   * "reopening" it would mean opening a *new* one at the same URL — which is a navigation
   * with side effects on a site that may have changed since.
   */
  readonly sessionsLost: readonly { readonly sessionId: string; readonly url: string | null }[]
  /** References that existed and no longer do. Zero of them are handed back out. */
  readonly referencesRetired: number
  /** Handoffs whose outcome is unknown. Every one of them needs a fresh offer. */
  readonly handoffsUncertain: readonly string[]
  readonly pagesDescribed: number
  readonly refusals: number
  /**
   * Whether the journal could be believed at all.
   *
   * False means this report is about a record nobody has read, and every command is
   * refused before this phase does anything.
   */
  readonly trustworthy: boolean
  /** True when the journal contained no trace of this phase having been open. */
  readonly neverOpened: boolean
  /** The sentence a renderer may show. It never says an uncertain effect succeeded. */
  readonly summary: string
}

/**
 * Read the record and say exactly what it supports.
 *
 * `trustworthy` is a *fact about the journal*, passed in rather than derived, because
 * this module has no business reading a file. `core/devicehands` makes the same split: the
 * fold re-derives the state, and the host is the only thing that knows whether the bytes
 * it read were intact.
 */
export function browserRecoveryReport(input: {
  readonly entries: readonly unknown[]
  readonly trustworthy: boolean
}): BrowserRecoveryReport {
  const browserState: BrowserRuntimeState = foldBrowserState(input.entries)
  // `settleUnfinished` is the restart rule: an offer the record left open had an outcome
  // nobody wrote down, so it is reported as uncertain and never as consumed.
  const ledger: HandoffLedgerState = settleUnfinished(foldHandoffs(input.entries))

  const sessionsLost = [...browserState.sessions.values()]
    .filter((entry) => entry.session === 'open')
    .map((entry) => ({ sessionId: entry.sessionId, url: entry.url }))

  const handoffsUncertain = [...ledger.handoffs.values()]
    .filter((record) => record.state === 'uncertain')
    .map((record) => record.handoffId)
    .sort()

  const uncertain: UncertainEffect[] = [
    ...sessionsLost.map((entry) => ({
      kind: 'session' as const,
      id: entry.sessionId,
      known: entry.url === null
        ? 'The session was open with no page loaded.'
        : `The session was last observed at ${entry.url}.`,
    })),
    ...handoffsUncertain.map((id) => {
      const record = ledger.handoffs.get(id)
      return {
        kind: 'handoff' as const,
        id,
        known: record === undefined ? 'A handoff was offered.' : `Offered from ${record.from} to ${record.to}.`,
      }
    }),
  ]

  const referencesRetired = [...browserState.sessions.values()]
    .filter((entry) => entry.session === 'closed')
    .reduce((total, entry) => total + entry.revision, 0)

  const neverOpened = input.entries.every(
    (entry) =>
      typeof entry !== 'object' ||
      entry === null ||
      (entry as { type?: unknown }).type !== 'browser.dual.session.opened',
  )

  const summary =
    !input.trustworthy
      ? 'The browser journal could not be believed, so nothing was replayed and nothing is claimed.'
      : uncertain.length === 0
        ? 'The last run left nothing uncertain: every session was closed and every handoff settled.'
        : `The last run ended with ${String(uncertain.length)} uncertain effect(s). None of them were replayed; each needs a decision again.`

  return Object.freeze({
    uncertain: Object.freeze(uncertain),
    sessionsLost: Object.freeze(sessionsLost),
    referencesRetired,
    handoffsUncertain: Object.freeze(handoffsUncertain),
    pagesDescribed: browserState.described,
    refusals: browserState.refusals,
    trustworthy: input.trustworthy,
    neverOpened,
    summary,
  })
}

/**
 * Whether anything is waiting for a person.
 *
 * The single question a UI should ask after a restart: is there anything here that will
 * *not* happen unless somebody says so? The answer is yes whenever anything is uncertain,
 * and it is deliberately not answered by "probably fine".
 */
export function recoveryNeedsAttention(report: BrowserRecoveryReport): boolean {
  return report.uncertain.length > 0
}

/**
 * A session id this build will mint next.
 *
 * Deterministic in the id the host supplies, and refused rather than repaired when the id
 * is not a usable token. It exists so the host can name a session without inventing a
 * second identity scheme, and so a test can prove the partition name and the page id are
 * derived from the same token.
 */
export function nextSessionId(sequence: number): string {
  if (!Number.isInteger(sequence) || sequence < 0 || sequence >= BROWSER_LIMITS.maxSessions * 1000) {
    throw new Error('A session sequence must be a non-negative integer inside this build\'s bound.')
  }
  return `freya-${String(sequence).padStart(4, '0')}`
}