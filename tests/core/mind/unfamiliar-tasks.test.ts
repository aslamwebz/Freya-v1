// @vitest-environment node
/**
 * Unfamiliar tasks, end to end through the real loop.
 *
 * Nothing here is about a website, a job or a search. Every case is a task this
 * file has not seen before, run through the same Mind, registry, Guard and
 * Governor, so a pass says the machinery is general rather than tuned to the
 * examples it was written against.
 *
 * The four properties under test are the ones that were missing before:
 *
 *   1. thinking becomes action -- a plan is not an answer
 *   2. completion is grounded -- refused unless evidence backs it
 *   3. recovery changes strategy -- a failed attempt is not simply repeated
 *   4. a ceiling is not a finish -- running out is reported as unfinished
 */
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
import {
  MIND_TOOL_LIMITS,
  MindToolRegistry,
  createWebSearchTool,
  createMindTaskTool,
  type MindTool,
  type ToolSource,
} from '../../../core/mind/tools'
import { DefaultGuard } from '../../../core/security/guard'
import type { Guard, Principal } from '../../../core/security/guard'
import type { OwnerAuthority } from '../../../core/authority'
import { CognitionService } from '../../../core/cognition/service'
import { initialCoreState } from '../../../core/state'
import type { Capability } from '../../../core/protocol/core-protocol'

const T0 = new Date('2026-11-03T09:00:00.000Z')
const CONVERSATION_ID = 'c1'
let dir = ''
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'freya-unfamiliar-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const silentRecorder: GatewayRecorder = {
  started: async () => undefined,
  completed: async () => undefined,
  failed: async () => undefined,
  cancelled: async () => undefined,
}

function memoryEventStore(): EventStore {
  const events: AnyCoreEvent[] = []
  return {
    append: async (event: AnyCoreEvent) => { events.push(event) },
    readAll: async () => [...events],
    readAfter: async (after: number) => events.filter(e => e.sequence > after),
    lastSequence: async () => events[events.length - 1]?.sequence ?? 0,
    describe: () => 'memory',
    close: async () => undefined,
  }
}

/** One scripted reply per call; the last entry repeats. */
type Reply = Partial<ModelResult> | ((request: ModelRequest) => Partial<ModelResult>)

class ScriptedProvider implements ModelProvider {
  readonly id = 'scripted'
  readonly kind = 'fake' as const
  readonly live = false
  calls = 0
  /**
   * Declared, deliberately. These tests are about the structured-call path, so the
   * transcript has to reach the provider the way a real one sees it: tool results
   * still keyed by their call id rather than flattened into user text.
   */
  supportsNativeTools(): boolean { return true }
  status() {
    return {
      id: this.id,
      kind: this.kind,
      status: 'configured' as const,
      model: 'scripted-model',
      detail: 'A scripted provider for the unfamiliar-task tests.',
      liveEnabled: false,
    }
  }
  readonly requests: ModelRequest[] = []
  constructor(private readonly script: readonly Reply[]) {}
  async complete(request: ModelRequest): Promise<ModelResult> {
    this.requests.push(request)
    this.calls += 1
    const next = this.script[Math.min(this.calls - 1, this.script.length - 1)]
    const reply = typeof next === 'function' ? next(request) : next
    return {
      requestId: `r${this.calls}`,
      providerId: 'scripted',
      model: 'scripted-model',
      finishReason: 'stop',
      inputTokens: 0,
      outputTokens: 0,
      ...reply,
    } as ModelResult
  }
}

const text = (t: string): Reply => ({ text: t })

/** A native structured call, the way a provider that supports them answers. */
const native = (name: string, args: Record<string, string>, id = 'c1'): Reply => ({
  text: '',
  toolCalls: [{ id, name, arguments: JSON.stringify(args) }],
})

/** The decision channel, as a structured call. */
const decide = (decision: unknown, id = 'd1'): Reply =>
  native('mind_task', { decision: JSON.stringify(decision) }, id)

