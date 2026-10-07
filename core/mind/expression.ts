import type { CueKind, CueUsageLedger, ExpressionPlan, InteractionFact, RelationshipItem } from '../personality/types'
import { buildExpressionPlan, expressionBlock, type ExpressionPlanInput } from '../personality/expression'
import { interpretSocialContext } from '../personality/interpretation'
import { cueHash } from '../personality/repetition'
import type { ModelMessage } from '../model/provider'

/**
 * The expression seam: deterministic social interpretation and bounded expression
 * planning wired into the Mind's single provider call.
 *
 * This module is the bridge between the Personality & Relationship domain (Phase 11
 * Slice A) and the Mind. It adds no provider calls, no persistence, and no clock
 * reads — it is a pure function from (facts, relationship items, ledger, temperament)
 * to a bounded block of style guidance that is spliced into the packet the Mind was
 * already going to send.
 *
 * ## The injection boundary
 *
 * The Mind does not own the cue ledger. It receives an `ExpressionMemory` — a narrow
 * interface the Core supplies — so the Mind can read the ledger before planning and
 * record cue use after the turn. The Mind has no store, no persistence, and no write
 * path of its own; it asks, and the Core's implementation answers.
 *
 * An absent seam, a seam that throws, and a seam that reports `null` all degrade
 * the same way: **no expression block, and no cue reads or writes**. A ledger is
 * either supplied and bounded, or there is no personality expression at all. There
 * is no path here by which a missing ledger becomes an empty one, because an empty
 * ledger would re-offer the same cues on every turn forever.
 *
 * ## What cannot get in
 *
 * - **No relationship item text.** The interpretation reads only admitted items'
 *   slugs, tags, and closed kind labels. Item `text` is never serialised into
 *   provider guidance.
 * - **No authority.** The expression plan carries `cannotWeaken` as data and the
 *   precedence sentence as a frozen constant. Neither can be re-supplied.
 * - **No model or provider.** The plan has no provider, model, or prompt field.
 *
 * ## Bounded
 *
 * The plan is at most `PERSONALITY_LIMITS.maxGuidanceLines` lines, each within
 * `maxGuidanceLineChars`. The block is spliced as a single `user` message before
 * the owner's question, so the question remains the last thing the provider reads.
 */

/**
 * The narrow expression-memory interface the Mind is given.
 *
 * Two methods, both synchronous and both optional in their absence: a Mind with no
 * `expressionMemory` simply produces no expression block, exactly as it produced no
 * reference block before the Brain existed. The interface is structural — the Core
 * supplies an implementation that reads and writes the cue ledger.
 */
export interface ExpressionMemory {
  /**
   * Read the current cue-usage ledger.
   *
   * Called once per turn, before planning. A wired memory returns a ledger —
   * `emptyCueLedger()` for the ordinary first turn, when nothing has been used
   * yet — so the Mind can always bound what it offers.
   *
   * Returning `null` means the ledger is **unavailable**. The Mind then emits no
   * expression block at all: a missing or unreadable ledger must never be
   * mistaken for an empty one, because an empty ledger would re-offer the same
   * cues on every turn forever. "I cannot tell what was used" and "nothing was
   * used" are not the same claim.
   */
  readLedger(): CueUsageLedger | null
  /**
   * Record that a cue was offered in the turn that just completed.
   *
   * Called once per turn after the provider returns, for each cue the plan offered.
   * The Mind passes only the cue id, kind, and the turn's instant — never content.
   */
  recordCueUse(cueId: string, kind: CueKind, at: string): void
}

/**
 * The inputs the Mind assembles for one turn's expression planning.
 *
 * `ledger` is required; the rest are optional because the Mind must degrade
 * gracefully: a Core that supplies no facts, no relationship items, or no
 * temperament still gets a turn answered. The expression block is an enrichment,
 * never a precondition.
 */
