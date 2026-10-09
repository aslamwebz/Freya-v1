import type { ComposerMode } from './modes'

export interface ComposerDraft {
  readonly text: string
  readonly mode: ComposerMode
  readonly wantWeb: boolean
  readonly wantBrowser: boolean
  readonly thinkingLevel: string | null
}

export const DEFAULT_COMPOSER_DRAFT: ComposerDraft = {
  text: '',
  mode: 'chat',
  wantWeb: false,
  wantBrowser: false,
  thinkingLevel: null,
}

const STORAGE_KEY = 'freya.composerDrafts'

function readSessionDrafts(): Record<string, ComposerDraft> {
  if (typeof window === 'undefined' || !window.sessionStorage) return {}
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const result: Record<string, ComposerDraft> = {}
    for (const [key, val] of Object.entries(parsed)) {
      if (typeof val === 'object' && val !== null) {
        const d = val as Partial<ComposerDraft>
        result[key] = {
          text: typeof d.text === 'string' ? d.text : '',
          mode: d.mode === 'deep-research' || d.mode === 'eye' ? d.mode : 'chat',
          wantWeb: Boolean(d.wantWeb),
          wantBrowser: Boolean(d.wantBrowser),
          thinkingLevel: typeof d.thinkingLevel === 'string' ? d.thinkingLevel : null,
        }
      }
    }
    return result
  } catch {
    return {}
  }
}

function writeSessionDrafts(drafts: Record<string, ComposerDraft>): void {
  if (typeof window === 'undefined' || !window.sessionStorage) return
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(drafts))
  } catch {
    // sessionStorage write is optional
  }
}

export interface ComposerDraftStore {
  getDraft(conversationId: string | null): ComposerDraft
  setDraft(conversationId: string | null, draft: Partial<ComposerDraft>): void
  clearDraft(conversationId: string | null): void
  reset(): void
  subscribe(listener: () => void): () => void
  getSnapshot(): Record<string, ComposerDraft>
}

export function createComposerDraftStore(): ComposerDraftStore {
  let drafts: Record<string, ComposerDraft> = readSessionDrafts()
  const listeners = new Set<() => void>()

  const publish = () => {
    writeSessionDrafts(drafts)
    for (const listener of [...listeners]) listener()
  }

  const keyOf = (conversationId: string | null): string => conversationId ?? '__new__'

  return {
    getDraft(conversationId) {
      const key = keyOf(conversationId)
      return drafts[key] ?? DEFAULT_COMPOSER_DRAFT
    },
    setDraft(conversationId, partial) {
      const key = keyOf(conversationId)
      const current = drafts[key] ?? DEFAULT_COMPOSER_DRAFT
      const next: ComposerDraft = {
        text: partial.text !== undefined ? partial.text : current.text,
        mode: partial.mode !== undefined ? partial.mode : current.mode,
        wantWeb: partial.wantWeb !== undefined ? partial.wantWeb : current.wantWeb,
        wantBrowser: partial.wantBrowser !== undefined ? partial.wantBrowser : current.wantBrowser,
        thinkingLevel: partial.thinkingLevel !== undefined ? partial.thinkingLevel : current.thinkingLevel,
      }
      drafts = { ...drafts, [key]: next }
      publish()
    },
    clearDraft(conversationId) {
      const key = keyOf(conversationId)
      if (!(key in drafts)) return
      const next = { ...drafts }
      delete next[key]
      drafts = next
      publish()
    },
    reset() {
      drafts = {}
      publish()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot() {
      return drafts
    },
  }
}

let sharedDraftStoreInstance: ComposerDraftStore | null = null

export function sharedComposerDraftStore(): ComposerDraftStore {
  if (sharedDraftStoreInstance === null) {
    sharedDraftStoreInstance = createComposerDraftStore()
  }
  return sharedDraftStoreInstance
}
