import type { ComposerMode } from './modes'

export interface ComposerDraft {
  readonly text: string
  readonly mode: ComposerMode
  readonly wantWeb: boolean
  readonly wantBrowser: boolean
  /**
   * Whether the owner has actually touched the Web search switch for this
   * conversation.
   *
   * `wantWeb` alone cannot carry the decision, because its default (`false`) is
   * indistinguishable from the owner having deliberately turned the switch off.
   * Collapsing the two loses the permission: a turn would look like a refusal even
   * when the owner never said anything, and — far worse — a deliberate refusal
   * would look like silence and be ignored.
   *
   * So the switch has three states rather than two: untouched (this flag false,
   * and Core decides from the question), on (`true`), and explicitly off (`false`
   * with this flag set, which Core treats as a hard boundary).
   */
  readonly webSearchSet: boolean
  /** The same three-state distinction for the Browser switch. */
  readonly browserUseSet: boolean
  readonly thinkingLevel: string | null
}

export const DEFAULT_COMPOSER_DRAFT: ComposerDraft = {
  text: '',
  mode: 'chat',
  wantWeb: false,
  wantBrowser: false,
  webSearchSet: false,
  browserUseSet: false,
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
          webSearchSet: Boolean(d.webSearchSet),
          browserUseSet: Boolean(d.browserUseSet),
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
        webSearchSet: partial.webSearchSet !== undefined ? partial.webSearchSet : current.webSearchSet,
        browserUseSet: partial.browserUseSet !== undefined ? partial.browserUseSet : current.browserUseSet,
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
