import { canonicalDigest } from '../devicehands'
import { BROWSER_LIMITS, type BrowserHandoffState, type BrowserRefusalCode, type BrowserTarget } from './types'
import { HANDOFF_CONTEXT_KEYS, assertCredentialFree, boundHandoffText } from './isolation'

/**
 * The handoff: moving a *piece of work* from one browser context to the other.
 *
 * ## What a handoff is
 *
 * A URL, a reason, a title, an optional note, and a freshness window. That is the entire
 * payload, and it is a closed list rather than a filter — a field that is not named here
 * cannot be added by a caller that tries.
 *
 * ## What a handoff is not
 *
 * It is not a way to make the two browsers one. It carries no cookie, no header, no token,
 * no form value, no storage dump and no page text, and {@link assertCredentialFree} is run
 * over the whole envelope — keys, values and key=value pairs — because "the two contexts
 * are separate" is the only reason this phase has two browsers instead of one that
 * impersonates the other.
 *
 * ## Direction, and why each direction is different
 *
 * `public → authenticated` is the interesting one: Freya found something publicly and the
 * person needs to finish with their own session. It is refused unless the extension is
 * paired and live, because there is nowhere for it to arrive otherwise.
 *
 * `authenticated → public` is the trust *downhill* direction, and it is deliberately
 * narrower: a page the person was signed in to may show Freya's own name, their inbox, a
 * balance, a colleague's name. Routing that back into a context Freya can summarise is a
 * decision the owner has to make, so the envelope carries the URL and nothing else, and
 * the receiving context is a **fresh, empty session** rather than the live tab.
 *
 * ## The restart rule
 *
 * A handoff that was `open` when the process ended is **`uncertain`** after a restart: it
 * is reported, it is never replayed, and accepting it requires a fresh offer. "It probably
 * worked" is the sentence that duplicates a submission, so the runtime is not allowed to
 * say it — see `./recovery`.
 */

/* ------------------------------------------------------------------ the envelope */

export interface HandoffContext {
  /** The visible title of the page. Bounded, credential-scanned. */
  readonly title?: string
  /** A short note from whoever is doing the handoff. Bounded, credential-scanned. */
  readonly note?: string
}

export interface HandoffEnvelope {
  readonly handoffId: string
  readonly from: BrowserTarget
  readonly to: BrowserTarget
  readonly url: string
  readonly reason: string
  readonly context: HandoffContext
  readonly offeredAt: string
  readonly expiresAt: number
  /** A digest over every field above, so a mutated envelope fails to verify. */
  readonly integrity: string
}

export type HandoffReading =
  | { readonly ok: true; readonly envelope: HandoffEnvelope }
  | { readonly ok: false; readonly code: BrowserRefusalCode; readonly reason: string }

const MAX_REASON_CHARS = 200
const MAX_TITLE_BYTES = 512
const MAX_NOTE_BYTES = 512
const HANDOFF_ID_SHAPE = /^[a-z0-9][a-z0-9-]{7,63}$/

/**
 * The digest an envelope is verified against.
 *
 * The integrity digest is over the *whole* envelope except itself, which is what makes
 * "somebody changed the URL after the offer" detectable rather than merely unlikely. It is
 * `canonicalDigest` — two FNV-1a lanes, not a MAC — and it is honest about that: it is
 * there to catch accident and casual mutation, not an attacker who has chosen their
 * bytes. What actually stops an attacker is that a handoff cannot carry a credential at
 * all, so there is nothing worth forging one for.
 */
function envelopeDigest(fields: readonly (string | number)[]): string {
  return canonicalDigest(['freya.browser.handoff', ...fields])
}

/**
 * Build one envelope, or refuse.
 *
 * Every field is untrusted. The order of the checks is the policy: shape first, then
 * credentials, then the closed context list, then the digest — because a refusal about a
 * malformed id is more useful than one about a credential in a payload that should never
 * have got this far.
 */
