// @vitest-environment node

/**
 * THE PHASE 9 INTEGRATED CHAIN HARNESS.
 *
 * One seam, and it is the seam this lane does not own.
 *
 * Every other step of the chain is production code driven as a caller would
 * drive it: an adapter converts a handed-in input into an admission candidate,
 * `ContextStore.admit` becomes the only place that candidate is held,
 * `ContextStore.resolve` answers "this" and "here", and the host's
 * `ContextChannel` forwards a projection verbatim into the renderer's mirror
 * and on to the surface. The tests in `./chain-acceptance.test.ts` and
 * `../../unit/contextChain.test.tsx` use those directly and assert what each
 * one guarantees.
 *
 * The step between the store and the channel has no production implementation
 * yet: Core's facade in front of the store is PR #27 (issue #20), which is
 * open and not merged, so nothing in this repository turns a `ContextStore`
 * into the `ContextProjection` the transport lane already speaks. Rather than
 * invent that facade — which would collide with #27's ownership and pretend to
 * a behaviour no reviewer has agreed to — this file encodes it as a **narrow,
 * compile-safe contract assumption** and says so at every use:
 *
 *  1. The projection is built from `store.audit()`, the domain's *only*
 *     metadata shape, because that is the shape the foundation publishes for
 *     exactly this purpose ("a future journal or activity row has a
 *     metadata-only record to take without having to filter a `ContextItem`").
 *     So the view carries ids, closed labels, instants, states and measured
 *     facts — and by construction cannot carry content, label or URI.
 *  2. Words cross unchanged. `kind`, `source`, scope, instants and ids are
 *     copied from the domain rows and never reworded here; the single
 *     translation is the availability word (`live` → `current`), because the
 *     merged protocol documents `current` as the word for a live item and as
 *     the name of the corresponding count.
 *  3. A refusal becomes a view, not a decision: `ContextResolution` maps to
 *     `ContextReferenceView` with the domain's own refusal words and *all* the
 *     candidate ids, and there is deliberately no field that picks one.
 *  4. With no active scope the chain reports `unavailable` with the domain's
 *     own `no_active_scope` sentence, because an empty-but-ready frame reads
 *     as "there is no context" and that is not what the store said.
 *
 * When #27 lands, its own projection replaces this file's `project()` call and
 * every assertion below should still hold — that is the point of writing them
 * as *survival* claims (the view equals the domain row) rather than as claims
 * about choices only #27 gets to make.
 */

import type { ContextStore, ContextStoreOptions } from '../../../core/context/store'
import { contextItemInScope } from '../../../core/context/reference'
import {
  CONTEXT_REFUSAL_TEXT,
  type ContextAuditRecord,
  type ContextItem,
  type ContextReference,
  type ContextResolution,
  type ContextItemState,
} from '../../../core/context/types'
import { admitOrThrow, sequencedStore } from './fixture'
import type { ContextAdapterResult } from '../../../core/context/adapters/admission'
import {
  ABSENT_CONTEXT_PROJECTION,
  type ContextCounts,
  type ContextItemView,
  type ContextProjection,
  type ContextReferenceView,
} from '../../../core/protocol/context'

/** Private text the chain carries. It must survive into the store and nowhere else. */
export const CHAIN_SECRET = 'FREYA_CHAIN_SECRET_33A7'

/** The domain's word for a live item, as the merged protocol renders it. */
export const CHAIN_STATE_WORDS: Readonly<Record<ContextItemState, 'current' | 'revoked' | 'expired'>> =
  Object.freeze({
    live: 'current',
    revoked: 'revoked',
    expired: 'expired',
  })

/** An adapter result waiting to become a held item, or the refusal that stopped it. */
export function admitVia(
  store: ContextStore,
  result: ContextAdapterResult,
  now: Date,
): ContextItem {
  if (!result.ok) {
    throw new Error(`chain admission refused at the adapter (${result.code}): ${result.reason}`)
  }
  return admitOrThrow(store, result.admission, now)
}

/** The rows a caller inside the active scope may hear about, or null when no scope is current. */
function visibleRows(store: ContextStore, now: Date): readonly ContextAuditRecord[] | null {
  const active = store.activeScope
  if (active === null) return null
  return store
    .audit(now)
    .filter((row) => contextItemInScope({ scopeKind: row.scopeKind, scopeId: row.scopeId }, active))
}

