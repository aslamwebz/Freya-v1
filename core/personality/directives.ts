/**
 * THE OWNER-DIRECTIVE RECOGNISER — the only production pathway that records
 * something about the relationship.
 *
 * Phase 11 has no `personality.*` command, and that absence is the point: a
 * window may not *claim* that the owner prefers something, because relationship
 * truth is exactly the kind of fact a compromised renderer would most like to
 * assert. So if Core has no way to record a relationship on its own, this
 * domain is a very well-built shelf: nothing would ever be admitted, and every
 * guarantee about what admission means would be untested against the real thing.
 *
 * This module is that missing half, and it is deliberately the smallest honest
 * version of it.
 *
 * ## What it is
 *
 * A **closed table of code-owned patterns** over the owner's own message. An
 * owner who writes an explicit standing instruction about how Freya talks gets
 * that instruction recorded, with `source: 'owner-assertion'`, a provenance
 * pointing at the turn, and the matched clause as the record's text. An owner
 * who writes anything else gets nothing at all — no candidate, no record, no
 * memory.
 *
 * Nothing here is a model, and nothing here can be one: there is no provider, no
 * network, no `await`, and no branch that consults anything but the string it was
 * handed. The whole file is a pure function from text to zero or more
 * *candidate inputs*.
 *
 * ## Why a table and not an understanding
 *
 * Because the alternative is Freya writing down what she thinks the owner meant,
 * and a wrong guess about a person's preferences is worse than no record at all.
 * A closed table can be wrong in one direction only: it misses phrasings it was
 * not given. It cannot invent a preference nobody stated. That asymmetry is the
 * whole design.
 *
 * The patterns are consequently narrow on purpose — an explicit first-person
 * imperative about a *style* dimension, in the second person addressed to Freya.
 * `keep it short from now on` matches. `the last report was too long` does not,
 * because it is a complaint about one artefact rather than a standing
 * instruction, and treating a complaint as a preference is how a system ends up
 * being permanently, wrongly terse.
 *
 * ## Withdrawal is the same table, pointing the other way
 *
 * `forget that you keep it short` is a withdrawal directive, and it maps onto the
 * closed lifecycle label `owner-withdrew-this-record`. Symmetry matters here: an
 * owner who can say a thing must be able to un-say it without a tool, and a
 * system where recording is automatic but forgetting needs a command has given
 * Core more control over the relationship than the owner has.
 *
 * ## What this can never produce
 *
 * - **No authority.** There is no pattern that records a capability, a grant, a
 *   permission or a safety setting, and the produced input has no field shaped
 *   like one — it is the exact key set `createRelationshipCandidate` validates,
 *   and an extra key is refused there.
 * - **No cue.** `cueKind` is always null. A shared shorthand is established by
 *   something other than a single sentence of instruction, and this table has no
 *   opinion about what one is.
 * - **No free text in the record's identity.** `key` is a code-owned slug and
 *   `tags` are code-owned slugs. The owner's clause is stored as `text`, which
 *   is data Core keeps and never renders as guidance.
 * - **No model call.** Reading this file's imports is the proof: there are none
 *   beyond the domain's own tables.
 */

import {
  PERSONALITY_LIMITS,
  type CueKind,
  type RelationshipItemKind,
} from './types'

/**
 * One recognised standing instruction.
 *
 * `key` and `tags` are code-owned slugs; `text` is the clause that actually
 * matched, so the owner can read back what was recorded rather than a
 * paraphrase of it. `expected` names what the record's key should already be
 * present as, which is what makes withdrawal addressable without a fuzzy match.
 */
interface OwnerDirective {
  readonly key: string
  readonly kind: RelationshipItemKind
  readonly tags: readonly string[]
}

/**
 * The closed table. Five standing instructions, three withdrawals.
 *
 * Every entry is a style dimension Freya already has a line in her expression
 * catalogue for, so a recognised directive has somewhere truthful to go: the
 * expression planner reads it as a preference hit and says so in words the model
 * was already primed to honour. Nothing here touches a capability, a capability
 * boundary, a stop, or a disclosure rule.
 */
const STANDING_DIRECTIVES: readonly OwnerDirective[] = Object.freeze([
  { key: 'conciseness-short', kind: 'preference', tags: Object.freeze(['style', 'conciseness']) },
  { key: 'conciseness-detailed', kind: 'preference', tags: Object.freeze(['style', 'conciseness']) },
  { key: 'relaxed', kind: 'preference', tags: Object.freeze(['formality']) },
  { key: 'formal', kind: 'preference', tags: Object.freeze(['formality']) },
  { key: 'directness-plain', kind: 'preference', tags: Object.freeze(['style', 'directness']) },
])

const WITHDRAWN_KEYS: ReadonlySet<string> = new Set(STANDING_DIRECTIVES.map((d) => d.key))

/** Whether this build can address a withdrawal to a named key. */
export function isKnownOwnerDirectiveKey(value: unknown): value is string {
  return typeof value === 'string' && WITHDRAWN_KEYS.has(value)
}

