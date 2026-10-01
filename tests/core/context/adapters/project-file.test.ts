// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  authorizedFileAdmission,
  authorizedProjectAdmission,
  type AuthorizedFileInput,
  type AuthorizedProjectInput,
} from '../../../../core/context/adapters/project-file'
import { CONTEXT_LIMITS } from '../../../../core/context/types'
import { T0, admitOrThrow, conversation, sequencedStore } from '../fixture'
import { expectAdmitted, expectRefusal, mistyped } from './fixture'

/**
 * The authorised project / file adapters.
 *
 * The act is "this is mine, you may work with it" — handed in, never
 * discovered. The checks here are the ones that keep that act honest: a
 * project the *host* claims was authorised is not an authorisation
 * (`source_not_permitted`), a host-reported file must name the record it came
 * from (`origin_required`), and ceilings a caller supplies may lower bounds
 * but never raise them.
 */

function projectInput(overrides: Record<string, unknown> = {}): AuthorizedProjectInput {
  return mistyped({
    scope: conversation('c1'),
    content: 'Garden Renovation — three open tasks, budget agreed',
    label: 'Garden Renovation',
    ...overrides,
  })
}

function fileInput(overrides: Record<string, unknown> = {}): AuthorizedFileInput {
  return mistyped({
    scope: conversation('c1'),
    content: 'chapter two of the lease, in full',
    label: 'lease.pdf',
    uri: 'file:///home/owner/docs/lease.pdf',
    ...overrides,
  })
}

describe('the authorised project', () => {
  it('converts an authorisation into an exact candidate, defaulting its source', () => {
    const result = authorizedProjectAdmission(
      projectInput({ originId: 'auth-3', capturedAt: '2026-05-31T17:00:00.000Z', ttlMs: 900_000 }),
    )
    expect(result).toEqual({
      ok: true,
      admission: {
        kind: 'project',
        source: 'owner_authorization',
        scope: { scopeKind: 'conversation', scopeId: 'c1' },
        content: 'Garden Renovation — three open tasks, budget agreed',
        label: 'Garden Renovation',
        uri: null,
        originId: 'auth-3',
        capturedAt: '2026-05-31T17:00:00.000Z',
        ttlMs: 900_000,
      },
    })
  })

  it('accepts a project selected from a list, and admits both paths', () => {
    const store = sequencedStore()
    store.setActiveScope(conversation('c1'))
    for (const source of ['owner_authorization', 'owner_selection'] as const) {
      const item = admitOrThrow(
        store,
        expectAdmitted(authorizedProjectAdmission(projectInput({ source }))),
        T0,
      )
      expect(item.kind).toBe('project')
      expect(item.provenance.source).toBe(source)
    }
  })

  it('refuses every source that is not the owner pointing at their own project', () => {
    // Even naming an origin: "the host reports this project is authorised" is
    // not an authorisation, and an origin id does not launder it into one.
    for (const source of ['host_report', 'owner_share', 'core_record'] as const) {
      expectRefusal(
        authorizedProjectAdmission(projectInput({ source, originId: 'auth-3' })),
        'source_not_permitted',
      )
    }
  })
})

