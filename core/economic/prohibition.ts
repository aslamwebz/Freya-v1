import {
  FORBIDDEN_ECONOMIC_PAYLOAD_KEYS,
  type EconomicRefusalCode,
  type EconomicRefusalSubject,
} from './types'

/**
 * The prohibition module.
 *
 * Phase 32's central promise is a negative one — *no real money, no real spending, no
 * real financial transactions* — and a negative promise is only worth the shape of the
 * thing that enforces it. Two mechanisms do the work here, and they are deliberately
 * of different kinds so that neither is the only line of defence:
 *
 * 1. **There is no vocabulary for it.** No type in `types.ts` has a field for a venue,
 *    a broker, an account, a wallet, a custody relationship, a withdrawal or a
 *    deposit. `PaperOrder` is a record in a fold. There is nothing to fill in.
 *
 * 2. **Untrusted input is scanned anyway.** A caller can always write an object
 *    literal, and a future lane will eventually try to thread one through. So every
 *    externally-supplied object that reaches this subsystem is walked by
 *    {@link classifyEconomicClaim}, which turns the shapes that would have carried a
 *    real-money action into a closed refusal code before anything else looks at them.
 *
 * The second is not defence in depth for its own sake. It is what turns "the type says
 * so" into "a test can prove it": `classifyEconomicClaim` is a pure function over a
 * hostile object, so the red-team suite can hand it a hundred forged requests and get a
 * hundred closed codes back without a running system, and the assertion scan can prove
 * the same thing a posteriori over a journal.
 *
 * The scan is **structural, never lexical**. It matches key names and the value shapes
 * under them; it never greps a string for a venue name or an amount. Grepping prose is
 * the obvious way to spot "place a live order" and it is the wrong one: it is defeated
 * by a rephrasing, it produces false positives on a research note that happens to
 * discuss brokers, and it would put an unbounded amount of untrusted text through a
 * hot path. A key called `live` is a claim about reality; a sentence containing the word
 * "live" is not.
 */

/* ------------------------------------------------- the simulated values */

/**
 * The only values a simulation-shaped field may carry.
 *
 * Two, and they are the same thing said twice. Anything else under a venue-shaped key
 * is a real venue by the only test available: the field exists to name somewhere for
 * something to be placed, and this subsystem has nowhere.
 */
export const SIMULATED_VENUE_VALUES: ReadonlySet<string> = new Set(['simulation', 'simulated', 'paper'])

/* ------------------------------------------------------ prohibited keys */

/**
 * Every authority- and real-money-shaped key, and the refusal it earns.
 *
 * A table rather than a set, because "refused" is not one answer: an owner reading the
 * journal needs to be able to tell "you tried to claim a capability" from "you tried to
 * place a real order", and a single generic refusal would flatten exactly the
 * distinction they are looking for.
 *
 * The authority half and the real-money half are drawn from the same
 * `FORBIDDEN_ECONOMIC_PAYLOAD_KEYS` set the journal rule uses, so the two can never
 * drift: a key that may not be written to the journal is a key that is refused at the
 * door.
 */
const CLAIM_REFUSALS: Readonly<Record<string, EconomicRefusalCode>> = Object.freeze({
  // --- authority escalation: the claim about what this subsystem may do ---
  capability: 'capability-widening-prohibited',
  capabilities: 'capability-widening-prohibited',
  authority: 'authority-claim-prohibited',
  grant: 'grant-creation-prohibited',
  grantId: 'grant-creation-prohibited',
  verdict: 'authority-claim-prohibited',
  allowed: 'authority-claim-prohibited',
  approved: 'self-approval-prohibited',
  approvalId: 'self-approval-prohibited',
  principal: 'authority-claim-prohibited',
  actor: 'authority-claim-prohibited',
  priority: 'priority-escalation-prohibited',
  budget: 'budget-widening-prohibited',
  spend: 'spending-authority-prohibited',
  spendingAuthority: 'spending-authority-prohibited',

  // --- real money: the claim about where simulated things actually go ---
  venue: 'real-order-prohibited',
  broker: 'real-order-prohibited',
  brokerage: 'real-order-prohibited',
  exchange: 'real-order-prohibited',
  account: 'real-money-prohibited',
  accountId: 'real-money-prohibited',
  wallet: 'real-money-prohibited',
  custodian: 'real-money-prohibited',
  capital: 'real-money-prohibited',
  notional: 'real-money-prohibited',
  withdrawal: 'real-money-prohibited',
  deposit: 'real-money-prohibited',
  currencyPair: 'real-money-prohibited',
  live: 'real-money-prohibited',
  realMoney: 'real-money-prohibited',
  realOrder: 'real-order-prohibited',
})