/**
 * Patterns, and nothing else.
 *
 * Each is anchored, bounded in length, and requires an explicit imperative. The
 * alternations deliberately include the ways a person actually asks for this and
 * exclude anything that could be read as a request about *this one answer* rather
 * than about how Freya should talk from now on.
 */
const STANDING_PATTERNS: readonly { readonly key: string; readonly pattern: RegExp }[] = Object.freeze([
  {
    key: 'conciseness-short',
    // "keep it short", "be brief", "keep your answers short" — and the
    // "from now on" form that makes it unambiguous as a standing instruction.
    pattern: /\b(?:keep|make)\s+(?:it|your\s+(?:answers?|replies|responses?))\s+(?:short|brief|terse|succinct)\b|\bbe\s+brief\b|\bkeep\s+it\s+tight\b/i,
  },
  {
    key: 'conciseness-detailed',
    // Every alternative here has to be an instruction about Freya's answers, not
    // a remark about one artefact. A bare "more detail" is how "the summary you
    // just wrote needed more detail" becomes a permanent preference, so the phrase
    // only counts when it is anchored to an answer, a reply or a response.
    pattern: /\b(?:keep|make)\s+(?:it|your\s+(?:answers?|replies|responses?))\s+(?:longer|more\s+detailed|detailed|thorough)\b|\bmore\s+detail\s+in\s+(?:your\s+)?(?:answers?|replies|responses?)\b/i,
  },
  {
    key: 'relaxed',
    // The `formal` key is the formality preference interpretation reads, so this
    // is what makes a relaxed register an admitted record rather than a guess.
    pattern: /\b(?:be|keep\s+it|stay)\s+(?:more\s+)?(?:relaxed|casual|informal)\b|\bdon'?t\s+be\s+formal\b|\bdrop\s+the\s+formal(?:ity)?\b/i,
  },
  {
    key: 'formal',
    pattern: /\b(?:be|keep\s+it|stay)\s+(?:more\s+)?(?:formal|professional)\b|\buse\s+a\s+(?:more\s+)?formal\s+(?:tone|register)\b/i,
  },
  {
    key: 'directness-plain',
    pattern: /\b(?:be|get|stay)\s+(?:more\s+)?direct\b|\b(?:just\s+)?tell\s+me\s+(?:the\s+)?(?:answer|point|conclusion)\s+directly\b/i,
  },
])

/**
 * A withdrawal: "forget that", "stop doing that", "drop the rule about".
 *
 * Matched independently of the standing table, so a withdrawal can address a key
 * the standing table no longer recognises — a person taking back something from
 * an earlier version of Freya must not need this build to still understand it.
 */
const WITHDRAWAL_PATTERN =
  /\b(?:forget|unlearn|stop|drop|remove)\s+(?:that|about|it|this)?\s*(?:you\s+)?(?:remember(?:ing)?|knowing|doing|saying|saying)?\s*(?:about\s+)?(?:being\s+)?(?:keep(?:ing)?\s+it\s+)?(?:short|brief|terse|formal|relaxed|casual|direct|detailed)?/i

/**
 * One recognised outcome. `withdrawal` items carry no kind, key or tags: a
 * withdrawal addresses whatever key the owner names, and the lookup that resolves
 * it belongs to the store, not to the parser.
 */
export interface OwnerDirectiveMatch {
  readonly kind: 'standing'
  /** The code-owned slug for the record. Never free text. */
  readonly key: string
  readonly itemKind: RelationshipItemKind
  readonly tags: readonly string[]
  /** The clause that matched, bounded. What the owner can read back. */
  readonly clause: string
  /** True when the owner attached an explicit standing word to the request. */
  readonly explicitStanding: boolean
}

export interface OwnerWithdrawalMatch {
  readonly kind: 'withdrawal'
  /** The bounded clause that matched. */
  readonly clause: string
  /**
   * The key the withdrawal addresses, when it named one this build recognises.
   *
   * Null means "whichever live record covers the clause", which the store resolves
   * deterministically — most confident, then oldest id. A withdrawal that cannot
   * be addressed is reported rather than guessed at.
   */
  readonly key: string | null
}

export type OwnerDirectiveOutcome = OwnerDirectiveMatch | OwnerWithdrawalMatch

/** Words that turn a request into a *standing* one rather than a single answer. */
const STANDING_MARKERS = [
  'from now on',
  'going forward',
  'in future',
  'from here on',
  'always',
  'every time',
  'by default',
] as const

/** Closed wording for the explicit-standing flag, kept out of the pattern table. */
function hasStandingMarker(lower: string): boolean {
  return STANDING_MARKERS.some((marker) => lower.includes(marker))
}

function boundClause(text: string, start: number, end: number): string {
  const clause = text.slice(start, end).trim()
  return clause.length > PERSONALITY_LIMITS.maxItemTextChars
    ? clause.slice(0, PERSONALITY_LIMITS.maxItemTextChars)
    : clause
}

