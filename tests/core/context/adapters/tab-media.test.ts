// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  sharedMediaAdmission,
  sharedTabAdmission,
  type SharedMediaInput,
  type SharedTabInput,
} from '../../../../core/context/adapters/tab-media'
import { CONTEXT_LIMITS } from '../../../../core/context/types'
import { T0, admitOrThrow, conversation, sequencedStore, surface } from '../fixture'
import { expectAdmitted, expectRefusal, mistyped } from './fixture'

/**
 * The shared tab / media adapters.
 *
 * A share is something the owner *did* — pasted the page text, attached the
 * file's description. These adapters refuse anything that looks like Core
 * sensed it: a `host_report` share without a share record behind it is
 * refused, and the two kinds never borrow each other's inputs. There is no
 * browser channel, no screen and no device here — none was invented.
 */

function tabInput(overrides: Record<string, unknown> = {}): SharedTabInput {
  return mistyped({
    scope: surface('tab-share-1'),
    content: 'the article\'s opening paragraphs, pasted by the owner',
    label: 'Quarterly Report — example.org',
    uri: 'https://example.org/quarterly-report',
    ...overrides,
  })
}

function mediaInput(overrides: Record<string, unknown> = {}): SharedMediaInput {
  return mistyped({
    scope: conversation('c1'),
    content: 'transcript of the voicemail the owner shared',
    label: 'voice-note-12.m4a',
    uri: 'file:///home/owner/shares/voice-note-12.m4a',
    ...overrides,
  })
}

describe('the shared tab', () => {
  it('converts an owner share into an exact candidate and defaults the source', () => {
    const result = sharedTabAdmission(tabInput({ ttlMs: 300_000 }))
    expect(result).toEqual({
      ok: true,
      admission: {
        kind: 'shared_tab',
        source: 'owner_share',
        scope: { scopeKind: 'surface', scopeId: 'tab-share-1' },
        content: "the article's opening paragraphs, pasted by the owner",
        label: 'Quarterly Report — example.org',
        uri: 'https://example.org/quarterly-report',
        originId: null,
        capturedAt: null,
        ttlMs: 300_000,
      },
    })
  })

  it('lets the host report a share only when it names the share record', () => {
    const admission = expectAdmitted(
      sharedTabAdmission(tabInput({ source: 'host_report', originId: 'share-7' })),
    )
    expect(admission.originId).toBe('share-7')

    const store = sequencedStore()
    store.setActiveScope(surface('tab-share-1'))
    const item = admitOrThrow(store, admission, T0)
    expect(item.provenance).toEqual({
      source: 'host_report',
      capturedAt: T0.toISOString(),
      originId: 'share-7',
    })
  })

  it('refuses a reported share with no share behind it', () => {
    expectRefusal(sharedTabAdmission(tabInput({ source: 'host_report' })), 'origin_required')
    expectRefusal(
      sharedTabAdmission(tabInput({ source: 'host_report', originId: '' })),
      'origin_required',
    )
  })

  it('refuses kinds and sources that belong to other acts', () => {
    // A tab is not a selection and not an authorisation; those are different
    // promises, and the table says so.
    for (const source of ['owner_selection', 'owner_authorization', 'core_record'] as const) {
      expectRefusal(sharedTabAdmission(tabInput({ source })), 'source_not_permitted')
      expectRefusal(sharedMediaAdmission(mediaInput({ source })), 'source_not_permitted')
    }
    expectRefusal(sharedTabAdmission(tabInput({ kind: 'project' })), 'kind_mismatch')
    expectRefusal(sharedMediaAdmission(mediaInput({ kind: 'shared_tab' })), 'kind_mismatch')
    expectRefusal(sharedTabAdmission(tabInput({ kind: 'active_window' })), 'kind_deferred')
  })
})

describe('the shared media', () => {
  it('converts an owner share of media into a candidate', () => {
    const store = sequencedStore()
    store.setActiveScope(conversation('c1'))
    const item = admitOrThrow(
      store,
      expectAdmitted(
        sharedMediaAdmission(mediaInput({ capturedAt: '2026-06-01T08:58:00.000Z' })),
      ),
      T0,
    )
    expect(item.kind).toBe('shared_media')
    expect(item.provenance.source).toBe('owner_share')
    expect(item.provenance.capturedAt).toBe('2026-06-01T08:58:00.000Z')
    expect(item.label).toBe('voice-note-12.m4a')
  })

  it('refuses oversized descriptors', () => {
    expectRefusal(
      sharedMediaAdmission(mediaInput({ content: 'x'.repeat(CONTEXT_LIMITS.maxContentChars + 1) })),
      'content_too_large',
    )
    expectRefusal(
      sharedTabAdmission(tabInput({ uri: 'u'.repeat(CONTEXT_LIMITS.maxUriChars + 1) })),
      'uri_too_large',
    )
    expectRefusal(
      sharedMediaAdmission(mediaInput({ label: 'l'.repeat(CONTEXT_LIMITS.maxLabelChars + 1) })),
      'label_too_large',
    )
    expectRefusal(sharedMediaAdmission(mediaInput({ content: '' })), 'content_empty')
  })

  it('refuses scope confusion and malformed provenance', () => {
    expectRefusal(
      sharedMediaAdmission(mediaInput({ scope: { scopeKind: 'session', scopeId: 'c1' } })),
      'scope_confusion',
    )
    expectRefusal(
      sharedTabAdmission(mistyped({ content: 'a tab', scopeKind: 'surface' })),
      'scope_confusion',
    )
    expectRefusal(
      sharedMediaAdmission(mediaInput({ capturedAt: 'sometime Tuesday' })),
      'invalid_instant',
    )
    expectRefusal(sharedTabAdmission(tabInput({ ttlMs: 0 })), 'invalid_ttl')
    expectRefusal(
      sharedTabAdmission(tabInput({ originId: 'o'.repeat(CONTEXT_LIMITS.maxOriginIdChars + 1) })),
      'invalid_origin',
    )
  })

  it('holds no privilege it was not given: authority fields are refused', () => {
    expectRefusal(
      sharedMediaAdmission(mediaInput({ grant: 'read-screen' })),
      'authority_not_admissible',
    )
    expectRefusal(
      sharedTabAdmission(tabInput({ capabilities: ['tabs'] })),
      'authority_not_admissible',
    )
    expectRefusal(sharedTabAdmission(tabInput({ unknownKey: 1 })), 'input_invalid')
  })

  it('is deterministic for both doors', () => {
    for (const run of [
      () => sharedTabAdmission(tabInput()),
      () => sharedMediaAdmission(mediaInput({ source: 'host_report', originId: 'share-2' })),
    ]) {
      expect(JSON.stringify(run())).toBe(JSON.stringify(run()))
    }
  })
})
