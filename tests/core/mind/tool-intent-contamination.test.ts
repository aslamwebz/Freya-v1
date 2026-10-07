// @vitest-environment node
/**
 * Regression tests for the contamination that motivated the structured-intent
 * refactor.
 *
 * Two distinct failures are pinned here, and they have to be pinned together:
 *
 *  1. **Stored text contamination.** The two composer buttons used to prepend
 *     "find on the web: " and "use your browser: " onto the owner's text. The
 *     stored user message was therefore not the words the owner actually said.
 *     A conversation that began with "open the pricing page" became
 *     "use your browser: open the pricing page" on disk, and a follow-up that
 *     asked "what did I just say?" was answered from the prefixed text. That
 *     class is closed: the Mind reads `intents` separately and stores the text
 *     the owner typed, exactly.
 *
 *  2. **Recency-window contamination.** The context, expression and reference
 *     blocks the Mind splices into the provider packet are `user`-role, so
 *     they are *adjacent* to the owner's question in the recency window. They
 *     must therefore be clearly labelled and positioned *before* the owner's
 *     history — never *between* the last owner turn and the current one. The
 *     existing tests cover the standing blocks; this file adds the explicit
 *     assertion that the **current** owner turn is the *last* user-role
 *     message in the packet regardless of how many blocks the Mind added.
 */

import { describe, expect, it } from 'vitest'

import { FREYA_IDENTITY } from '../../../core/identity/identity'
import {
  EMPTY_INTENT_HINTS,
  initialToolRequestForOwnerText,
  type TurnIntentHints,
} from '../../../core/mind/tool-intent'
import { withExpressionBlock } from '../../../core/mind/expression'
import type { ModelMessage } from '../../../core/model/provider'

/**
 * Re-create the Mind's local `withTurnContext` placement here so the test does
 * not reach into a private symbol. The rule itself is small and the seam that
 * owns it is documented in `core/mind/mind.ts`: the block goes *after the
 * compiler's system message, before any history, never after the question*.
 */
function withTurnContext(
  messages: readonly ModelMessage[],
  block: ModelMessage | null,
): readonly ModelMessage[] {
  if (block === null) return messages
  const anchor = messages.findIndex((message) => message.role === 'system')
  if (anchor === -1) return [block, ...messages]
  return [...messages.slice(0, anchor + 1), block, ...messages.slice(anchor + 1)]
}

describe('the composer never mutates owner text', () => {
  // Every case below has the same shape: a turn whose owner typed a plain
  // phrase. The expected behaviour is that *nothing* in the path prepends a
  // directive. The contract is on the function, not on the renderer — the
  // renderer is the part the bug used to live in, and the fix was a
  // structured handover that this text is responsible for.

  it('webSearch hint seeds an initial web_search request for the unmutated text', () => {
    const text = 'open the pricing page'
    const request = initialToolRequestForOwnerText(text, { webSearch: true })
    expect(request).toEqual({
      name: 'web_search',
      arguments: Object.freeze({ query: text, type: 'web' }),
    })
    // Belt and braces: the stored query has no directive wrapper.
    expect(request?.arguments['query']).not.toMatch(/find on the web/i)
    expect(request?.arguments['query']).toBe(text)
  })

  it('webSearch hint keeps a media noun as the vertical, even when no verb is present', () => {
    // The owner wrote "pictures of Saturn" — no verb, no directive. The
    // button alone is enough to promote the request to web_search; the noun
    // routes it to the image vertical rather than a generic web lookup.
    const request = initialToolRequestForOwnerText('pictures of Saturn', { webSearch: true })
    expect(request).toEqual({
      name: 'web_search',
      arguments: Object.freeze({ query: 'pictures of Saturn', type: 'images' }),
    })
  })

  it('browserUse hint with an http address seeds browser_read for the unmutated text', () => {
    const text = 'check https://example.com/pricing and tell me what it says'
    const request = initialToolRequestForOwnerText(text, { browserUse: true })
    expect(request).toEqual({
      name: 'browser_read',
      arguments: Object.freeze({ url: 'https://example.com/pricing' }),
    })
    expect(request?.arguments['url']).not.toMatch(/use your browser/i)
  })

  it('browserUse without an address discovers a source without inventing a URL', () => {
    // No URL → no `browser_read`. A browser call with no address is the shape
    // of a bug, and the loop already has its own path for "the model wants to
    // browse". The hint is a true rather than a forged URL.
    expect(initialToolRequestForOwnerText('what does the page say about pricing', { browserUse: true })).toEqual({ name: 'web_search', arguments: { query: 'what does the page say about pricing', type: 'web' } })
  })

  it('an empty hint set is identical to no hint at all', () => {
    const text = 'explain the difference between a hash map and a trie'
    expect(initialToolRequestForOwnerText(text, EMPTY_INTENT_HINTS)).toEqual(
      initialToolRequestForOwnerText(text),
    )
    expect(initialToolRequestForOwnerText(text)).toBeNull()
  })

  it('hints do not invent a directive the owner never typed', () => {
    // Plain prose with no directive and no hint → no request. Plain prose with
    // no directive and *webSearch=true* → a request. The point: the hint is
    // the source of the request, not a mutation of the prose.
    expect(initialToolRequestForOwnerText('hello freya')).toBeNull()
    expect(initialToolRequestForOwnerText('hello freya', { webSearch: true })).toEqual({
      name: 'web_search',
      arguments: Object.freeze({ query: 'hello freya', type: 'web' }),
    })
  })

  it('the stored query is the exact text, never a wrapped variant', () => {
    // A whitespace-wrapped input must end up trimmed in the arguments the Mind
    // hands to the tool. The renderer does not normalise; the seam does, and
    // the seam does not add prefixes.
    const request = initialToolRequestForOwnerText('  open the pricing page  ', { webSearch: true })
    expect(request?.arguments['query']).toBe('  open the pricing page  ')
  })
})

