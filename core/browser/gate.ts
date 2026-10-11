import type { DeviceHandsActionKey } from '../devicehands'
import type {
  AuthorityVerdict,
  BrowserAdapterPort,
  BrowserAuthorityPort,
  BrowserObservation,
  BrowserPayload,
} from './ports'
import type { BrowserCommand, BrowserEventType, BrowserTarget } from './types'

/** The runtime and gate share these leaf port shapes. */
export type { AuthorityVerdict, BrowserAdapterPort, BrowserAuthorityPort, BrowserObservation, BrowserPayload }

/**
 * The one gate walk, shared.
 *
 * ## Why this is its own file
 *
 * Two layers need to reach a page under authority:
 *
 *   - the Phase 51 dual-browser runtime, which drives a session through the routed command
 *     vocabulary in `../types.ts`;
 *   - the Browser Service in `./service`, which drives a *tab* through the Semantic Browser
 *     Protocol.
 *
 * Both must walk the same ten Device Hands gates, against the same adapter, recording into
 * the same journal, and reading the adapter's observation only when a gate passed. Writing
 * that walk twice is how a second, weaker gate chain appears — the exact failure this
 * architecture has been built to avoid since the beginning. So it is written once, here, and
 * both callers supply ports.
 *
 * ## The order is the whole point
 *
 * `begin` before the action, so the adapter knows which command it is serving and which
 * session it belongs to. `perform` through the gates. `takeObserved` **only** on a `passed`
 * verdict. `abandon` in `finally`, so a refused or failed action cannot leave an
 * observation lying around for a later action id to find.
 *
 * The two refusals are kept apart on purpose. `authority-refused` means "Device Hands would
 * not let this happen"; `adapter-failed` means "Device Hands allowed it and the page did not
 * do it". Collapsing them would put "Core would not let me" in the audit for a page that
 * simply did not move, and would hide which of the two a caller should retry.
 */

export interface GateDeps {
  readonly adapter: BrowserAdapterPort
  readonly authority: BrowserAuthorityPort
  /** Append to the shared hash-chained journal. Must not throw. */
  readonly record: (type: BrowserEventType, payload: BrowserPayload) => Promise<void>
  /** Fold the same entry into the folded state, so projection and journal cannot disagree. */
  readonly fold: (type: BrowserEventType, payload: BrowserPayload) => void
  readonly newId: () => string
  readonly nowIso: () => string
  readonly clock: () => number
  readonly principalId: string
}

export interface GatedActionInput {
  readonly sessionId: string
  readonly target: BrowserTarget
  /**
   * Which routed command the adapter should believe it is serving.
   *
   * The adapter reads the command off the context to decide which page operation to drive,
   * so this must name a real command. It is also what lands in the journal, which is why a
   * caller with a different vocabulary maps onto one of these rather than inventing a name.
   */
  readonly command: BrowserCommand
  readonly actionKey: DeviceHandsActionKey
  readonly actionInput: Readonly<Record<string, unknown>>
  readonly deadlineMs: number
  /** The principal to perform under. Defaults to the runtime's own. */
  readonly executionPrincipal?: string
  /** The command's own refusal code, used when a gate refuses. Defaults to authority-refused. */
  readonly refusalCommand?: BrowserCommand
}

export type GateOutcome =
  | { readonly refused: true; readonly code: string; readonly reason: string }
  | { readonly refused: false; readonly observation: BrowserObservation }

/**
 * Coerce whatever the adapter stashed into an observation.
 *
 * Null for anything malformed rather than a partial observation. A revision that is not a
 * non-negative integer is not a revision, and handing one to a caller would let a reference
 * be minted against a counter that cannot be compared.
 */
export function readObservation(value: unknown): BrowserObservation | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const revision = record.revision
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0) return null
  const url = record.url
  if (url !== null && typeof url !== 'string') return null
  return {
    revision,
    url: typeof url === 'string' ? url : null,
    ...(typeof record.title === 'string' ? { title: record.title } : {}),
    ...(record.elements === undefined ? {} : { elements: record.elements }),
    ...(typeof record.text === 'string' ? { text: record.text } : {}),
    ...(typeof record.changed === 'boolean' ? { changed: record.changed } : {}),
    ...(typeof record.fieldValue === 'string' ? { fieldValue: record.fieldValue } : {}),
  }
}

