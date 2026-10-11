import { useCallback, useState } from 'react'
import type { ComposerDraft } from './composerDraftStore'

/**
 * The composer's two permission switches, and the three states each can be in.
 *
 * ## Why this is not a boolean
 *
 * A switch that is off and a switch the owner deliberately turned off are the
 * same two bits of information and they mean opposite things. The first is "I
 * have no opinion, decide from the question". The second is "do not do this".
 *
 * Carried as a boolean alone, the transport has to pick one, and picking "absent"
 * silently reverses the owner's decision: the Web search switch could raise a
 * permission but never lower one. The surface still read "Off" in both cases, so
 * nothing looked wrong. The owner pressed it and the search happened anyway,
 * which is the one behaviour a permission switch must never have.
 *
 * So `*Set` records that the switch was touched, and the three states stay
 * distinct all the way to Core:
 *
 * | touched | value | travels as | Core does |
 * |---|---|---|---|
 * | no | off | nothing | routes from the question |
 * | yes | on | `true` | looks things up |
 * | yes | off | `false` | refuses, whatever the question says |
 */
export interface IntentToggleState {
  readonly wantWeb: boolean
  readonly wantBrowser: boolean
  readonly webSearchSet: boolean
  readonly browserUseSet: boolean
  readonly toggleWeb: () => void
  readonly toggleBrowser: () => void
  readonly restore: (draft: ComposerDraft) => void
  /** What the composer will put on the wire, surfaced on the switch for tests. */
  readonly sentWeb: string
  readonly sentBrowser: string
  /** The draft patch to persist alongside a mode change. */
  readonly draftFor: (patch: Partial<ComposerDraft>) => ComposerDraft
}

export function useIntentToggles(initial: ComposerDraft): IntentToggleState {
  const [wantWeb, setWantWeb] = useState(initial.wantWeb)
  const [wantBrowser, setWantBrowser] = useState(initial.wantBrowser)
  const [webSearchSet, setWebSearchSet] = useState(initial.webSearchSet)
  const [browserUseSet, setBrowserUseSet] = useState(initial.browserUseSet)

  // The two switches differ only in which state they carry, so they share one
  // handler. Touching either marks it touched: that is the bit that turns a
  // default "Off" into a deliberate refusal, and it is set on every press.
  const toggle = useCallback((which: 'web' | 'browser') => {
    const web = which === 'web'
    const setValue = web ? setWantWeb : setWantBrowser
    const setTouched = web ? setWebSearchSet : setBrowserUseSet
    setValue(previous => {
      const next = !previous
      setTouched(true)
      return next
    })
  }, [])

  const toggleWeb = useCallback(() => toggle('web'), [toggle])
  const toggleBrowser = useCallback(() => toggle('browser'), [toggle])

  const restore = useCallback((draft: ComposerDraft) => {
    setWantWeb(draft.wantWeb)
    setWantBrowser(draft.wantBrowser)
    setWebSearchSet(draft.webSearchSet)
    setBrowserUseSet(draft.browserUseSet)
  }, [])

  const sent = (on: boolean, set: boolean) => (set ? (on ? 'allow' : 'deny') : 'defer')

  return {
    wantWeb,
    wantBrowser,
    webSearchSet,
    browserUseSet,
    toggleWeb,
    toggleBrowser,
    restore,
    sentWeb: sent(wantWeb, webSearchSet),
    sentBrowser: sent(wantBrowser, browserUseSet),
    draftFor: patch => ({
      wantWeb, webSearchSet, wantBrowser, browserUseSet, ...patch,
    }) as ComposerDraft,
  }
}