export function createHandoffEnvelope(input: {
  readonly handoffId: string
  readonly from: BrowserTarget
  readonly to: BrowserTarget
  readonly url: string
  readonly reason: string
  readonly context?: HandoffContext | null
  readonly offeredAt: string
  readonly ttlMs?: number
}): HandoffReading {
  if (typeof input.handoffId !== 'string' || !HANDOFF_ID_SHAPE.test(input.handoffId)) {
    return {
      ok: false,
      code: 'request-malformed',
      reason: 'A handoff id must be 8-64 lowercase letters, digits or hyphens. It is a token in an audit record, not a title.',
    }
  }
  if (input.from === input.to) {
    return {
      ok: false,
      code: 'handoff-target-mismatch',
      reason: 'A handoff moves work between the two browser contexts. An offer from a browser to itself is not a handoff.',
    }
  }
  if (typeof input.url !== 'string' || input.url.length > BROWSER_LIMITS.maxUrlChars) {
    return { ok: false, code: 'url-refused', reason: 'A handoff needs a URL of at most 2048 characters.' }
  }
  if (typeof input.reason !== 'string' || input.reason.trim().length === 0) {
    return { ok: false, code: 'request-malformed', reason: 'A handoff needs a reason a person can read in the audit.' }
  }
  const reason = input.reason.replace(/\s+/gu, ' ').trim().slice(0, MAX_REASON_CHARS)

  // The whole envelope, scanned before anything is derived from it.
  const scanned = assertCredentialFree(
    { url: input.url, reason, context: input.context ?? {} },
    'a handoff envelope',
  )
  if (!scanned.ok) return { ok: false, code: scanned.code, reason: scanned.reason }

  const context: HandoffContext = Object.freeze(readContext(input.context))
  const ttl = input.ttlMs === undefined ? BROWSER_LIMITS.handoffTtlMs : input.ttlMs
  if (typeof ttl !== 'number' || !Number.isFinite(ttl) || ttl <= 0 || ttl > BROWSER_LIMITS.handoffTtlMs) {
    return {
      ok: false,
      code: 'request-malformed',
      reason: `A handoff may live between 1ms and ${String(BROWSER_LIMITS.handoffTtlMs)}ms. The host may narrow it and never widen it.`,
    }
  }
  const offeredAtMs = Date.parse(input.offeredAt)
  if (!Number.isFinite(offeredAtMs)) {
    return { ok: false, code: 'request-malformed', reason: 'A handoff needs a timestamp this build can read.' }
  }

  const expiresAt = offeredAtMs + ttl
  const envelope: HandoffEnvelope = Object.freeze({
    handoffId: input.handoffId,
    from: input.from,
    to: input.to,
    url: input.url,
    reason,
    context,
    offeredAt: new Date(offeredAtMs).toISOString(),
    expiresAt,
    integrity: '',
  })
  const withDigest: HandoffEnvelope = Object.freeze({
    ...envelope,
    integrity: envelopeDigest([
      envelope.handoffId,
      envelope.from,
      envelope.to,
      envelope.url,
      envelope.reason,
      envelope.context.title ?? '',
      envelope.context.note ?? '',
      envelope.offeredAt,
      envelope.expiresAt,
    ]),
  })
  return { ok: true, envelope: withDigest }
}

/**
 * Keep only the two allowed context keys, bounded and scanned.
 *
 * `title` and `note` are the only fields. Anything else is dropped rather than carried,
 * and the value is re-scanned here as well as above because a truncation must not be able
 * to produce a value that the full-value scan would have refused.
 */
function readContext(input: HandoffContext | null | undefined): HandoffContext {
  if (typeof input !== 'object' || input === null) return {}
  const out: { title?: string; note?: string } = {}
  for (const key of HANDOFF_CONTEXT_KEYS) {
    const value = (input as Record<string, unknown>)[key]
    if (value === undefined || value === null) continue
    const bounded = boundHandoffText(value, key === 'title' ? MAX_TITLE_BYTES : MAX_NOTE_BYTES)
    if (!bounded.ok || typeof bounded.text !== 'string' || bounded.text.length === 0) continue
    if (!assertCredentialFree(bounded.text, 'a handoff context field').ok) continue
    out[key as 'title' | 'note'] = bounded.text
  }
  return Object.freeze(out)
}

