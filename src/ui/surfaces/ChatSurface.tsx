import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useShell } from '../store'
import {
  conversationList,
  conversationMirror,
  ensureConversationAttached,
  visibleMessages,
} from '../../platform/conversationClient'
import { voiceMirror } from '../../platform/voiceClient'
import { readModelCatalog, selectModel } from '../../platform/modelClient'
import type { ModelView } from '../../../core/protocol/core-protocol'
import type { ConversationProjection, VoiceProjection } from '../../../core/protocol/conversation'
import { MicButton } from './MicButton'
import { AssistantMessageView } from '../../app/chat/AssistantMessageView'
import { MediaGrid } from '../../app/chat/MediaCards'
import { ActivityFeed } from '../../app/chat/ActivityFeed'
import '../../app/chat/chat.css'
import '../../app/chat/media.css'

/**
 * Chat — a real conversation with a real Freya behind it.
 *
 * Every fact on this screen came from Core. There is no local transcript, no
 * optimistic message, and no "typing…" indicator: the composer is disabled while
 * a turn is running, the transcript appears when Core says it is stored, and
 * "no provider" is a sentence rather than a spinner that never resolves.
 *
 * ## The three states that are easy to fake
 *
 * - **A response is generating.** Driven by `activeTurn` in the projection, which
 *   Core populates from its own bookkeeping. Not from a local flag set on click.
 * - **There is no provider.** Reported by Core, with the reason, before anyone
 *   presses Send. Freya does not echo the question back and call it an answer.
 * - **The last turn failed.** Shown as the turn's own outcome, in the transcript,
 *   next to the question that caused it — not as a toast that has gone by.
 *
 * ## What this surface cannot do
 *
 * It cannot send a privileged command, name a grant, raise a ceiling, or reach
 * a provider. The doors are `conversation.turn.submit`, `conversation.turn.cancel`,
 * and the two model commands — and a model choice is a *name* that Core validates
 * against what a configured provider can serve before it means anything. The Mind
 * behind a turn still compiles the context, creates the grant and asks the
 * Governor exactly as it did when this comment said a window could not choose
 * a model at all.
 */