/** Keys whose *truthiness* is the claim, rather than their presence. */
const TRUTHY_CLAIM_KEYS: Readonly<Record<string, EconomicRefusalCode>> = Object.freeze({
  live: 'real-money-prohibited',
  realMoney: 'real-money-prohibited',
  realOrder: 'real-order-prohibited',
  allowed: 'authority-claim-prohibited',
  approved: 'self-approval-prohibited',
})

/**
 * Keys under which a positive finite number is the claim.
 *
 * `capital: 0` is not a transfer of anything and is refused too, on purpose: a
 * `capital` field is a claim about funding, and this subsystem is funded with nothing.
 * Refusing only the positive case would leave a shape that a caller could grow into
 * one.
 */
const NUMERIC_CLAIM_KEYS: ReadonlySet<string> = new Set([
  'capital',
  'notional',
  'withdrawal',
  'deposit',
])

/** Keys under which a venue-shaped string is the claim. */
const VENUE_CLAIM_KEYS: ReadonlySet<string> = new Set([
  'venue',
  'broker',
  'brokerage',
  'exchange',
  'custodian',
  'account',
  'accountId',
  'wallet',
  'currencyPair',
])

/** How deep the walk goes. A bound, like everything else here. */
const MAX_SCAN_DEPTH = 4

/** How many keys one object contributes to a verdict. */
const MAX_SCAN_KEYS = 64

/* ------------------------------------------------------------ classify */

/** What a scan found, or that it found nothing. */
export type EconomicClaimScan =
  | { readonly prohibited: false }
  | {
      readonly prohibited: true
      readonly code: EconomicRefusalCode
      /** The closed kind of thing the claim was attached to. Never the value. */
      readonly subject: EconomicRefusalSubject
      /** A fixed sentence. Never the offending key's value, and never the key itself. */
      readonly reason: string
    }

/**
 * Refuse a claim outright, with the sentence that belongs to it.
 *
 * The sentences are fixed per code and exported, so the host, the projection and the
 * tests quote the same words rather than paraphrasing a refusal into five slightly
 * different claims. There is deliberately no sentence that interpolates anything the
 * caller supplied — a refusal that echoed the request would put attacker-controlled
 * text into an owner-visible surface, which is the oldest mistake in this trade.
 */