/* ---------------------------------------------------------------- verification */

export type VerifyReading =
  | { readonly ok: true; readonly envelope: HandoffEnvelope }
  | { readonly ok: false; readonly code: BrowserRefusalCode; readonly reason: string }

/**
 * Is this envelope still an honest offer?
 *
 * Five checks, in this order, and the first one that fails is the answer:
 *
 *   1. **Integrity** — every field still hashes to the digest. Catches a mutated URL, a
 *      swapped target, a forged note.
 *   2. **Target** — it is addressed to the browser asking. Work offered to Chrome is not
 *      accepted by Freya's browser, even by the same Freya.
 *   3. **Freshness** — inside the TTL. An offer from an hour ago is not consent to open a
 *      tab now.
 *   4. **Settlement** — not already consumed, cancelled or expired. Checked against the
 *      ledger rather than against the envelope, because an envelope does not know.
 *   5. **Uncertainty** — not `uncertain`. A handoff whose last outcome is unknown is not
 *      offered for acceptance; it has to be made again.
 */
export function verifyHandoffEnvelope(
  envelope: HandoffEnvelope,
  expectations: {
    readonly to: BrowserTarget
    readonly now: number
    readonly state: BrowserHandoffState
  },
): VerifyReading {
  const recomputed = envelopeDigest([
    envelope.handoffId,
    envelope.from,
    envelope.to,
    envelope.url,
    envelope.reason,
    envelope.context.title ?? '',
    envelope.context.note ?? '',
    envelope.offeredAt,
    envelope.expiresAt,
  ])
  if (recomputed !== envelope.integrity) {
    return {
      ok: false,
      code: 'request-malformed',
      reason: 'That handoff envelope does not match its own integrity digest, so one of its fields was changed after it was offered. It is not acted on.',
    }
  }
  if (envelope.to !== expectations.to) {
    return {
      ok: false,
      code: 'handoff-target-mismatch',
      reason: `That handoff was offered to the ${envelope.to} browser. Freya does not carry work into a context it was not offered to.`,
    }
  }
  if (expectations.now > envelope.expiresAt) {
    return {
      ok: false,
      code: 'handoff-expired',
      reason: 'That handoff is older than this build will act on. Offer it again if it is still wanted.',
    }
  }
  if (expectations.state === 'uncertain') {
    return {
      ok: false,
      code: 'handoff-uncertain',
      reason: 'The last run ended before we could record whether that handoff was used. It is not being retried automatically; decide again deliberately.',
    }
  }
  if (expectations.state !== 'open') {
    return {
      ok: false,
      code: 'handoff-already-settled',
      reason: `That handoff is already ${expectations.state}. A settled handoff is never acted on twice.`,
    }
  }
  return { ok: true, envelope }
}

/* -------------------------------------------------------------------- ledger */

/**
 * The durable record of what was offered and what happened to it.
 *
 * A fold over journal entries, in the same shape as `core/devicehands/state.ts`, because
 * the same rule applies: **every derived fact comes from the record**, and a handoff whose
 * state is remembered rather than replayed is a handoff that will be replayed after a
 * restart.
 *
 * The transition table is four entries and they are the whole state machine:
 *
 * ```
 *   (none) ──offered──▶ open ──consumed──▶ consumed
 *                         ├────cancelled──▶ cancelled
 *                         ├────expired────▶ expired
 *                         └────end-of-run──▶ uncertain
 * ```
 *
 * Note the last row: `open` at the end of a run becomes `uncertain`, and `uncertain` has no
 * outgoing edge. That is the phase's restart rule expressed as a table, and
 * `auditHandoffLedger` fails if a row is ever added to the first three without deciding what
 * happens to the fourth.
 */
