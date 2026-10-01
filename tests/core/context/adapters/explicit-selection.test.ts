// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  explicitSelectionAdmission,
  type ExplicitSelectionInput,
} from '../../../../core/context/adapters/explicit-selection'
import { CONTEXT_LIMITS } from '../../../../core/context/types'
import { T0, admitOrThrow, conversation, sequencedStore } from '../fixture'
import { expectAdmitted, expectRefusal, mistyped } from './fixture'

/**
 * The explicit selection adapter.
 *
 * One human act in, one admission candidate out — and every way an input can
 * fail to be that act gets its own door. The recurring check across these
 * tests: what comes out *preserves* what was given (kind, source, scope,
 * provenance, TTL) and never invents or widens anything.
 */

function selectionInput(overrides: Record<string, unknown> = {}): ExplicitSelectionInput {
  return mistyped({
    scope: conversation('c1'),
    content: 'the third paragraph, about the lease',
    ...overrides,
  })
}

describe('what a clean selection becomes', () => {
  it('converts the handed-in selection into an exact admission candidate', () => {
    const result = explicitSelectionAdmission(
      selectionInput({
        kind: 'explicit_selection',
        source: 'owner_selection',
        label: 'lease notes',
        capturedAt: '2026-06-01T08:59:00.000Z',
        ttlMs: 45_000,
      }),
    )
    expect(result).toEqual({
      ok: true,
      admission: {
        kind: 'explicit_selection',
        source: 'owner_selection',
        scope: { scopeKind: 'conversation', scopeId: 'c1' },
        content: 'the third paragraph, about the lease',
        label: 'lease notes',
        uri: null,
        originId: null,
        capturedAt: '2026-06-01T08:59:00.000Z',
        ttlMs: 45_000,
      },
    })
  })

  it('defaults kind, source and every absent optional', () => {
    const admission = expectAdmitted(explicitSelectionAdmission(selectionInput()))
    expect(admission.kind).toBe('explicit_selection')
    expect(admission.source).toBe('owner_selection')
    expect(admission.label).toBeNull()
    expect(admission.uri).toBeNull()
    expect(admission.originId).toBeNull()
    expect(admission.capturedAt).toBeNull()
    expect(admission.ttlMs).toBeNull()
  })

  it('preserves a TTL above the ceiling untouched — clamping is the store\'s act', () => {
    const admission = expectAdmitted(
      explicitSelectionAdmission(selectionInput({ ttlMs: CONTEXT_LIMITS.maxTtlMs * 4 })),
    )
    expect(admission.ttlMs).toBe(CONTEXT_LIMITS.maxTtlMs * 4)

    // …and the store then clamps exactly once, at admission.
    const store = sequencedStore()
    const item = admitOrThrow(store, admission, T0)
    expect(item.expiresAt).toBe(
      new Date(T0.getTime() + CONTEXT_LIMITS.maxTtlMs).toISOString(),
    )
  })

  it('is deterministic: the same input gives a byte-identical candidate', () => {
    const a = explicitSelectionAdmission(selectionInput({ label: 'x', ttlMs: 60_000 }))
    const b = explicitSelectionAdmission(selectionInput({ label: 'x', ttlMs: 60_000 }))
    expect(a).toEqual(b)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('admits through the #15 store with provenance and scope intact', () => {
    const store = sequencedStore()
    store.setActiveScope(conversation('c1'))
    const item = admitOrThrow(
      store,
      expectAdmitted(explicitSelectionAdmission(selectionInput({ capturedAt: T0.toISOString() }))),
      T0,
    )
    expect(item.kind).toBe('explicit_selection')
    expect(item.provenance).toEqual({
      source: 'owner_selection',
      capturedAt: T0.toISOString(),
      originId: null,
    })
    expect(item.scope).toEqual({ scopeKind: 'conversation', scopeId: 'c1' })
    expect(item.content).toBe('the third paragraph, about the lease')
  })
})

describe('selection is the owner\'s own hand — everything else is refused', () => {
  it('rejects every source the table does not pair with explicit_selection', () => {
    for (const source of ['owner_share', 'owner_authorization', 'host_report', 'core_record'] as const) {
      expectRefusal(
        explicitSelectionAdmission(
          selectionInput({ source, originId: source === 'host_report' ? 'evt-1' : undefined }),
        ),
        'source_not_permitted',
      )
    }
  })

  it('rejects a kind assertion that names another adapter', () => {
    expectRefusal(
      explicitSelectionAdmission(selectionInput({ kind: 'file' })),
      'kind_mismatch',
    )
    expectRefusal(
      explicitSelectionAdmission(selectionInput({ kind: 'shared_tab' })),
      'kind_mismatch',
    )
  })

  it('refuses deferred kinds by name and unknown kinds honestly', () => {
    // `active_window` is a real kind since the observation lane (#30) — but a
    // real kind from another lane's hand is still not this adapter's to
    // produce, and the honest refusal word for that is `kind_mismatch`.
    expectRefusal(
      explicitSelectionAdmission(selectionInput({ kind: 'active_window' })),
      'kind_mismatch',
    )
    expectRefusal(
      explicitSelectionAdmission(selectionInput({ kind: 'agent_work' })),
      'kind_deferred',
    )
    expectRefusal(
      explicitSelectionAdmission(selectionInput({ kind: 'clipboard' })),
      'kind_unknown',
    )
  })
})

describe('scope confusion', () => {
  it('refuses a session boundary wearing a conversation id', () => {
    expectRefusal(
      explicitSelectionAdmission(selectionInput({ scope: { scopeKind: 'session', scopeId: 'c1' } })),
      'scope_confusion',
    )
  })

  it('refuses a scope flattened onto the input instead of nested in scope', () => {
    expectRefusal(
      explicitSelectionAdmission(mistyped({ content: 'a selection', scopeId: 'c1' })),
      'scope_confusion',
    )
    expectRefusal(
      explicitSelectionAdmission(mistyped({ content: 'a selection', scopeKind: 'conversation' })),
      'scope_confusion',
    )
  })

  it('refuses malformed, empty and over-long scopes', () => {
    expectRefusal(
      explicitSelectionAdmission(selectionInput({ scope: { scopeKind: 'screen', scopeId: 's' } })),
      'invalid_scope',
    )
    expectRefusal(
      explicitSelectionAdmission(selectionInput({ scope: { scopeKind: 'conversation', scopeId: '' } })),
      'invalid_scope',
    )
    expectRefusal(
      explicitSelectionAdmission(
        selectionInput({ scope: { scopeKind: 'conversation', scopeId: 'x'.repeat(CONTEXT_LIMITS.maxScopeIdChars + 1) } }),
      ),
      'invalid_scope',
    )
    expectRefusal(explicitSelectionAdmission(mistyped({ content: 'a selection' })), 'invalid_scope')
  })

  it('accepts the session scope when it is named session', () => {
    const admission = expectAdmitted(
      explicitSelectionAdmission(selectionInput({ scope: { scopeKind: 'session', scopeId: 'session' } })),
    )
    expect(admission.scope).toEqual({ scopeKind: 'session', scopeId: 'session' })
  })
})

describe('missing and oversized descriptors', () => {
  it('refuses content that is not there or too large', () => {
    expectRefusal(explicitSelectionAdmission(selectionInput({ content: '' })), 'content_empty')
    expectRefusal(explicitSelectionAdmission(selectionInput({ content: '   \n ' })), 'content_empty')
    expectRefusal(
      explicitSelectionAdmission(selectionInput({ content: 'x'.repeat(CONTEXT_LIMITS.maxContentChars + 1) })),
      'content_too_large',
    )
    expectRefusal(explicitSelectionAdmission(mistyped({ scope: conversation('c1') })), 'content_empty')
  })

  it('refuses an oversized label, uri and origin id', () => {
    expectRefusal(
      explicitSelectionAdmission(selectionInput({ label: 'l'.repeat(CONTEXT_LIMITS.maxLabelChars + 1) })),
      'label_too_large',
    )
    expectRefusal(
      explicitSelectionAdmission(selectionInput({ uri: 'u'.repeat(CONTEXT_LIMITS.maxUriChars + 1) })),
      'uri_too_large',
    )
    expectRefusal(
      explicitSelectionAdmission(selectionInput({ originId: 'o'.repeat(CONTEXT_LIMITS.maxOriginIdChars + 1) })),
      'invalid_origin',
    )
  })

  it('refuses a nonsense capture instant and every malformed TTL', () => {
    expectRefusal(
      explicitSelectionAdmission(selectionInput({ capturedAt: 'yesterday-ish' })),
      'invalid_instant',
    )
    for (const ttlMs of [0, -5_000, Number.NaN, Number.POSITIVE_INFINITY]) {
      expectRefusal(explicitSelectionAdmission(selectionInput({ ttlMs })), 'invalid_ttl')
    }
  })

  it('preserves a future capture instant rather than sanitising it, and the store refuses it', () => {
    const result = explicitSelectionAdmission(
      selectionInput({ capturedAt: '2099-01-01T00:00:00.000Z' }),
    )
    // The adapter does not own the clock; it keeps the statement exactly.
    const admission = expectAdmitted(result)
    const store = sequencedStore()
    const refused = store.admit(admission, T0)
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.code).toBe('invalid_instant')
  })
})

describe('inputs that smuggle more than a selection', () => {
  it('refuses authority-shaped fields by name instead of ignoring them', () => {
    for (const key of ['authority', 'permission', 'capability', 'grant', 'authorized', 'trust']) {
      expectRefusal(
        explicitSelectionAdmission(selectionInput({ [key]: true })),
        'authority_not_admissible',
      )
    }
  })

  it('refuses keys the input contract does not have', () => {
    expectRefusal(
      explicitSelectionAdmission(selectionInput({ limits: { maxItems: 1 } })),
      'input_invalid',
    )
    expectRefusal(explicitSelectionAdmission(mistyped(null)), 'input_invalid')
    expectRefusal(explicitSelectionAdmission(mistyped('selection')), 'input_invalid')
  })
})
