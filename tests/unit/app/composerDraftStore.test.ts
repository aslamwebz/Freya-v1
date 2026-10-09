// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createComposerDraftStore,
  DEFAULT_COMPOSER_DRAFT,
} from '../../../src/app/chat/composerDraftStore'

describe('ComposerDraftStore', () => {
  beforeEach(() => {
    sessionStorage.clear()
  })

  afterEach(() => {
    sessionStorage.clear()
  })

  it('returns default draft for new conversation', () => {
    const store = createComposerDraftStore()
    expect(store.getDraft('c1')).toEqual(DEFAULT_COMPOSER_DRAFT)
    expect(store.getDraft(null)).toEqual(DEFAULT_COMPOSER_DRAFT)
  })

  it('preserves drafts independently per conversation', () => {
    const store = createComposerDraftStore()

    store.setDraft('c1', { text: 'Draft for conversation 1', wantWeb: true })
    store.setDraft('c2', { text: 'Draft for conversation 2', mode: 'deep-research', thinkingLevel: 'high' })
    store.setDraft(null, { text: 'Draft for brand new chat' })

    const d1 = store.getDraft('c1')
    expect(d1.text).toBe('Draft for conversation 1')
    expect(d1.wantWeb).toBe(true)
    expect(d1.wantBrowser).toBe(false)
    expect(d1.mode).toBe('chat')

    const d2 = store.getDraft('c2')
    expect(d2.text).toBe('Draft for conversation 2')
    expect(d2.mode).toBe('deep-research')
    expect(d2.thinkingLevel).toBe('high')

    const dNew = store.getDraft(null)
    expect(dNew.text).toBe('Draft for brand new chat')
  })

  it('clears draft when requested', () => {
    const store = createComposerDraftStore()

    store.setDraft('c1', { text: 'Some text' })
    expect(store.getDraft('c1').text).toBe('Some text')

    store.clearDraft('c1')
    expect(store.getDraft('c1')).toEqual(DEFAULT_COMPOSER_DRAFT)
  })

  it('notifies subscribers on draft changes', () => {
    const store = createComposerDraftStore()
    let calls = 0
    const unsub = store.subscribe(() => {
      calls += 1
    })

    store.setDraft('c1', { text: 'Hello' })
    expect(calls).toBe(1)

    store.clearDraft('c1')
    expect(calls).toBe(2)

    unsub()
    store.setDraft('c1', { text: 'After unsub' })
    expect(calls).toBe(2)
  })
})