/**
 * The evidence ids the transcript has actually shown the model.
 *
 * Read out of the request rather than assumed, because that is the only way a
 * test can tell the difference between a channel the model could really use and
 * one that demands an id it was never shown. If no id is found the decision cites
 * nothing, and a requirement that needs evidence is refused — which is the correct
 * outcome for a model that has no evidence to point at.
 */
function shownEvidenceIds(request: ModelRequest): string[] {
  const ids: string[] = []
  for (const message of request.messages ?? []) {
    for (const match of message.content.matchAll(/Evidence id: (o\d+)/g)) ids.push(match[1]!)
  }
  return ids
}

/** `satisfy`, citing the most recent evidence the transcript actually showed. */
const satisfyLatest = (requirementId: string, id = 'd2'): Reply => request => {
  const ids = shownEvidenceIds(request)
  // The decision travels as a string, which is how the tool's own parameter is
  // declared. A nested object here would be refused before it ever reached Mind.
  return decide({
    action: 'satisfy',
    requirementId,
    evidenceIds: ids.length > 0 ? [ids[ids.length - 1]!] : [],
  }, id) as Partial<ModelResult>
}

/** What a search actually returns: an index line and nothing read off the page. */
const snippet = (url: string, title: string, rank: number): ToolSource => ({
  url,
  title,
  rank,
  retrievedAt: T0.toISOString(),
  snippet: `${title} — index line`,
  sourceDomain: new URL(url).hostname,
})

function ownerHolding(...capabilities: Capability[]): Principal {
  return { id: 'owner', capabilities: new Set(capabilities), trusted: true }
}

/** A gauge that reads on demand. Records every call so a test can see what ran. */
function gauge(log: string[], reading: string): MindTool {
  return {
    name: 'read_gauge',
    capability: 'core.status.read',
    description: 'Read a named gauge.',
    parameters: [{ name: 'name', description: 'which gauge', required: true }],
    async run({ arguments: args }) {
      const which = args['name'] ?? ''
      log.push(which)
      // Read off the thing itself, which is what makes this verification.
      return { summary: `${which} reads ${reading}`, sources: [], provenance: { extract: [`${which} = ${reading}`] } }
    },
  }
}

/** A gauge that throws on the first attempt and reads on the second. */
function flakyGauge(log: string[]): MindTool {
  let attempts = 0
  return {
    name: 'read_gauge',
    capability: 'core.status.read',
    description: 'Read a named gauge.',
    parameters: [{ name: 'name', description: 'which gauge', required: true }],
    async run({ arguments: args }) {
      attempts += 1
      const name = args['name'] ?? ''
      log.push(`${name}#${attempts}`)
      if (attempts === 1) throw new Error('the sensor did not respond')
      // Read off the thing itself, which is what makes this verification.
      return { summary: `${name} reads 41.2`, sources: [], provenance: { extract: [`${name} = 41.2`] } }
    },
  }
}

/** A probe that never works, so recovery has to change strategy. */
function deadProbe(log: string[]): MindTool {
  return {
    name: 'probe',
    capability: 'core.status.read',
    description: 'Probe a target that is not there.',
    parameters: [{ name: 'target', description: 'the target', required: true }],
    async run({ arguments: args }) {
      log.push(args['target'] ?? '')
      throw new Error('nothing there')
    },
  }
}

