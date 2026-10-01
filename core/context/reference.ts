import {
  isContextKind,
  isContextTerm,
  isDeferredContextKind,
  isSameContextScope,
  type ContextItem,
  type ContextReference,
  type ContextRefusalReason,
  type ContextResolution,
  type ContextScope,
} from './types'
import { contextItemState, isValidContextInstant, orderedContextItems } from './item'

/**
 * REFERENCE RESOLUTION — the primitives for "this" and "here".
 *
 * A person's deictic words are resolved here, in code, with no model in the
 * loop. The whole file is one rule stated four times:
 *
 * > **Answer only when the matches are unique; otherwise refuse and say why.**
 *
 * What it deliberately does *not* do, because each would be a guess wearing the
 * clothes of a tie-break:
 *
 *  - it does not pick the most recent match. Two live files mean the person
 *    must say which, not that the newer one was probably meant;
 *  - it does not cross a scope. A conversation's context resolving inside
 *    another conversation would be the leak this phase exists to prevent;
 *  - it does not soften an expiry or a revocation into "no match". A refusal
 *    that distinguishes `expired` and `revoked` is the difference between
 *    "that was taken back" and "you never shared anything";
 *  - it does not consult anything. Same items, same scope, same instant →
 *    byte-identical verdict, which is what makes it testable and what makes a
 *    provider call unnecessary to keep it current.
 */

/**
 * Whether an item shared into `itemScope` is part of `activeScope`.
 *
 * Two rules, and the asymmetry is the point:
 *
 *  - a `session`-scoped item is *ambient*: the owner shared it for the whole
 *    session, so it is part of any current scope inside it;
 *  - anything narrower (a conversation, a surface) is visible only when it
 *    **is** the current scope. A narrower scope is more private, not less, so
 *    the broader scope never contains it — and since this lane models no
 *    nesting below `session`, exact equality is the whole containment rule.
 *
 * Nothing else is inferred: no path matching, no "probably the same tab".
 */
export function contextItemInScope(itemScope: ContextScope, activeScope: ContextScope): boolean {
  if (itemScope.scopeKind === 'session') return true
  return isSameContextScope(itemScope, activeScope)
}

/** Every item structurally inside the active scope, in deterministic age order. */
export function contextItemsInScope(
  items: Iterable<ContextItem>,
  activeScope: ContextScope | null,
): ContextItem[] {
  if (activeScope === null) return []
  return orderedContextItems([...items].filter((item) => contextItemInScope(item.scope, activeScope)))
}

function refuse(reason: ContextRefusalReason, candidateIds: readonly string[]): ContextResolution {
  return { ok: false, reason, candidateIds }
}

/**
 * Resolve a natural reference against a set of items.
 *
 * The checks run in a fixed order — clock, reference shape, active scope,
 * candidates — so two callers who disagree about *why* something failed still
 * get the same answer for the same state.
 *
 * Candidates are collected **after** the scope filter and **before** the
 * liveness filter: scope first, so an item from another conversation is not
 * even a candidate and its id never appears in a refusal; liveness second, so
 * a refusal can still distinguish what expired from what was revoked.
 *
 * The verdicts, in full:
 *
 *  - exactly one live candidate → it, and nothing else is considered;
 *  - more than one live candidate → `ambiguous`, with their ids. Recency does
 *    not break the tie, because recency is a guess about intent;
 *  - none live, none that ever matched → `no_candidates`;
 *  - none live, some revoked → `revoked` (a person's act outranks a clock);
 *  - none live, none revoked, some expired → `expired`.
 */
export function resolveContextReference(
  reference: ContextReference,
  items: Iterable<ContextItem>,
  activeScope: ContextScope | null,
  now: Date,
): ContextResolution {
  if (!isValidContextInstant(now)) return refuse('invalid_clock', [])
  if (!isContextTerm(reference?.term)) return refuse('invalid_reference', [])

  const kind = reference.kind ?? null
  if (kind !== null) {
    // Declared-but-unsourced kinds are refused by name: "not built yet" and
    // "nothing matched" would tell the person two very different things.
    if (isDeferredContextKind(kind)) return refuse('kind_deferred', [])
    if (!isContextKind(kind)) return refuse('invalid_reference', [])
  }

  if (activeScope === null) return refuse('no_active_scope', [])

  const structural = contextItemsInScope(items, activeScope).filter(
    (item) => kind === null || item.kind === kind,
  )

  const live = structural.filter((item) => contextItemState(item, now) === 'live')
  if (live.length > 1) {
    return refuse('ambiguous', live.map((item) => item.contextId))
  }
  const only = live[0]
  if (only !== undefined) return { ok: true, item: only }

  if (structural.length === 0) return refuse('no_candidates', [])

  const ids = structural.map((item) => item.contextId)
  const anyRevoked = structural.some((item) => item.revokedAt !== null)
  return refuse(anyRevoked ? 'revoked' : 'expired', ids)
}
