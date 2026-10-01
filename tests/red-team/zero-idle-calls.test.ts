// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  journalEvents,
  startRedTeamCore,
  stopRedTeamCore,
  type RedTeamCore,
} from './harness'

/**
 * Attack family: zero idle model calls.
 *
 * RED-TEAM family 24 (exfiltration hidden in harmless-looking actions) and
 * the "Inspect the whole trace" rule, against Constitution C6 (be truthful
 * about state and action) and the Gateway's "an idle Freya is provably
 * idle" property.
 *
 * The attacks run every surface that is *not* an explicit cognition request,
 * then inspect the whole trace: the provider call count, the gateway's live
 * registry, and the journal's `model.request.*` events. The invariant under
 * attack: nothing spends a provider call unless an explicit, authorized
 * cognition request was made — no background turn, no startup call, no
 * hidden "prefetch" on a read.
 */

let fixture: RedTeamCore | null = null

beforeEach(async () => {
  fixture = await startRedTeamCore()
})

afterEach(async () => {
  await stopRedTeamCore(fixture)
  fixture = null
})

/** The full trace of provider contact: fake calls, live registry, journal. */
function assertZeroProviderCalls(f: RedTeamCore): void {
  expect(f.fake.calls, 'the provider was asked').toBe(0)
  const status = f.core.status()
  // No `?? 0` fallback: `activeProviderCalls` is typed as a number, and a
  // projection that ever regressed to nullish must fail this test loudly
  // rather than be read as zero and let the assertion pass.
  expect(status.activeProviderCalls, 'the live registry').toBe(0)
}

/** No `model.request.*` event of any kind reached the journal. */
async function assertNoModelEvents(f: RedTeamCore, label: string): Promise<void> {
  const events = await journalEvents(f)
  const modelEvents = events.filter(
    (event) => typeof event.type === 'string' && String(event.type).startsWith('model.request.'),
  )
  if (modelEvents.length > 0) {
    throw new Error(
      `red-team leak: idle surface "${label}" produced ${modelEvents.length} model.request event(s)`,
    )
  }
}

describe('attack: startup and idle surfaces are secretly spending', () => {
  it('a freshly started Core has made zero provider calls', async () => {
    const f = fixture!
    assertZeroProviderCalls(f)
    await assertNoModelEvents(f, 'startup')
  })

  it('status reads, subscriptions and projections cost nothing', async () => {
    const f = fixture!
    let notified = 0
    const disposeStatus = f.core.subscribe(() => {
      notified += 1
    })
    const disposeActivity = f.core.onActivity(() => undefined)
    const disposeBrain = f.core.onBrain(() => undefined)
    const disposeWork = f.core.onWork(() => undefined)
    void f.core.activity()
    void f.core.brain()
    void f.core.work()
    void f.core.voice()
    for (let i = 0; i < 5; i += 1) {
      await f.core.conversation()
    }
    for (const command of [
      'core.status.read',
      'security.status.read',
      'cognition.status.read',
      'work.status.read',
      'brain.status.read',
      'voice.status.read',
      'research.status.read',
    ] as const) {
      await f.core.handleCommand({ command, requestId: `read-${command}`, payload: {} })
    }
    assertZeroProviderCalls(f)
    await assertNoModelEvents(f, 'status reads')
    expect(notified).toBeGreaterThan(0)
    disposeStatus()
    disposeActivity()
    disposeBrain()
    disposeWork()
  })

  it('conversation and brain bookkeeping costs nothing', async () => {
    const f = fixture!
    await f.core.handleCommand({
      command: 'conversation.create',
      requestId: 'conv-create',
      payload: { title: 'a title is free' },
    })
    await f.core.handleCommand({ command: 'conversation.list', requestId: 'conv-list', payload: {} })
    await f.core.handleCommand({
      command: 'brain.recall',
      requestId: 'brain-recall',
      payload: { query: 'the owner preferences', limit: 5 },
    })
    await f.core.handleCommand({
      command: 'brain.memory.write',
      requestId: 'brain-write',
      payload: { content: 'a memory write is a local act', kind: 'fact', subject: 'tests' },
    })
    assertZeroProviderCalls(f)
    await assertNoModelEvents(f, 'conversation/brain bookkeeping')
  })

  it('work planning and task management costs nothing', async () => {
    const f = fixture!
    const task = await f.core.handleCommand({
      command: 'work.task.create',
      requestId: 'task-create',
      payload: { title: 'a plan is not a call' },
    })
    expect(task.ok).toBe(true)
    const run = await f.core.handleCommand({
      command: 'work.run.create',
      requestId: 'run-create',
      payload: {
        steps: [
          {
            key: 'probe',
            capability: 'test.record',
            verifier: 'test.record.matches',
            label: 'an inert capability',
          },
        ],
      },
    })
    expect(run.ok).toBe(true)
    assertZeroProviderCalls(f)
    await assertNoModelEvents(f, 'work planning')
  })

  it('voice capture bookkeeping costs nothing', async () => {
    const f = fixture!
    await f.core.handleCommand({
      command: 'voice.capture.start',
      requestId: 'voice-start',
      payload: {},
    })
    await f.core.handleCommand({
      command: 'voice.capture.cancel',
      requestId: 'voice-cancel',
      payload: {},
    })
    assertZeroProviderCalls(f)
    await assertNoModelEvents(f, 'voice capture')
  })

  it('malformed and unknown commands cost nothing', async () => {
    const f = fixture!
    for (const envelope of [
      { command: 'not.a.command', requestId: 'unknown-1', payload: {} },
      { command: 'cognition.request', requestId: 'raw-1', payload: { prompt: 'hello' } },
      { command: '', requestId: 'empty-1', payload: {} },
    ] as const) {
      await f.core.handleCommand(envelope as never)
    }
    // A malformed envelope: refused before dispatch, still nothing spent.
    await f.core.handleCommand(null as never).catch(() => undefined)
    assertZeroProviderCalls(f)
    await assertNoModelEvents(f, 'malformed commands')
  })

  it('denied and refused work costs nothing', async () => {
    const f = fixture!
    // A worker with no grant: refused by the Governor, never by a provider.
    const outcome = await f.worker.request({
      kind: 'agent_step',
      prompt: 'no grant, no call',
      maxOutputTokens: 100,
    })
    expect(outcome.status).toBe('denied')
    assertZeroProviderCalls(f)
    await assertNoModelEvents(f, 'denied worker request')
    // And the refusal itself is durable, so the audit agrees.
    const events = await journalEvents(f)
    const denied = events.filter((event) => event.type === 'cognition.denied')
    expect(denied.length).toBe(1)
  })
})

describe('the positive control: an explicit cognition request does spend', () => {
  it('so the zero above is a property of idleness, not of the probe', async () => {
    const f = fixture!
    const outcome = await f.owner.request({
      kind: 'user_turn',
      prompt: 'a real request',
      maxOutputTokens: 100,
    })
    expect(outcome.status).toBe('allowed')
    expect(f.fake.calls).toBe(1)
    const events = await journalEvents(f)
    const started = events.filter((event) => event.type === 'model.request.started')
    expect(started.length).toBe(1)
    expect(f.core.status().activeProviderCalls).toBe(0)
  })
})