export const REFUSAL_REASONS: Readonly<Record<EconomicRefusalCode, string>> = Object.freeze({
  'journal-not-trustworthy': 'The journal cannot be believed, so nothing new is acted on.',
  'stop-all-active': 'Freya is stopped, and nothing economic happens while she is.',
  'economic-disabled': 'Economic Intelligence is switched off, so nothing economic is acted on.',
  'guard-denied': 'The Guard did not permit that, so it was not done.',
  'governor-denied': 'The Governor did not authorize that, so it was not done.',
  'budget-exhausted': 'There was nothing left to spend, so nothing more was done.',
  'approval-required': 'That needs the owner to agree to it first.',
  'attempt-ceiling-reached': 'That has been tried as many times as it is allowed.',
  'unknown-experiment': 'There is no such experiment.',
  'experiment-terminal': 'That experiment has already finished.',
  'experiment-kind-mismatch': 'That is not something this kind of experiment does.',
  'experiment-cap-reached': 'That experiment has as many of those as it is allowed.',
  'order-cap-reached': 'That experiment has as many simulated orders as it is allowed.',
  'position-cap-reached': 'That experiment has as many open positions as it is allowed.',
  'missing-title': 'An experiment needs a title the owner can recognise.',
  'missing-question': 'An experiment needs a question, or there is nothing to research.',
  'invalid-created-at': 'That experiment had no readable starting moment.',
  'deadline-before-start': 'That deadline was already in the past when the experiment began.',
  'deadline-over-long': 'That deadline was further out than an experiment is allowed to run.',
  'unauthorized-evidence-source': 'That is not an authorized source of evidence.',
  'missing-citation': 'Evidence without a citation is not evidence.',
  'invalid-citation': 'That citation was not readable as a citation.',
  'missing-source-ref': 'Evidence must say which reading of the source it came from.',
  'missing-claim': 'Evidence must say what it is about, or a conflict cannot be found.',
  'invalid-observed-at': 'That observation had no readable moment in time.',
  'citation-over-long': 'That citation was longer than a citation is allowed to be.',
  'title-over-long': 'That title was longer than a title is allowed to be.',
  'question-over-long': 'That question was longer than a question is allowed to be.',
  'criteria-empty': 'An experiment with no completion criteria cannot be finished.',
  'criteria-over-long': 'That experiment named more completion criteria than it may.',
  'criterion-over-long': 'That completion criterion was longer than a criterion is allowed to be.',
  'criterion-malformed':
    'A completion criterion is a key like "peer-reviewed-demand", not a sentence. Anything else could not be matched against evidence.',
  'criterion-duplicate': 'That completion criterion was named twice.',
  'duplicate-evidence': 'That evidence has already been recorded.',
  'invalid-symbol': 'That is not a symbol this subsystem will trade.',
  'invalid-quantity': 'That quantity is not a quantity a simulated order may carry.',
  'invalid-price': 'That price is not a price a simulated order may carry.',
  'invalid-side': 'A simulated order is a buy or a sell, and this was neither.',
  'invalid-strategy': 'That is not a strategy this subsystem knows how to run.',
  'invalid-parameters': 'Those simulation parameters are not usable.',
  'invalid-series': 'That price series is not usable.',
  'insufficient-series': 'There were not enough observations to run that.',
  'real-money-prohibited':
    'Economic Intelligence has no access to real money, and no field in it could name any.',
  'real-order-prohibited':
    'Economic Intelligence places simulated orders only. There is no real venue to place one at.',
  'spending-authority-prohibited':
    'Economic Intelligence holds no spending authority and cannot be given any.',
  'capability-widening-prohibited':
    'A capability is widened by the Guard and by nobody else. A claim to one is data.',
  'grant-creation-prohibited': 'Only the owner creates grants, and an experiment is not the owner.',
  'self-approval-prohibited': 'The economic subsystem cannot approve its own requests.',
  'priority-escalation-prohibited':
    'Priority is derived from the experiment itself, never from a claim about it.',
  'budget-widening-prohibited': 'A budget comes from durable state, never from a claim about it.',
  'authority-claim-prohibited': 'An experiment cannot grant itself authority.',
  'polling-prohibited':
    'A wake names an experiment with a deadline. It is not a licence to go looking.',
  'inference-without-wake-prohibited':
    'Nothing is thought about without a wake that names what is being thought about.',
  'state-fabrication-prohibited': 'Economic state is derived from the journal and is never written by hand.',
  'silent-resume-prohibited': 'An interrupted experiment is reconciled in the open, never resumed quietly.',
  'wake-not-authorized': 'That wake did not come from a source allowed to raise one.',
})

/** The closed subject each refusal is about, so the journal never has to guess. */
const REFUSAL_SUBJECTS: Readonly<Record<EconomicRefusalCode, EconomicRefusalSubject>> = Object.freeze({
  'journal-not-trustworthy': 'boundary',
  'stop-all-active': 'boundary',
  'economic-disabled': 'boundary',
  'guard-denied': 'boundary',
  'governor-denied': 'boundary',
  'budget-exhausted': 'boundary',
  'approval-required': 'boundary',
  'attempt-ceiling-reached': 'claim',
  'unknown-experiment': 'experiment',
  'experiment-terminal': 'experiment',
  'experiment-kind-mismatch': 'experiment',
  'experiment-cap-reached': 'experiment',
  'order-cap-reached': 'order',
  'position-cap-reached': 'order',
  'missing-title': 'experiment',
  'missing-question': 'experiment',
  'invalid-created-at': 'experiment',
  'deadline-before-start': 'experiment',
  'deadline-over-long': 'experiment',
  'unauthorized-evidence-source': 'evidence',
  'missing-citation': 'evidence',
  'invalid-citation': 'evidence',
  'missing-source-ref': 'evidence',
  'missing-claim': 'evidence',
  'invalid-observed-at': 'evidence',
  'citation-over-long': 'evidence',
  'title-over-long': 'experiment',
  'question-over-long': 'experiment',
  'criteria-empty': 'experiment',
  'criteria-over-long': 'experiment',
  'criterion-over-long': 'experiment',
  'criterion-malformed': 'experiment',
  'criterion-duplicate': 'experiment',
  'duplicate-evidence': 'evidence',
  'invalid-symbol': 'order',
  'invalid-quantity': 'order',
  'invalid-price': 'order',
  'invalid-side': 'order',
  'invalid-strategy': 'scenario',
  'invalid-parameters': 'scenario',
  'invalid-series': 'series',
  'insufficient-series': 'series',
  'real-money-prohibited': 'boundary',
  'real-order-prohibited': 'order',
  'spending-authority-prohibited': 'boundary',
  'capability-widening-prohibited': 'claim',
  'grant-creation-prohibited': 'claim',
  'self-approval-prohibited': 'claim',
  'priority-escalation-prohibited': 'claim',
  'budget-widening-prohibited': 'claim',
  'authority-claim-prohibited': 'claim',
  'polling-prohibited': 'wake',
  'inference-without-wake-prohibited': 'wake',
  'state-fabrication-prohibited': 'recovery',
  'silent-resume-prohibited': 'recovery',
  'wake-not-authorized': 'wake',
})