describe('the authorised file', () => {
  it('keeps a host report honest: it must name the authorisation record', () => {
    const admission = expectAdmitted(
      authorizedFileAdmission(fileInput({ source: 'host_report', originId: 'auth-42' })),
    )
    expect(admission.source).toBe('host_report')
    expect(admission.originId).toBe('auth-42')

    const store = sequencedStore()
    const item = admitOrThrow(store, admission, T0)
    expect(item.provenance).toEqual({
      source: 'host_report',
      capturedAt: T0.toISOString(),
      originId: 'auth-42',
    })
  })

  it('refuses a bare "the host said so" and a blank or oversized origin', () => {
    expectRefusal(authorizedFileAdmission(fileInput({ source: 'host_report' })), 'origin_required')
    expectRefusal(
      authorizedFileAdmission(fileInput({ source: 'host_report', originId: '' })),
      'origin_required',
    )
    expectRefusal(
      authorizedFileAdmission(fileInput({ originId: 'o'.repeat(CONTEXT_LIMITS.maxOriginIdChars + 1) })),
      'invalid_origin',
    )
  })

  it('refuses core_record provenance and wrong-kind assertions', () => {
    expectRefusal(
      authorizedFileAdmission(fileInput({ source: 'core_record', originId: 'm-1' })),
      'source_not_permitted',
    )
    expectRefusal(
      authorizedProjectAdmission(projectInput({ kind: 'file' })),
      'kind_mismatch',
    )
    expectRefusal(
      authorizedFileAdmission(fileInput({ kind: 'project' })),
      'kind_mismatch',
    )
    expectRefusal(
      authorizedFileAdmission(fileInput({ kind: 'active_window' })),
      'kind_deferred',
    )
  })

  it('admits the plain owner acts through the #15 store', () => {
    const store = sequencedStore()
    store.setActiveScope(conversation('c1'))
    const item = admitOrThrow(store, expectAdmitted(authorizedFileAdmission(fileInput())), T0)
    expect(item.kind).toBe('file')
    expect(item.provenance.source).toBe('owner_authorization')
    expect(item.uri).toBe('file:///home/owner/docs/lease.pdf')
  })
})

describe('ceilings and confusion, shared by both adapters', () => {
  it('honours lowered ceilings and ignores raised ones', () => {
    const lowered = { limits: { maxContentChars: 32, maxLabelChars: 8 } }
    expectRefusal(
      authorizedProjectAdmission(projectInput({ content: 'x'.repeat(33) }), lowered),
      'content_too_large',
    )
    expectRefusal(
      authorizedFileAdmission(fileInput({ content: 'lease.pdf', label: 'l'.repeat(9) }), lowered),
      'label_too_large',
    )
    // A ceiling is a fact about this build, not a suggestion: raising it back
    // above CONTEXT_LIMITS does not let a bigger item through.
    const raised = { limits: { maxContentChars: CONTEXT_LIMITS.maxContentChars * 3 } }
    expectRefusal(
      authorizedProjectAdmission(
        projectInput({ content: 'x'.repeat(CONTEXT_LIMITS.maxContentChars + 1) }),
        raised,
      ),
      'content_too_large',
    )
  })

  it('refuses scope confusion on both doors', () => {
    expectRefusal(
      authorizedProjectAdmission(projectInput({ scope: { scopeKind: 'session', scopeId: 'c1' } })),
      'scope_confusion',
    )
    expectRefusal(
      authorizedFileAdmission(mistyped({ content: 'a file', scopeId: 'c1' })),
      'scope_confusion',
    )
    expectRefusal(
      authorizedProjectAdmission(mistyped({ content: 'a project' })),
      'invalid_scope',
    )
  })

  it('refuses empty content, bad instants, bad TTLs and smuggled authority', () => {
    expectRefusal(authorizedProjectAdmission(projectInput({ content: '   ' })), 'content_empty')
    expectRefusal(authorizedFileAdmission(fileInput({ content: '' })), 'content_empty')
    expectRefusal(
      authorizedFileAdmission(fileInput({ capturedAt: 'whenever' })),
      'invalid_instant',
    )
    expectRefusal(authorizedProjectAdmission(projectInput({ ttlMs: -1 })), 'invalid_ttl')
    expectRefusal(
      authorizedFileAdmission(fileInput({ uri: 'u'.repeat(CONTEXT_LIMITS.maxUriChars + 1) })),
      'uri_too_large',
    )
    expectRefusal(
      authorizedProjectAdmission(projectInput({ authorized: true })),
      'authority_not_admissible',
    )
    expectRefusal(
      authorizedFileAdmission(fileInput({ capabilities: ['read-files'] })),
      'authority_not_admissible',
    )
  })

  it('is deterministic for both adapters', () => {
    for (const run of [
      () => authorizedProjectAdmission(projectInput({ ttlMs: 60_000 })),
      () => authorizedFileAdmission(fileInput({ source: 'host_report', originId: 'auth-9' })),
    ]) {
      expect(JSON.stringify(run())).toBe(JSON.stringify(run()))
    }
  })
})