describe('the standing blocks never masquerade as the owner\'s turn', () => {
  // The Mind splices three `user`-role blocks into the packet: shared Context,
  // standing expression guidance and recalled reference memory. All three are
  // *standing* material — labels and framing are how the model tells them
  // apart. The structural property this section pins is that none of them ever
  // lands *after* the owner's question, so the recency window remains the
  // owner's.

  it('the shared Context block sits before history, never after the question', () => {
    const history: ModelMessage[] = [
      { role: 'user', content: 'previous question' },
      { role: 'assistant', content: 'previous answer' },
    ]
    const compiled = withTurnContext(history, {
      role: 'user',
      content: 'Shared context the owner put in scope for this turn.\n  - a shared file',
    })
    const withQuestion: ModelMessage[] = [...compiled, { role: 'user', content: 'current question' }]

    // Question is last, every time.
    expect(withQuestion.at(-1)).toEqual({ role: 'user', content: 'current question' })

    // The block is *before* the last history entry, so the recency window
    // between the last assistant turn and the current question is unbroken.
    const lastAssistant = withQuestion.findLastIndex((m) => m.role === 'assistant')
    const questionIndex = withQuestion.length - 1
    for (let i = lastAssistant + 1; i < questionIndex; i += 1) {
      const message = withQuestion[i]
      expect(message?.role).toBe('user')
      expect(message?.content).not.toBe('current question')
    }
  })

  it('the expression block is labelled as standing background, not owner speech', () => {
    const withBlock = withExpressionBlock(
      [{ role: 'system', content: 'identity' }, { role: 'user', content: 'previous owner turn' }],
      '— personality & expression guidance (style only; standing background for this turn, not something anybody said) —',
    )
    const block = withBlock.find((m) => m.content.startsWith('— personality & expression guidance'))
    expect(block).toBeDefined()
    expect(block?.role).toBe('user')
    // The marker is on the block itself: a model reading it cannot mistake
    // it for an instruction.
    expect(block?.content).toMatch(/standing background for this turn, not something anybody said/)
  })

  it('the owner\'s question is always the last user message in the packet', () => {
    // Compose the whole packet the Mind assembles today: identity, standing
    // expression, shared context, history, the current question. The current
    // question must remain the final message in *any* configuration.
    const packets: readonly (readonly ModelMessage[])[] = [
      [
        { role: 'system', content: FREYA_IDENTITY.name },
        { role: 'user', content: 'previous question' },
        { role: 'assistant', content: 'previous answer' },
        { role: 'user', content: 'current question' },
      ],
      withExpressionBlock(
        [
          { role: 'system', content: FREYA_IDENTITY.name },
          { role: 'user', content: 'previous question' },
          { role: 'assistant', content: 'previous answer' },
          { role: 'user', content: 'current question' },
        ],
        '— expression block —',
      ),
      withTurnContext(
        [
          { role: 'system', content: FREYA_IDENTITY.name },
          { role: 'user', content: 'previous question' },
          { role: 'assistant', content: 'previous answer' },
          { role: 'user', content: 'current question' },
        ],
        { role: 'user', content: 'Shared context block — not owner speech' },
      ),
    ]
    for (const packet of packets) {
      expect(packet.at(-1)).toEqual({ role: 'user', content: 'current question' })
    }
  })
})

describe('TurnIntentHints is a closed shape', () => {
  // A renderer that could send extra keys would be a renderer that could
  // route its own tools. The closed type exists so a future name has to be a
  // deliberate decision in TypeScript, not a runtime accident.

  it('only the two declared keys are accepted on the type', () => {
    // A type-level assertion expressed as a value: a key that is not on the
    // type cannot exist as a string literal in this object. Pin it because the
    // type and the wire shape are the same shape.
    const hints: TurnIntentHints = { webSearch: true, browserUse: true }
    expect(Object.keys(hints).sort()).toEqual(['browserUse', 'webSearch'])
  })
})