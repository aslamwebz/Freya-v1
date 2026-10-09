// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { EventFabric } from '../../../core/events/fabric'
import type { EventStore } from '../../../core/events/store'
import type { AnyCoreEvent } from '../../../core/events/envelope'
import { MemoryConversationStore } from '../../../core/conversation/memory-store'
import { ModelGateway, type GatewayRecorder } from '../../../core/model/gateway'
import type { ModelProvider, ModelRequest, ModelResult } from '../../../core/model/provider'
import { MindService } from '../../../core/mind/mind'
import { DefaultGuard } from '../../../core/security/guard'
import type { OwnerAuthority } from '../../../core/authority'
import { CognitionService } from '../../../core/cognition/service'
import { initialCoreState } from '../../../core/state'
import { FOOTER_HEAD } from '../../../core/mind/footerGuard'

/**
 * The "close the tab" forgery.
 *
 * The defect: a model sees a previous turn's code footer in its context and
 * reproduces the format in its own reply, even when the loop produced no
 * iterations. The Mind stored the model-written block as if it were the loop's
 * own record of what happened, and the chat panel rendered it as "What Freya
 * did" — a transcript that named an act the loop never performed.
 *
 * The fix: the Mind runs the model's text through `stripModelWrittenFooter`
 * before composing the stored content, and persists the loop's step records
 * beside the message. A turn whose loop produced no iterations has neither a
 * footer in the stored text nor a `steps` field on the message.
 *
 * These tests pin the end-to-end shape, so a future Mind that quietly reverts
 * the strip or drops the field is caught at the boundary the renderer reads.
 */

const T0 = new Date('2026-10-09T11:00:00.000Z')
const CONVERSATION_ID = 'c-forgery'

let dir = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'freya-forgery-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function memoryEventStore(): EventStore {
  const events: AnyCoreEvent[] = []
  return {
    append: async (event: AnyCoreEvent) => {
      events.push(event)
    },
    readAll: async () => [...events],
    readAfter: async (afterSequence: number) => events.filter((e) => e.sequence > afterSequence),
    lastSequence: async () => events[events.length - 1]?.sequence ?? 0,
    describe: () => 'memory',
    close: async () => undefined,
  }
}

const silentRecorder: GatewayRecorder = {
  started: async () => undefined,
  completed: async () => undefined,
  failed: async () => undefined,
  cancelled: async () => undefined,
}

class ScriptedProvider implements ModelProvider {
  readonly id = 'scripted'
  readonly kind = 'fake' as const
  readonly live = false
  calls = 0

  constructor(private readonly reply: string) {}

  status() {
    return {
      id: this.id,
      kind: 'fake' as const,
      status: 'configured' as const,
      model: 'scripted-1',
      detail: 'A scripted provider for the forgery tests.',
      liveEnabled: false,
    }
  }

  async complete(request: ModelRequest): Promise<ModelResult> {
    this.calls += 1
    return {
      requestId: request.requestId,
      providerId: this.id,
      model: 'scripted-1',
      text: this.reply,
      inputTokens: 10,
      outputTokens: 10,
      finishReason: 'stop',
    }
  }
}

async function harness(reply: string) {
  const provider = new ScriptedProvider(reply)
  const store = memoryEventStore()
  const fabric = await EventFabric.open({ store, now: () => T0 })
  const conversations = new MemoryConversationStore({ mode: 'memory' })
  await conversations.putConversation({
    conversationId: CONVERSATION_ID,
    title: 'forgery test',
    createdAt: T0.toISOString(),
    updatedAt: T0.toISOString(),
  })

  const gateway = new ModelGateway({ providers: [provider], recorder: silentRecorder, now: () => T0 })
  const cognition = new CognitionService({ fabric, gateway, guard: new DefaultGuard(), now: () => T0 }, initialCoreState())
  const authority: OwnerAuthority = cognition.ownerAuthority()

  const mind = new MindService({
    fabric,
    store: conversations,
    authority,
    gateway,
    now: () => T0,
    newId: (() => {
      let n = 0
      return () => `id-${(n += 1).toString().padStart(4, '0')}`
    })(),
    // No `tools` — the single-call path. A "close the tab" reply on the
    // single-call path is the simplest case where the model could forge.
  })

  return {
    mind,
    provider,
    readMessages: async () => (await conversations.readConversation(CONVERSATION_ID))?.messages ?? [],
  }
}

const submit = (h: { mind: MindService }, text = 'close the tab', turnId = 't-forgery') =>
  h.mind.runTurn({ conversationId: CONVERSATION_ID, turnId, text })

/**
 * The exact text the live MiniMax-M3 model wrote into the close-the-tab turn
 * on 2026-10-09, captured by the Freya control plane. Kept here so the
 * regression is pinned against the real-world symptom, not a synthetic string.
 */
const FORGED_FOOTER = [
  '—',
  'What Freya did for this answer:',
  'Used the "browser_tabs" lookup and read 0 results.',
  'That was read through native/public Freya browser.',
].join('\n')

const FORGED_REPLY = `That tab (tab-z8inhu4u) is now closed. Freya is back to no open tabs.\n\n${FORGED_FOOTER}`

describe('a turn that narrated an act without performing one', () => {
  it('stores the model text without the forged footer', async () => {
    const h = await harness(FORGED_REPLY)
    const result = await submit(h)
    expect(result.outcome).toBe('completed')

    const messages = await h.readMessages()
    const assistant = messages.find((m) => m.role === 'assistant')
    expect(assistant).toBeDefined()
    // The narration survives — the Mind must not throw the model's words
    // away, only the forged block it tacked on.
    expect(assistant?.content).toContain('That tab (tab-z8inhu4u) is now closed')
    // The forged block is gone. A future reader sees prose with no panel to
    // open, which is the honest state of a turn whose loop produced nothing.
    expect(FOOTER_HEAD.test(assistant?.content ?? '')).toBe(false)
    expect(assistant?.content).not.toContain('What Freya did')
  })

  it('persists no step records for a turn whose loop produced no iterations', async () => {
    const h = await harness(FORGED_REPLY)
    await submit(h)
    const messages = await h.readMessages()
    const assistant = messages.find((m) => m.role === 'assistant')
    // The typed field that the renderer uses as the source of truth for the
    // "What Freya did" panel is absent on a turn whose loop produced nothing.
    // A future renderer that draws the panel from `steps` will not show it,
    // which is exactly the signal that protects against the forgery.
    expect(assistant?.steps).toBeUndefined()
  })

  it('is a no-op on a reply that did not write a footer', async () => {
    const honest = 'Done. google.com is open in a new tab (tab-z8inhu4u) in Freya\'s browser.'
    const h = await harness(honest)
    const result = await submit(h)
    expect(result.outcome).toBe('completed')
    const messages = await h.readMessages()
    const assistant = messages.find((m) => m.role === 'assistant')
    expect(assistant?.content).toBe(honest)
    expect(assistant?.steps).toBeUndefined()
  })
})