function itemView(row: ContextAuditRecord): ContextItemView {
  const admittedAt = Date.parse(row.admittedAt)
  const expiresAt = Date.parse(row.expiresAt)
  const ttlSeconds =
    Number.isFinite(admittedAt) && Number.isFinite(expiresAt)
      ? Math.round((expiresAt - admittedAt) / 1000)
      : null
  return {
    itemId: row.contextId,
    kind: row.kind,
    // The audit shape has no label field — it is private part, measured as
    // `labelLength` and never copied — so the view reports `null` and the
    // surface falls back to the kind word. The assumption is documented rather
    // than papered over: a `label` here would be this harness choosing to move
    // a field the domain deliberately kept back.
    label: null,
    state: CHAIN_STATE_WORDS[row.state],
    provenance: {
      sourceClass: row.source,
      detail: row.originId,
      admittedAt: row.admittedAt,
    },
    scope: { label: row.scopeKind, detail: row.scopeId },
    expiresAt: row.expiresAt,
    ttlSeconds,
  }
}

/** One reference outcome, in the transport's vocabulary and with no tie-break field. */
export function referenceView(
  reference: ContextReference,
  resolution: ContextResolution,
): ContextReferenceView {
  return {
    reference: reference.term,
    status: resolution.ok ? 'resolved' : resolution.reason,
    itemIds: resolution.ok ? [resolution.item.contextId] : resolution.candidateIds,
    reason: resolution.ok ? null : CONTEXT_REFUSAL_TEXT[resolution.reason],
  }
}

export interface ChainReference {
  readonly reference: ContextReference
  readonly resolution: ContextResolution
}

export interface ChainProjectInput {
  readonly store: ContextStore
  readonly now: Date
  readonly references?: readonly ChainReference[]
  readonly sequence: number
}

/**
 * Build the projection the transport lane waits for, from what the store holds.
 *
 * The pending #27 seam, in one function. Read the file header before changing
 * it: every field is either copied from a domain row or derived by counting.
 */
export function chainProject(input: ChainProjectInput): ContextProjection {
  const { store, now, sequence } = input
  const rows = visibleRows(store, now)
  const references = (input.references ?? []).map((entry) =>
    referenceView(entry.reference, entry.resolution),
  )

  // No active scope: nothing is readable, and "ready with zeroes" would claim
  // the store said "there is no context" when it said nothing at all.
  if (rows === null) {
    return {
      ...ABSENT_CONTEXT_PROJECTION,
      reason: CONTEXT_REFUSAL_TEXT.no_active_scope,
      sequence,
    }
  }

  const items = rows.map(itemView)
  const counts: ContextCounts = {
    items: items.length,
    current: items.filter((item) => item.state === 'current').length,
    expired: items.filter((item) => item.state === 'expired').length,
    revoked: items.filter((item) => item.state === 'revoked').length,
    references: references.length,
    unresolvedReferences: references.filter((entry) => entry.status !== 'resolved').length,
  }

  return {
    health: 'ready',
    reason: null,
    items,
    references,
    counts,
    sequence,
  }
}

/**
 * The projection builder the chain tests share, with its own sequence counter.
 *
 * `sequence` is Core's proof-of-currency field, so it is minted here rather
 * than pinned by a test: a projection that stopped advancing would be a window
 * unable to tell one Core state from another.
 */
export interface ChainSeam {
  project(input: Omit<ChainProjectInput, 'sequence'>): ContextProjection
  /** Projections built so far, so a test can assert the sequence advanced. */
  readonly built: number
}

export function chainSeam(): ChainSeam {
  let sequence = 0
  return {
    project(input) {
      sequence += 1
      return chainProject({ ...input, sequence })
    },
    get built() {
      return sequence
    },
  }
}

/* --------------------------------------------------------------- transport */

export interface ChainReportingCore {
  /** The structural mirror the host binds to by shape, when a facade exists. */
  readonly core: {
    context(): ContextProjection
    onContext(listener: (projection: ContextProjection) => void): () => void
  }
  /** Push a newer projection, as a reporting Core would. */
  emit(projection: ContextProjection): void
  /** How many windows are currently attached. */
  readonly attached: number
}

/**
 * A Core that reports context, for the host's far half.
 *
 * The same stand-in `tests/host/contextBridge.test.ts` uses, because the host
 * binds *structurally*: the channel does not know whose projection it forwards.
 * Swapping this for a real `Core` is exactly what PR #27 delivers, and the
 * pending-contract test in `chain-acceptance.test.ts` is what fails first if
 * that swap arrives in the wrong vocabulary.
 */
export function chainReportingCore(initial: ContextProjection): ChainReportingCore {
  let current = initial
  const listeners = new Set<(projection: ContextProjection) => void>()
  return {
    core: {
      context: () => current,
      onContext: (listener) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    },
    emit(projection) {
      current = projection
      for (const listener of [...listeners]) listener(projection)
    },
    get attached() {
      return listeners.size
    },
  }
}

/* ------------------------------------------------------------------ stores */

/** A store with readable ids (`t-1`, `t-2`, …) for naming records in assertions. */
export function chainStore(options: ContextStoreOptions = {}): ContextStore {
  return sequencedStore(options)
}