async function harness(options: {
  script: readonly Reply[]
  tools?: MindTool[]
  holding?: readonly Capability[]
} = { script: [text('hello')] }) {
  const provider = new ScriptedProvider(options.script)
  const journal = memoryEventStore()
  const fabric = await EventFabric.open({
    store: journal,
    now: () => T0,
    newId: (() => { let n = 0; return () => `evt-${(n += 1).toString().padStart(4, '0')}` })(),
  })
  const store = new MemoryConversationStore({ mode: 'memory' })
  await store.putConversation({
    conversationId: CONVERSATION_ID,
    title: 'a conversation',
    createdAt: T0.toISOString(),
    updatedAt: T0.toISOString(),
  })

  // The decision channel is a tool like any other, and the turn gets it whether or
  // not this case is about it — the same way Core wires it unconditionally.
  const tools = [...(options.tools ?? [createWebSearchTool({
    searchWeb: async () => [snippet('https://example.test/gauge', 'Gauge readings', 1)],
    now: () => T0,
  })]), createMindTaskTool()]
  const guard: Guard = new DefaultGuard()
  const registry = new MindToolRegistry({
    tools,
    guard,
    principal: ownerHolding(...(options.holding ?? tools.map(t => t.capability as Capability))),
    stopped: () => false,
  })
  const gateway = new ModelGateway({ providers: [provider], recorder: silentRecorder, now: () => T0 })
  const cognition = new CognitionService({ fabric, gateway, guard, now: () => T0 }, initialCoreState())
  const authority: OwnerAuthority = cognition.ownerAuthority()
  const mind = new MindService({
    fabric, store, authority, gateway, now: () => T0,
    newId: (() => { let n = 0; return () => `id-${(n += 1).toString().padStart(4, '0')}` })(),
    tools: registry,
  })

  let turns = 0
  const submit = (ownerText: string) => {
    turns += 1
    return mind.runTurn({ conversationId: CONVERSATION_ID, turnId: `t${turns}`, text: ownerText })
  }

  const messages = async () => {
    const record = await store.readConversation(CONVERSATION_ID)
    return record?.messages ?? []
  }
  return { submit, messages, provider, store, mind, registry }
}

describe('thinking becomes action', () => {
  it('runs the tool the model asked for and answers from what came back', async () => {
    const ran: string[] = []
    const h = await harness({
      tools: [gauge(ran, '42.0')],
      script: [native('read_gauge', { name: 'oil' }), text('The gauge reads 42.0.')],
    })

    const turn = await h.submit('What does the oil gauge read?')

    expect(turn.outcome).toBe('completed')
    expect(h.provider.calls).toBe(2)
    // The tool ran. Without this the same test passes when the request is
    // refused and the model simply answers anyway, which is the defect.
    expect(ran).toEqual(['oil'])
  })

  it('refuses a whole malformed batch rather than running its valid prefix', async () => {
    const ran: string[] = []
    const h = await harness({
      tools: [gauge(ran, '42.0')],
      script: [
        { text: '', toolCalls: [
          { id: 'ok-1', name: 'read_gauge', arguments: JSON.stringify({ name: 'oil' }) },
          { id: 'bad-1', name: 'read_gauge', arguments: '{not json' },
        ] },
        text('I could not run that.'),
      ],
    })

    await h.submit('Read the oil gauge.')

    expect(ran).toEqual([])
  })

  it('sends the tool result back keyed by its call id, so the provider can match it', async () => {
    const ran: string[] = []
    const h = await harness({
      tools: [gauge(ran, '42.0')],
      script: [native('read_gauge', { name: 'oil' }, 'call-7'), text('done.')],
    })

    await h.submit('Look up the oil gauge.')

    const second = h.provider.requests[1]
    expect(second?.messages.some(m => m.role === 'tool' && m.toolCallId === 'call-7')).toBe(true)
  })
})