/**
 * Move a session to the revision the page just reported, and record it.
 *
 * Extracted because both callers need it and because the empty-URL bug lived in exactly
 * this line: `observation.url ?? ''` turned "the page did not report where it landed" into
 * "the page landed at the empty address", which then folded into state as a `ready` session
 * with an empty URL, which the renderer adopted as a tab, which rendered blank.
 *
 * **A revision is only adopted when it comes with a navigable address.** A revision that
 * moves with no address is not a new page — it is an observation of nothing, and it is
 * refused here rather than recorded. The session stays where it was, still `absent` or
 * still `ready`, and the caller hears `adapter-failed`.
 */
export function adoptObservedRevision(
  input: {
    readonly sessionId: string
    readonly observation: BrowserObservation
    readonly currentRevision: number
    readonly maxUrlChars: number
    readonly navigable: (candidate: string) => boolean
  },
  deps: {
    readonly record: (type: BrowserEventType, payload: BrowserPayload) => Promise<void>
    readonly fold: (type: BrowserEventType, payload: BrowserPayload) => void
    readonly nowIso: () => string
  },
): { readonly ok: true; readonly revision: number } | { readonly ok: false; readonly reason: string } {
  const observed = input.observation.url
  if (observed === null || observed.trim() === '') {
    return {
      ok: false,
      reason: 'The Freya Browser did not report where it ended up, so the page is not claimed as loaded and no revision was advanced.',
    }
  }
  if (!input.navigable(observed)) {
    return {
      ok: false,
      reason: 'The Freya Browser reported an address Freya cannot navigate to, so the page is not claimed as loaded.',
    }
  }
  const revision = Math.max(input.currentRevision, input.observation.revision)
  if (revision <= input.currentRevision) return { ok: true, revision: input.currentRevision }
  const url = observed.slice(0, input.maxUrlChars)
  const payload: BrowserPayload = { sessionId: input.sessionId, revision, url, at: deps.nowIso() }
  void deps.record('browser.dual.page.replaced', payload)
  deps.fold('browser.dual.page.replaced', payload)
  return { ok: true, revision }
}

/**
 * Run one Device Hands action and read the adapter's observation only if it passed.
 *
 * @see The module comment for why the order is load-bearing.
 */
export async function runGatedBrowserAction(deps: GateDeps, input: GatedActionInput): Promise<GateOutcome> {
  const actionId = deps.newId()
  const at = deps.nowIso()
  const deadlineAt = new Date(deps.clock() + input.deadlineMs).toISOString()

  // The adapter learns which command it is serving from the context set below. Phase 35's
  // `BrowserPortRequest` is assembled downstream, once every gate has passed, so this walk
  // carries only the intent: the address, the locator and the text the policy will read.
  deps.adapter.begin(input.sessionId, actionId, {
    sessionId: input.sessionId,
    target: input.target,
    command: input.command,
    deadlineAt,
  })
  try {
    const verdict: AuthorityVerdict = await deps.authority.perform({
      actionId,
      principalId: input.executionPrincipal ?? deps.principalId,
      scope: input.sessionId,
      actionKey: input.actionKey,
      input: input.actionInput,
      at,
      deadlineAt,
    })
    if (!verdict.performed) {
      return {
        refused: true,
        code: 'authority-refused',
        reason: `Device Hands refused this action (${verdict.code ?? verdict.verdict}): ${verdict.reason}`,
      }
    }
    if (verdict.verdict !== 'passed') {
      return {
        refused: true,
        code: 'adapter-failed',
        reason: `Device Hands authorised this action but the browser did not carry it out (${verdict.code ?? verdict.verdict}): ${verdict.reason}`,
      }
    }
    const observation = readObservation(deps.adapter.takeObserved(actionId))
    if (observation === null) {
      // `passed` with nothing to report is a contradiction. Reporting it as a failure is the
      // safe reading: nothing is claimed that was not observed.
      return {
        refused: true,
        code: 'adapter-failed',
        reason: 'The browser action was authorised but reported nothing about the page, so nothing is claimed about what happened.',
      }
    }
    return { refused: false, observation }
  } finally {
    try {
      deps.adapter.abandon(actionId)
    } catch {
      // An adapter that cannot forget an action id is a leak, not a refusal: the id is
      // time-bounded in every implementation, and refusing here would turn a housekeeping
      // failure into "the browser is broken".
    }
  }
}

/** Narrow an adapter outcome to whether the page did the thing. Never throws. */
export function outcomeHeld(outcome: { readonly holds: boolean } | null): boolean {
  return outcome !== null && outcome.holds === true
}