export interface ExpressionTurnInput {
  /** The instant this turn is running at. */
  readonly now: string
  /**
   * The cue ledger to plan against.
   *
   * Required and non-null: the caller must have a readable ledger. The ordinary
   * first-turn state is an **empty** ledger (`emptyCueLedger()`), not `null`. A
   * `null` ledger never reaches this function — the Mind treats it as
   * unavailable and emits no block — so there is no implicit empty-ledger
   * fallback here that could re-offer cues forever.
   */
  readonly ledger: CueUsageLedger
  /** Interaction facts observed by trusted code. Empty when none. */
  readonly facts?: readonly InteractionFact[]
  /** Admitted relationship items. Empty when none. */
  readonly relationship?: readonly RelationshipItem[]
  /** Caller-normalised context tokens for preference matching. */
  readonly contextTokens?: readonly string[]
  /** The temperament to plan against. Defaults to the frozen core-owned table. */
  readonly temperament?: ExpressionPlanInput['temperament']
  /** Repetition policy overrides. Narrowed within bounds, never widened. */
  readonly policy?: ExpressionPlanInput['policy']
}

/**
 * The result of expression planning for one turn.
 *
 * `block` is the bounded guidance string to splice into the packet, or null when
 * there is nothing truthful to say (no interpretation inputs, empty plan). `plan`
 * is the full ExpressionPlan for inspection and testing. `offeredCueIds` are the
 * cues the plan offered, so the Mind can record their use after the turn.
 */
export interface ExpressionTurnResult {
  readonly block: string | null
  readonly plan: ExpressionPlan
  readonly offeredCueIds: readonly { cueId: string; kind: CueKind }[]
}

/**
 * Build the expression block for one turn. Pure: same input, same output.
 *
 * The pipeline is: interpret → plan → serialize. Interpretation is deterministic
 * over the inputs. Planning is deterministic over the interpretation and ledger.
 * Serialization is a frozen catalogue lookup. No clock, no I/O, no randomness.
 *
 * When there are no interpretation inputs at all (no facts, no relationship items),
 * the plan is still built — it carries the frozen precedence sentence, the
 * cannot-weaken list, and the temperament defaults — but the block is null because
 * there is nothing truthful to say beyond what the identity already states.
 */
export function buildExpressionForTurn(input: ExpressionTurnInput): ExpressionTurnResult {
  const interpretation = interpretSocialContext({
    now: input.now,
    facts: input.facts ?? [],
    relationship: input.relationship ?? [],
    contextTokens: input.contextTokens,
  })

  const plan = buildExpressionPlan({
    interpretation,
    at: input.now,
    ledger: input.ledger,
    temperament: input.temperament,
    policy: input.policy,
  })

  const hasSignal =
    interpretation.preferenceHits.length > 0 ||
    interpretation.cueCandidates.length > 0 ||
    interpretation.continuity !== 'new' ||
    interpretation.formality !== 'neutral' ||
    interpretation.greetingEligible

  const block = hasSignal ? expressionBlock(plan) : null

  const offeredCueIds = plan.cueReferences
    .filter((ref) => ref.mode === 'offer')
    .map((ref) => {
      const cue = interpretation.cueCandidates.find((c) => cueHash(c.cueId) === ref.cueHash)
      return cue ? { cueId: cue.cueId, kind: cue.kind } : null
    })
    .filter((entry): entry is { cueId: string; kind: CueKind } => entry !== null)

  return Object.freeze({ block, plan, offeredCueIds: Object.freeze(offeredCueIds) })
}

/**
 * Splice the expression block into the packet, in front of the conversation
 * history.
 *
 * Position is a truthfulness decision: the block is style guidance, not shared data,
 * and it must not arrive after the question it guides. The question stays last.
 * A null block returns the array untouched.
 *
 * It goes before the history rather than beside the question because it is standing
 * guidance, and the owner's recency window is theirs. On a conversation's first turn
 * — no history yet — the block lands immediately before the question, exactly as it
 * always did. On a follow-up, a block sitting next to the question is attributed to
 * the owner: measured on the live endpoint, "what did I just say?" was answered with
 * the contents of the style block instead of the conversation's first turn.
 */
export function withExpressionBlock(
  messages: readonly ModelMessage[],
  block: string | null,
): readonly ModelMessage[] {
  if (block === null) return messages
  // After the compiler's own framing system message, if it has one; otherwise first.
  const anchor = messages.findIndex((message) => message.role === 'system')
  const framed = { role: 'user' as const, content: block }
  if (anchor === -1) return [framed, ...messages]
  return [...messages.slice(0, anchor + 1), framed, ...messages.slice(anchor + 1)]
}