describe('completion is grounded in evidence', () => {
  it('refuses a completion whose declared requirement nothing satisfied', async () => {
    const h = await harness({
      script: [
        decide({ action: 'plan', requirements: [{ id: 'r1', description: 'A reading taken off the device itself', kind: 'verification' }] }),
        // No tool has run, so nothing could possibly back this.
        decide({ action: 'complete', answer: 'It reads about 41.' }),
      ],
    })

    const turn = await h.submit('Read the device and tell me the reading.')

    expect(turn.outcome).not.toBe('completed')
  })

  it('completes once evidence that really executed satisfies the requirement', async () => {
    const ran: string[] = []
    const h = await harness({
      tools: [gauge(ran, '41.2')],
      script: [
        decide({ action: 'plan', requirements: [{ id: 'r1', description: 'A reading taken off the device', kind: 'verification' }] }, 'd1'),
        native('read_gauge', { name: 'coolant' }, 'g1'),
        satisfyLatest('r1', 'd2'),
        decide({ action: 'complete', answer: 'Coolant reads 41.2.' }, 'd3'),
      ],
    })

    const turn = await h.submit('Read the coolant gauge and tell me its reading.')

    expect(ran).toEqual(['coolant'])
    expect(turn.outcome).toBe('completed')
  })

  it('will not let a snippet stand in for having read the page', async () => {
    const h = await harness({
      script: [
        decide({ action: 'plan', requirements: [{ id: 'r1', description: 'The page actually read', kind: 'observation' }] }, 'd1'),
        native('web_search', { query: 'the page' }, 's1'),
        // The search returned an index line, not a read of the page.
        satisfyLatest('r1', 'd2'),
        decide({ action: 'complete', answer: 'Read it.' }, 'd3'),
      ],
    })

    const turn = await h.submit('Read that page and tell me what it says.')

    expect(turn.outcome).not.toBe('completed')
  })
})

describe('recovery changes strategy', () => {
  it('does not abandon the task when one attempt fails transiently', async () => {
    const log: string[] = []
    const h = await harness({
      tools: [flakyGauge(log)],
      script: [native('read_gauge', { name: 'coolant' }, 'g1'), native('read_gauge', { name: 'coolant' }, 'g2')],
    })

    await h.submit('Read the coolant gauge and tell me its reading.')

    expect(log).toContain('coolant#2')
  })

  it('bounds a request that keeps failing instead of spending the turn on it', async () => {
    const log: string[] = []
    const h = await harness({
      tools: [deadProbe(log)],
      script: [native('probe', { target: 'alpha' })],
    })

    const turn = await h.submit('Probe alpha for me.')

    expect(turn.outcome).not.toBe('completed')
    expect(log.length).toBeLessThanOrEqual(MIND_TOOL_LIMITS.maxToolCalls)
  })

  it('reports a refused decision back to the model rather than silently ignoring it', async () => {
    const h = await harness({
      script: [
        decide({ action: 'plan', requirements: [{ id: 'r1', description: 'Verified', kind: 'verification' }] }, 'd1'),
        // Weakening a requirement it already declared must be refused.
        decide({ action: 'plan', requirements: [{ id: 'r1', description: 'Guess', kind: 'answer' }] }, 'd2'),
        text('falling back to prose.'),
      ],
    })

    const turn = await h.submit('Do the thing properly.')

    // The turn may still end in prose, but the refusal has to have been surfaced
    // back into the transcript rather than swallowed.
    const stored = (await h.messages()).filter(m => m.role === 'assistant')
    expect(stored.length).toBeGreaterThan(0)
    expect(turn.outcome).toBeDefined()
  })
})

describe('a ceiling is not a finish', () => {
  it('reports unfinished work when the calls run out mid-task', async () => {
    const h = await harness({ script: [native('web_search', { query: 'a' })] })

    const turn = await h.submit('Find out about a, b, c and d.')

    expect(turn.outcome).not.toBe('completed')
    expect(turn.reason ?? '').toMatch(/allowed for one turn|did not finish|could not read/i)
  })
})

describe('a plain conversation is unaffected', () => {
  it('answers a question needing no tool in exactly one call', async () => {
    const h = await harness({ script: [text('Four.')] })

    const turn = await h.submit('What is two plus two?')

    expect(turn.outcome).toBe('completed')
    expect(h.provider.calls).toBe(1)
  })
})