/**
 * Read the owner's message for standing instructions and withdrawals.
 *
 * Pure, synchronous, total, and bounded: at most one standing directive and one
 * withdrawal come back from a message.
 *
 * The message is *not* stored, journalled or returned in any form beyond the
 * matched clause, which is the minimum necessary disclosure (C2): the full
 * message is already in the encrypted conversation store, and duplicating a whole
 * turn into the relationship record would be the only new exposure this path
 * creates.
 *
 * ## A retraction wins over an instruction it contains
 *
 * "Forget that you keep it short" is, lexically, both a withdrawal and a request
 * for short answers — the very phrase it is retracting is still in the sentence.
 * Reading it as an instruction as well would be a self-defeating outcome: the owner
 * asks Freya to stop doing something, and Freya records a standing preference for
 * it.
 *
 * So a withdrawal anywhere in the message is the whole reading, and no new record
 * is created from a sentence that also retracts. That is the conservative
 * direction — a message that might mean two things produces no new belief — and
 * it is the direction that leaves the owner with less recorded, not more.
 */
export function readOwnerDirectives(text: unknown): readonly OwnerDirectiveOutcome[] {
  if (typeof text !== 'string') return Object.freeze([])
  const trimmed = text.trim()
  if (trimmed.length === 0 || trimmed.length > PERSONALITY_LIMITS.maxItemTextChars * 4) {
    return Object.freeze([])
  }
  const lower = trimmed.toLowerCase()

  const withdrawal = trimmed.match(WITHDRAWAL_PATTERN)
  if (withdrawal !== null) {
    return Object.freeze([
      Object.freeze({
        kind: 'withdrawal' as const,
        clause: boundClause(trimmed, withdrawal.index ?? 0, (withdrawal.index ?? 0) + withdrawal[0].length),
        key: withdrawalKey(lower),
      }),
    ])
  }

  for (const { key, pattern } of STANDING_PATTERNS) {
    const match = trimmed.match(pattern)
    if (match === null) continue
    const directive = STANDING_DIRECTIVES.find((entry) => entry.key === key)
    if (directive === undefined) continue
    return Object.freeze([
      Object.freeze({
        kind: 'standing' as const,
        key: directive.key,
        itemKind: directive.kind,
        tags: Object.freeze([...directive.tags]),
        clause: boundClause(trimmed, match.index ?? 0, (match.index ?? 0) + match[0].length),
        explicitStanding: hasStandingMarker(lower),
      }),
    ])
  }

  return Object.freeze([])
}

/**
 * Which standing key a withdrawal names, from the closed slug vocabulary.
 *
 * Plain keywords only, matched against a fixed word list. A withdrawal that does
 * not name a key this build knows reports `null` and the store resolves it by
 * clause instead of by inference — the alternative, guessing which preference
 * someone meant from a phrase, is precisely the failure this file exists to
 * avoid.
 */
function withdrawalKey(lower: string): string | null {
  if (lower.includes('short') || lower.includes('brief') || lower.includes('terse')) {
    return 'conciseness-short'
  }
  if (lower.includes('formal')) return 'formal'
  if (lower.includes('relaxed') || lower.includes('casual')) return 'relaxed'
  if (lower.includes('direct')) return 'directness-plain'
  if (lower.includes('detailed') || lower.includes('thorough')) return 'conciseness-detailed'
  return null
}

/**
 * The keys this build can record, for a host that wants to describe the lane.
 *
 * Read-only and closed. There is no way to *add* a key from outside this file
 * except by editing the table visibly, which is the same discipline the
 * temperament dimensions follow.
 */
export function ownerDirectiveKeys(): readonly string[] {
  return STANDING_DIRECTIVES.map((directive) => directive.key)
}

/**
 * Cue kinds the recogniser may ever assign.
 *
 * Always none. Present as an explicit statement rather than as an absent field so
 * that a later change has to edit this line, which is a visible contract change,
 * instead of quietly adding a cue to an instruction recogniser.
 */
export function ownerDirectiveCueKind(): CueKind | null {
  return null
}

/**
 * The tags a standing instruction is relevant to, and the tokens Core supplies for
 * preference matching.
 *
 * ## Why this is a constant and not a guess
 *
 * `interpretSocialContext` matches an admitted preference against caller-supplied
 * tokens by set intersection, and the caller has to supply *something*. The
 * temptation is to derive the tokens from the turn's own words, which would mean
 * running a matcher over free text to decide which preferences are relevant — a
 * guess, and the exact failure this whole file is built to avoid.
 *
 * So the answer is the honest one. An instruction about **register** — how Freya
 * talks — is by definition relevant to every turn, because "from now on" is what
 * makes it standing. These four tags are what that looks like as data, and they are
 * code-owned slugs with no route from anything a person said.
 *
 * A future topic-scoped preference ("keep emails formal") would carry a topic tag
 * outside this list, and would then match only when a lane supplies that token. The
 * narrow path is preserved for the day something can narrow it; today there is
 * nothing honest that can, and pretending otherwise would have been a preference
 * that applied whenever a matcher felt like it.
 */
export const STANDING_RELEVANCE_TAGS: readonly string[] = Object.freeze([
  'style',
  'formality',
  'conciseness',
  'directness',
])