export interface HandoffRecord {
  readonly handoffId: string
  readonly from: BrowserTarget
  readonly to: BrowserTarget
  readonly state: BrowserHandoffState
  readonly url: string
  readonly offeredAt: string
  readonly settledAt: string | null
  readonly digest: string
}

/**
 * One handoff entry, in the shape the journal stores: a type and a flat scalar payload.
 *
 * The **same shape as every other entry in the record**, because this fold reads the same
 * file as `core/devicehands/state.ts` and `core/browser/state.ts`. A fold that only
 * understood its own private object shape would quietly see an empty history on a restart,
 * which is exactly the failure this phase exists to prevent.
 */
export type HandoffTransition =
  | { readonly type: 'browser.dual.handoff.offered'; readonly payload: Readonly<Record<string, string>> }
  | { readonly type: 'browser.dual.handoff.consumed'; readonly payload: Readonly<Record<string, string>> }
  | { readonly type: 'browser.dual.handoff.settled'; readonly payload: Readonly<Record<string, string>> }
  | { readonly type: 'browser.dual.handoff.uncertain'; readonly payload: Readonly<Record<string, string>> }

const HANDOFF_TYPES = [
  'browser.dual.handoff.offered',
  'browser.dual.handoff.consumed',
  'browser.dual.handoff.settled',
  'browser.dual.handoff.uncertain',
] as const

export function isHandoffTransition(value: unknown): value is HandoffTransition {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const type = (value as { type?: unknown }).type
  if (typeof type !== 'string' || !(HANDOFF_TYPES as readonly string[]).includes(type)) return false
  const payload = (value as { payload?: unknown }).payload
  return typeof payload === 'object' && payload !== null && !Array.isArray(payload)
}

/** The handoff id an entry names, or null when it does not name one. */
function idOf(entry: HandoffTransition): string | null {
  const value = entry.payload.handoffId
  return typeof value === 'string' && value.length > 0 ? value : null
}

function textOf(entry: HandoffTransition, key: string): string {
  const value = entry.payload[key]
  return typeof value === 'string' ? value : ''
}

const SETTLED: ReadonlySet<BrowserHandoffState> = new Set(['consumed', 'cancelled', 'expired'])

export interface HandoffLedgerState {
  readonly handoffs: ReadonlyMap<string, HandoffRecord>
  /** Ids whose outcome the record never settled. */
  readonly uncertain: readonly string[]
}

export const EMPTY_HANDOFF_LEDGER: HandoffLedgerState = Object.freeze({
  handoffs: new Map(),
  uncertain: Object.freeze([]),
})

function summarise(handoffs: ReadonlyMap<string, HandoffRecord>): HandoffLedgerState {
  return Object.freeze({
    handoffs: Object.freeze(handoffs) as ReadonlyMap<string, HandoffRecord>,
    uncertain: Object.freeze(
      [...handoffs.values()]
        .filter((record) => record.state === 'uncertain')
        .map((record) => record.handoffId)
        .sort(),
    ),
  })
}

/**
 * Fold a handoff record.
 *
 * Total, pure and **incremental**: an offer stays `open` until something settles it. The
 * "a run that ended with an open offer leaves it uncertain" rule is *not* applied here,
 * because a fold cannot tell the difference between "the record so far" and "the record is
 * finished". {@link settleUnfinished} is what knows that, and it is called once — on open,
 * and by the recovery report.
 *
 * Unknown entry types are ignored rather than throwing, because the journal this folds also
 * holds `hands.*` and `browser.dual.page.*` entries that are not handoffs and that this
 * module has no opinion about. An entry for an unknown handoff id is also ignored: a
 * `consumed` for something that was never offered is not a fact.
 */