export function ChatSurface() {
  const listening = useShell((s) => s.listening)
  const [projection, setProjection] = useState<ConversationProjection | null>(null)
  const [voice, setVoice] = useState<VoiceProjection | null>(null)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [transcript, setTranscript] = useState<HTMLDivElement | null>(null)
  const [models, setModels] = useState<readonly ModelView[]>([])
  const [catalogState, setCatalogState] = useState<'idle' | 'loading' | 'loaded'>('idle')
  const [selectedModel, setSelectedModel] = useState<string | null>(null)
  const [defaultModel, setDefaultModel] = useState<string | null>(null)
  const mirror = conversationMirror()
  const voiceStatus = voiceMirror()

  useEffect(() => {
    let dispose: (() => void) | undefined
    let disposeVoice: (() => void) | undefined
    let cancelled = false
    void ensureConversationAttached().then((attached) => {
      if (cancelled) return
      dispose = attached.subscribe(setProjection)
    })
    // The voice mirror is its own subscription, attached on the same mount and
    // released on the same unmount — a surface that forgot one of the pair would
    // keep a Core push alive for a window nobody is looking at.
    void voiceStatus.attach().then((detach) => {
      if (cancelled) detach()
      else disposeVoice = voiceStatus.subscribe(setVoice)
    })
    // Load the existing history so a surface opened on day seven is not empty. A
    // refusal is reported rather than thrown: the transcript below already renders
    // whatever Core could tell us, and an unhandled rejection would only add a
    // console error nobody reads.
    void mirror.list().then((outcome) => {
      if (outcome.operation === 'refused') setNotice(outcome.reason)
    })
    return () => {
      cancelled = true
      dispose?.()
      disposeVoice?.()
    }
  }, [mirror, voiceStatus])

  // Keep the newest line in view without stealing focus from the composer.
  useEffect(() => {
    const log = transcript
    if (log) log.scrollTop = log.scrollHeight
  }, [projection?.messages.length])

  const messages = useMemo(() => visibleMessages(projection), [projection])
  const conversations = useMemo(() => conversationList(projection), [projection])
  const activeTurn = projection?.activeTurn ?? null
  const generating = activeTurn !== null
  const stopped = projection?.stopAll.active === true
  const canThink = projection?.cognition.available === true
  const persistence = projection?.persistence

  const ensureConversation = useCallback(async (): Promise<string | null> => {
    const existing = projection?.activeConversationId
    if (existing) return existing
    const created = await mirror.create()
    return created.operation === 'created' ? created.conversation.conversationId : null
  }, [mirror, projection?.activeConversationId])

  /**
   * Ask Core for the catalogue — now, because the person asked, and never on
   * mount. A refusal keeps its sentence: an empty list rendered after a failed
   * read would say "NanoGPT has no models", which is not what happened.
   */
  const loadCatalog = useCallback(async () => {
    setCatalogState('loading')
    setNotice(null)
    const outcome = await readModelCatalog()
    if (outcome.operation === 'catalog') {
      setModels(outcome.models ?? [])
      setDefaultModel(outcome.defaultModel ?? null)
      setSelectedModel(outcome.selected ?? null)
      setCatalogState('loaded')
    } else {
      setCatalogState('idle')
      setNotice(outcome.reason ?? 'The model catalogue could not be read.')
    }
  }, [])

  /**
   * Name a model for subsequent turns. On a refusal the list and the selection
   * stay where they were, because Core stayed where it was — the old selection
   * is still what the next turn will run.
   */
  const chooseModel = useCallback(async (model: string | null) => {
    setNotice(null)
    const outcome = await selectModel(model)
    if (outcome.operation === 'selected') {
      setSelectedModel(outcome.selected ?? null)
    } else {
      setNotice(outcome.reason ?? 'That model could not be selected.')
    }
  }, [])

  const send = useCallback(async () => {
    const text = draft.trim()
    if (text.length === 0 || sending || generating) return

    const limit = projection?.maxMessageCharacters ?? 0
    if (limit > 0 && text.length > limit) {
      // Refused here, visibly, so an accidental paste does not become a request.
      setNotice(`That message is ${text.length} characters. The limit is ${limit}.`)
      return
    }

    setSending(true)
    setNotice(null)
    try {
      const conversationId = await ensureConversation()
      if (conversationId === null) {
        setNotice('No conversation is available, so the message was not sent.')
        return
      }
      // The draft clears only once Core has the message. A window that clears
      // first would lose a sentence on a failed send.
      const outcome = await mirror.submitTurn(conversationId, text)
      setDraft('')
      if (outcome.operation === 'turn' && outcome.turn.outcome !== 'completed') {
        setNotice(outcome.turn.reason ?? 'That turn did not complete.')
      }
    } catch (error) {
      setNotice(
        `Freya Core could not be reached — ${error instanceof Error ? error.message : 'unknown error'}`,
      )
    } finally {
      setSending(false)
    }
  }, [draft, ensureConversation, generating, mirror, projection?.maxMessageCharacters, sending])

  const stopResponse = useCallback(async () => {
    if (!activeTurn) return
    await mirror.cancelTurn(activeTurn.turnId)
    // No notice and no local state change: the turn's outcome arrives as a
    // projection push, because Core is what knows how it ended.
  }, [activeTurn, mirror])

  const composerDisabled = sending || generating || stopped

  // Keyboard shortcuts scoped to this surface.
  // - Esc cancels a running turn (the model is already paying for it; cancel is honest).
  // - Ctrl/Cmd + L focuses the composer; the browser's location-bar shortcut is
  //   "Ctrl+L" too, so this is the conventional pairing.
  // - ↑ on an empty composer recalls the last user message — a habit the
  //   terminal-trained half of the audience has, and a one-line addition.
  const composerElRef = useRef<HTMLTextAreaElement | null>(null)
  const rootElRef = useRef<HTMLDivElement | null>(null)
  const lastUserTextRef = useRef<string | null>(null)
  useEffect(() => {
    for (const message of messages) {
      if (message.role === 'user') lastUserTextRef.current = message.content
    }
  }, [messages])
  useEffect(() => {
    const root = rootElRef.current
    if (!root) return
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const insideRoot = target !== null && root.contains(target)
      if (event.key === 'Escape' && generating && activeTurn && insideRoot) {
        event.preventDefault()
        void mirror.cancelTurn(activeTurn.turnId)
        return
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'l' && insideRoot) {
        event.preventDefault()
        composerElRef.current?.focus()
        return
      }
      if (event.key === 'ArrowUp' && insideRoot) {
        const isComposer = target?.tagName === 'TEXTAREA'
        const empty = isComposer && (target as HTMLTextAreaElement).value.length === 0
        if (isComposer && empty && lastUserTextRef.current) {
          event.preventDefault()
          setDraft(lastUserTextRef.current)
        }
      }
    }
    root.addEventListener('keydown', onKey)
    return () => root.removeEventListener('keydown', onKey)
  }, [activeTurn?.turnId, generating, mirror])

  return (
    <div className="chat" ref={rootElRef}>
      <div className="chat-side">
        <button
          type="button"
          className="chat-new"
          onClick={() => {
            void mirror.create()
            setNotice(null)
          }}
          disabled={generating}
        >
          New conversation
        </button>
        <ul className="chat-list" aria-label="Conversations">
          {conversations.map((conversation) => (
            <li key={conversation.conversationId}>
              <button
                type="button"
                className="chat-list-item"
                data-active={conversation.conversationId === projection?.activeConversationId || undefined}
                onClick={() => void mirror.read(conversation.conversationId)}
              >
                <span className="chat-list-title">{conversation.title}</span>
                <span className="chat-list-meta">
                  {conversation.messageCount} message{conversation.messageCount === 1 ? '' : 's'}
                  {conversation.lastTurnOutcome ? ` · ${conversation.lastTurnOutcome}` : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>

        {/* The model selector. It changes what the *next* turn asks for, and
            nothing else: no budget, no gate, no grant. A choice is re-checked
            inside Core against what a configured provider can actually serve,
            and a refusal here is Core's sentence rather than a silent revert. */}
        <div className="chat-model">
          <label htmlFor="chat-model-select">Model</label>
          <div className="chat-model-row">
            <select
              id="chat-model-select"
              value={selectedModel ?? ''}
              onChange={(event) => {
                const value = event.target.value
                void chooseModel(value === '' ? null : value)
              }}
            >
              <option value="">
                {defaultModel === null
                  ? 'Provider default'
                  : `Provider default (${defaultModel})`}
              </option>
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.id}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="chat-model-load"
              onClick={() => void loadCatalog()}
              disabled={catalogState === 'loading'}
              title="Ask the configured provider which text models it can serve"
            >
              {catalogState === 'loading' ? 'Loading…' : 'Load models'}
            </button>
          </div>
        </div>

        {/* Durability, stated rather than assumed. Someone should know their
            conversation is not being saved before they say something they would
            rather not lose. */}
        {persistence && persistence.mode !== 'encrypted' ? (
          <p className="chat-persistence" data-mode={persistence.mode}>
            {persistence.reason ?? 'Conversations are not being saved.'}
          </p>
        ) : null}
      </div>

      <div className="chat-main">
        <div className="chat-log" role="log" aria-label="Conversation" ref={setTranscript}>
          {messages.length === 0 ? (
            <div className="chat-empty">
              <p>
                Ask Freya something. She will assemble what she knows, think once, and say what she
                actually has.
              </p>
            </div>
          ) : (
            messages.map((message) => (
              <article key={message.messageId} className="chat-turn" data-role={message.role}>
                <header><b>{message.role === 'user' ? 'You' : 'Freya'}</b></header>
                {/* Markdown rendered through `RichMessage`. Model output is untrusted
                    content and is rendered through the deliberately-small markdown
                    reader in `app/chat/RichMessage.tsx` — no `dangerouslySetInnerHTML`,
                    no HTML tag interpretation, every token becomes ordinary React
                    text. The reader closes its token set to code, strong/emphasis
                    and explicit http(s) links; HTML tags arrive as text. */}
                {message.role === 'assistant'
                  ? <AssistantMessageView
                      content={message.content}
                      retrieved={message.media?.length ?? 0}
                      mediaCount={message.media?.length ?? 0}
                      sources={message.sources}
                      charts={message.charts}
                    >
                    </AssistantMessageView>
                  : <p className="chat-turn-text">{message.content}</p>}
                {message.role === 'assistant' && message.media && message.media.length > 0 ? (
                  <MediaGrid items={message.media} />
                ) : null}
              </article>
            ))
          )}

          {generating ? (
            <article className="chat-turn" data-role="assistant" data-state="generating" aria-live="polite">
              <header><b>Freya</b></header>
              <p className="chat-thinking" aria-label={activeTurn?.providerExecuting ? 'Thinking' : 'Getting ready to think'}>
                <i /><i /><i />
                <span>{activeTurn?.providerExecuting ? 'Thinking.' : 'Getting ready to think.'}</span>
              </p>
              <ActivityFeed active={generating} />
            </article>
          ) : null}

          {stopped ? (
            <p className="chat-boundary" role="status">
              Freya is stopped. Every model request is refused until you resume from Security.
            </p>
          ) : null}

          {!stopped && !generating && !canThink ? (
            <p className="chat-boundary" role="status">
              {projection?.cognition.reason ?? 'No cognition provider is currently available.'}
            </p>
          ) : null}

          {notice ? (
            <p className="chat-boundary" role="status">
              {notice}
            </p>
          ) : null}
        </div>

        <form
          className="chat-compose"
          onSubmit={(event) => {
            event.preventDefault()
            void send()
          }}
        >
          <MicButton
            voice={voice}
            onTranscript={(text) => setDraft((current) => (current.length > 0 ? `${current} ${text}` : text))}
          />
          <textarea
            className="chat-input"
            value={draft}
            ref={composerElRef}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              // Enter sends, Shift+Enter is a newline — the convention everywhere
              // else, and the one that lets someone write a paragraph.
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void send()
              }
            }}
            rows={2}
            placeholder={
              stopped
                ? 'Freya is stopped'
                : generating
                  ? 'Freya is answering…'
                  : listening
                    ? 'Listening…'
                    : 'Message Freya'
            }
            aria-label="Message Freya"
            disabled={composerDisabled}
            spellCheck={false}
          />
          {generating ? (
            <button
              type="button"
              className="chat-stop"
              onClick={() => void stopResponse()}
              aria-label="Stop this response"
              title="Stop this response. Freya stays able to think."
            >
              Stop response
            </button>
          ) : (
            <button
              type="submit"
              className="chat-send"
              disabled={draft.trim().length === 0 || composerDisabled}
              aria-label="Send"
            >
              <span aria-hidden="true">→</span>
            </button>
          )}
        </form>
      </div>
    </div>
  )
}