/** The subject a refusal code is about. Never inferred from a caller. */
export function refusalSubject(code: EconomicRefusalCode): EconomicRefusalSubject {
  return REFUSAL_SUBJECTS[code] ?? 'boundary'
}

/**
 * Walk one untrusted object and report the first prohibited claim.
 *
 * Deterministic and total: the same object always yields the same answer, an object
 * with a cycle terminates, and nothing here can throw on a hostile input. Depth and key
 * count are both bounded, and a value nested deeper than the bound is simply not
 * scanned — which is stated rather than hidden, because "we only looked four levels
 * down" is a fact an owner is entitled to.
 *
 * The order of the checks within one key is fixed and matters: presence of a
 * prohibited key is checked before truthiness, and truthiness before the venue and
 * numeric shapes. So `live: true` is `real-money-prohibited` and `venue: 'live'` is
 * `real-order-prohibited`, and a caller cannot choose which by picking a value.
 */
export function classifyEconomicClaim(input: unknown, subject: EconomicRefusalSubject = 'claim'): EconomicClaimScan {
  const seen = new Set<object>()
  return scan(input, subject, 0, seen)
}

function scan(
  input: unknown,
  subject: EconomicRefusalSubject,
  depth: number,
  seen: Set<object>,
): EconomicClaimScan {
  if (depth > MAX_SCAN_DEPTH) return { prohibited: false }
  if (typeof input !== 'object' || input === null) return { prohibited: false }
  if (seen.has(input)) return { prohibited: false }
  seen.add(input)

  const record = input as Record<string, unknown>
  const keys = Object.keys(record).slice(0, MAX_SCAN_KEYS)

  for (const key of keys) {
    const byKey = CLAIM_REFUSALS[key]
    if (byKey !== undefined) {
      // A key that is *present* is the claim, whatever its value. The one exception
      // is a venue-shaped key whose value is one of the simulated spellings, because
      // that is the shape a simulation legitimately carries — and refusing it would
      // make the module lie about its own types, which are full of `venue`-free but
      // honestly-labelled simulation fields.
      if (VENUE_CLAIM_KEYS.has(key) && SIMULATED_VENUE_VALUES.has(String(record[key]).toLowerCase())) {
        continue
      }
      return refusal(byKey, subject)
    }

    const value = record[key]
    const truthy = TRUTHY_CLAIM_KEYS[key]
    if (truthy !== undefined && value === true) return refusal(truthy, subject)

    if (VENUE_CLAIM_KEYS.has(key) && typeof value === 'string' && value.length > 0) {
      if (!SIMULATED_VENUE_VALUES.has(value.toLowerCase())) return refusal('real-order-prohibited', subject)
    }

    if (NUMERIC_CLAIM_KEYS.has(key) && typeof value === 'number' && Number.isFinite(value)) {
      return refusal('real-money-prohibited', subject)
    }

    const nested = scan(value, subject, depth + 1, seen)
    if (nested.prohibited) return nested
  }

  return { prohibited: false }
}

function refusal(code: EconomicRefusalCode, subject: EconomicRefusalSubject): EconomicClaimScan {
  return { prohibited: true, code, subject, reason: REFUSAL_REASONS[code] }
}

/**
 * Does this payload carry anything the journal may not hold?
 *
 * The journal-side twin of {@link classifyEconomicClaim}, and it exists because the
 * journal is reached from somewhere the scanner is not: a hand-edited file, an event
 * written by a lane that does not exist yet, a restored backup. The two agree by
 * construction — the forbidden-key set is the same frozen set — and they report
 * differently on purpose: the scan *refuses*, the fold *records an anomaly*. One is a
 * door and the other is a wall.
 */
export function forbiddenKeysIn(payload: Readonly<Record<string, unknown>>): readonly string[] {
  return Object.keys(payload).filter((key) => FORBIDDEN_ECONOMIC_PAYLOAD_KEYS.has(key))
}

/**
 * The one fact about money this subsystem will assert about itself.
 *
 * Exported as a value rather than a sentence in a comment so that a test, a surface
 * and a release gate can all quote it and so that nobody has to trust that the comment
 * still matches the code.
 */
export const NO_REAL_MONEY_STATEMENT =
  'Economic Intelligence is research, simulation and paper trading only: no real money, no real spending, no real financial transactions.'