export function foldHandoffs(entries: readonly unknown[], previous: HandoffLedgerState = EMPTY_HANDOFF_LEDGER): HandoffLedgerState {
  const handoffs = new Map(previous.handoffs)
  for (const entry of entries) {
    if (!isHandoffTransition(entry)) continue
    const handoffId = idOf(entry)
    if (handoffId === null) continue
    const existing = handoffs.get(handoffId)
    switch (entry.type) {
      case 'browser.dual.handoff.offered': {
        const from = textOf(entry, 'from')
        const to = textOf(entry, 'to')
        if (from !== 'public' && from !== 'authenticated') continue
        if (to !== 'public' && to !== 'authenticated') continue
        // A re-offer of an id that is already settled is not a new offer. Refusing to
        // overwrite it is what stops a retry from un-consuming a handoff.
        if (existing !== undefined && SETTLED.has(existing.state)) continue
        handoffs.set(handoffId, {
          handoffId,
          from,
          to,
          state: 'open',
          url: textOf(entry, 'url'),
          offeredAt: textOf(entry, 'at'),
          settledAt: null,
          digest: textOf(entry, 'digest'),
        })
        continue
      }
      case 'browser.dual.handoff.consumed': {
        if (existing === undefined || existing.state !== 'open') continue
        handoffs.set(handoffId, { ...existing, state: 'consumed', settledAt: textOf(entry, 'at') })
        continue
      }
      case 'browser.dual.handoff.settled': {
        if (existing === undefined || existing.state !== 'open') continue
        const state = textOf(entry, 'state')
        if (state !== 'cancelled' && state !== 'expired') continue
        handoffs.set(handoffId, { ...existing, state, settledAt: textOf(entry, 'at') })
        continue
      }
      case 'browser.dual.handoff.uncertain': {
        if (existing === undefined) continue
        handoffs.set(handoffId, { ...existing, state: 'uncertain', settledAt: textOf(entry, 'at') })
        continue
      }
    }
  }
  return summarise(handoffs)
}

/**
 * Mark every offer that a run left open as **uncertain**.
 *
 * The phase's restart rule, in one function and one place. Not because anything went wrong,
 * but because nobody wrote down what happened, and "nobody wrote it down" is not "it did not
 * happen".
 *
 * `uncertain` has no outgoing edge in the transition table: such a handoff is never consumed,
 * never cancelled and never retried. It has to be offered again on purpose.
 */
export function settleUnfinished(ledger: HandoffLedgerState): HandoffLedgerState {
  const handoffs = new Map(ledger.handoffs)
  for (const [id, record] of handoffs) {
    if (record.state !== 'open') continue
    handoffs.set(id, { ...record, state: 'uncertain', settledAt: null })
  }
  return summarise(handoffs)
}

/** Mark one open handoff uncertain, as an event, without deciding anything about it. */
export function uncertainTransition(handoffId: string, at: string): HandoffTransition {
  return { type: 'browser.dual.handoff.uncertain', payload: { handoffId, at } }
}

/* -------------------------------------------------------------------- audits */

/**
 * Structural audits over this module. Never used by production code.
 */
export function auditHandoffLedger(): readonly string[] {
  const findings: string[] = []

  // An envelope's integrity digest must change if any single field changes. If it did not,
  // "somebody changed the URL after the offer" would be undetectable.
  const base = {
    handoffId: 'handoff-0001',
    from: 'public' as BrowserTarget,
    to: 'authenticated' as BrowserTarget,
    reason: 'the page is a sign-in wall',
    offeredAt: '2026-01-01T00:00:00.000Z',
    context: { title: 'Example', note: '' },
  }
  const original = createHandoffEnvelope({ ...base, url: 'https://example.com/a' })
  if (!original.ok) {
    findings.push('A well-formed handoff envelope was refused.')
    return findings
  }
  const urlChange = createHandoffEnvelope({ ...base, url: 'https://example.com/b' })
  if (urlChange.ok && urlChange.envelope.integrity === original.envelope.integrity) {
    findings.push('Changing the URL did not change the integrity digest.')
  }
  const reasonChange = createHandoffEnvelope({ ...base, url: 'https://example.com/a', reason: 'a different reason' })
  if (reasonChange.ok && reasonChange.envelope.integrity === original.envelope.integrity) {
    findings.push('Changing the reason did not change the integrity digest.')
  }
  const swapped = createHandoffEnvelope({
    ...base,
    from: 'authenticated',
    to: 'public',
    url: 'https://example.com/a',
  })
  if (swapped.ok && swapped.envelope.integrity === original.envelope.integrity) {
    findings.push('Swapping the direction did not change the integrity digest.')
  }

  // An envelope must never be able to carry a credential, whatever the key is called.
  for (const context of [
    { cookies: 'session=abc' },
    { note: 'Authorization: Bearer abcdefghijklmnop' },
    { title: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefgh' },
    { note: '__Secure-sid=1' },
  ]) {
    const attempt = createHandoffEnvelope({
      ...base,
      url: 'https://example.com/a',
      context: context as HandoffContext,
    })
    if (attempt.ok) findings.push(`A handoff carried ${JSON.stringify(Object.keys(context)[0])} and was accepted.`)
  }

  // An envelope addressed to one browser must not verify for the other.
  const verified = verifyHandoffEnvelope(original.envelope, {
    to: 'authenticated',
    now: Date.parse(base.offeredAt) + 1_000,
    state: 'open',
  })
  if (!verified.ok) findings.push('A fresh handoff offered to Chrome failed to verify.')
  const wrongTarget = verifyHandoffEnvelope(original.envelope, {
    to: 'public',
    now: Date.parse(base.offeredAt) + 1_000,
    state: 'open',
  })
  if (wrongTarget.ok || wrongTarget.code !== 'handoff-target-mismatch') {
    findings.push('A handoff verified for the browser it was not offered to.')
  }
  const expired = verifyHandoffEnvelope(original.envelope, {
    to: 'authenticated',
    now: original.envelope.expiresAt + 1,
    state: 'open',
  })
  if (expired.ok || expired.code !== 'handoff-expired') findings.push('An expired handoff verified.')

  // The restart rule, re-derived from the fold rather than trusted.
  const offered: HandoffTransition = {
    type: 'browser.dual.handoff.offered',
    payload: {
      handoffId: 'handoff-0002',
      from: 'public',
      to: 'authenticated',
      url: 'https://example.com/a',
      digest: 'digest-1',
      at: base.offeredAt,
    },
  }
  const consumedEntry: HandoffTransition = {
    type: 'browser.dual.handoff.consumed',
    payload: { handoffId: 'handoff-0002', at: base.offeredAt },
  }
  const afterOffer = foldHandoffs([offered])
  if (afterOffer.handoffs.get('handoff-0002')?.state !== 'open') {
    findings.push('An offer did not stay open within the run that made it.')
  }
  const afterRun = settleUnfinished(afterOffer)
  const record = afterRun.handoffs.get('handoff-0002')
  if (record === undefined) findings.push('An offered handoff did not survive the fold.')
  else if (record.state !== 'uncertain') findings.push(`An open handoff ended as ${record.state} rather than uncertain.`)

  // A consume written in the same run as the offer is honoured; one appended afterwards to a
  // record that already ended is not — that is precisely "replaying an uncertain effect".
  const inRun = settleUnfinished(foldHandoffs([offered, consumedEntry]))
  if (inRun.handoffs.get('handoff-0002')?.state !== 'consumed') {
    findings.push('A consume written in the same run as the offer was not honoured.')
  }
  const revived = foldHandoffs([consumedEntry], afterRun)
  if (revived.handoffs.get('handoff-0002')?.state !== 'uncertain') {
    findings.push('A consume entry revived an uncertain handoff on replay.')
  }
  const consumed = foldHandoffs([offered, consumedEntry])
  if (settleUnfinished(consumed).handoffs.get('handoff-0002')?.state !== 'consumed') {
    findings.push('A consumed handoff did not stay consumed.')
  }
  const reOffered = foldHandoffs([offered], consumed)
  if (reOffered.handoffs.get('handoff-0002')?.state !== 'consumed') {
    findings.push('A re-offer un-consumed a settled handoff.')
  }

  return findings
}