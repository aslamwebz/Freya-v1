// @vitest-environment node
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createCore, type Core, type CoreOptions } from '../../../core/index'
import { FakeModelProvider } from '../../../core/model/fake-provider'
import { MemoryConversationStore } from '../../../core/conversation/memory-store'
import {
  WAKE_ACTORS,
  WAKE_SOURCES,
  analyseZeroIdleInference,
  findTimerUsageInSource,
  findUnboundedLoopInSource,
  type LifeLoopJournalEntry,
} from '../../../core/lifeloop'

/**
 * ATTACK: the Continuous Life Loop.
 *
 * The promises Phase 23 makes are about money, about a human being's attention, and
 * about a panic button. Every one of those is worth only as much as the thing that
 * tries to break it, so this suite is written as attacks rather than as features:
 *
 *   - a renderer, a model, an agent, a connector, a webhook or a timer tries to wake
 *     the loop;
 *   - a hand-edited journal tries to make a spent call look authorized, or an
 *     unauthorized one look authorized;
 *   - an event payload tries to carry a capability, a grant or a verdict;
 *   - a restart is used as a way to buy a fresh budget;
 *   - STOP ALL is used as a thing that clears itself;
 *   - and the source is scanned for the two shapes a runaway loop takes.
 */

const AT = new Date('2026-10-03T12:00:00.000Z')
const AT_PLUS_1H = new Date('2026-10-03T13:00:00.000Z')

let dir = ''
let clock = AT
let core: Core | null = null

async function start(overrides: Partial<CoreOptions> = {}): Promise<Core> {
  const built = createCore({
    dataPath: join(dir, 'events.jsonl'),
    providers: [new FakeModelProvider()],
    conversationStore: new MemoryConversationStore({ mode: 'memory' }),
    now: () => new Date(clock),
    lifeLoop: { observeSubsystemEvents: true },
    attentionObserveSources: false,
    ...overrides,
  })
  core = built
  await built.start()
  return built
}

async function journalPath(): Promise<string> {
  return join(dir, 'events.jsonl')
}

async function entries(): Promise<LifeLoopJournalEntry[]> {
  const raw = await readFile(await journalPath(), 'utf8')
  return raw
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const event = JSON.parse(line) as {
        type: string
        occurredAt: string
        payload: Record<string, unknown>
      }
      return { type: event.type, recordedAt: event.occurredAt, payload: event.payload }
    })
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'freya-lifeloop-redteam-'))
  clock = AT
})

afterEach(async () => {
  await core?.stop('red-team-teardown')
  core = null
  await rm(dir, { recursive: true, force: true })
})

describe('attack: a renderer or a model tries to drive the loop', () => {
  it('has no verb to do it with, and the assertion is against the bridge itself', async () => {
    // Checked against the source of the preload rather than against a mock, because a
    // mock only proves the test author believed it.
    const files = await readdir(join(process.cwd(), 'electron'))
    const preload = await readFile(join(process.cwd(), 'electron', 'preload.ts'), 'utf8')
    expect(files).toContain('preload.ts')
    // The command allowlist is where a write verb would have to appear. There is no
    // `lifeloop.` entry, no `lifeloopTick`, and no method on the bridge that accepts
    // a wake, a source, an outcome or a deadline.
    expect(preload.includes("'lifeloop.")).toBe(false)
    expect(/coreLifeLoop[A-Za-z]*\([^)]*(source|kind|outcome|deadline|wake)/i.test(preload)).toBe(false)
    for (const verb of ['coreLifeLoopWake', 'coreLifeLoopTick', 'coreLifeLoopStop', 'coreLifeLoopResume']) {
      expect(preload.includes(verb), verb).toBe(false)
    }
  })

  it('refuses every wake vocabulary an unauthorized actor could offer', async () => {
    // Exhaustion over the actor table rather than examples. `model`, `renderer`,
    // `agent`, `connector`, `external-webhook` and `timer` appear nowhere on the
    // right-hand side of the pairing table, so this is a property of the table.
    const { validateWake, WAKE_SOURCE_ACTOR } = await import('../../../core/lifeloop')
    for (const actor of WAKE_ACTORS) {
      for (const source of WAKE_SOURCES) {
        const outcome = validateWake(
          {
            wakeId: 'w',
            source,
            kind: 'system-health',
            goalRef: null,
            sourceRef: 'x',
            occurredAt: AT.toISOString(),
            observedAt: AT.toISOString(),
          },
          {
            actor,
            now: AT.toISOString(),
            stopAllActive: false,
            journalTrustworthy: true,
            loopState: 'IDLE',
          },
        )
        const authorized = WAKE_SOURCE_ACTOR[source] === actor
        if (!authorized) {
          expect(
            outcome.outcome === 'accepted',
            `${actor} was able to raise ${source}`,
          ).toBe(false)
        }
      }
    }
    // And the six that must never be authorized for anything are named here so the
    // table cannot grow one quietly.
    for (const actor of ['model', 'renderer', 'agent', 'connector', 'external-webhook', 'timer'] as const) {
      expect(Object.values(WAKE_SOURCE_ACTOR)).not.toContain(actor)
    }
  })
})

describe('attack: a hand-edited journal makes a spent call look authorized', () => {
  it('is reported as a violation rather than believed', async () => {
    // A provider contact with a wake in front of it, but no grant and no standing
    // filter clearance. This is the shape an attacker would hand-write, and the
    // assertion exists to say it is caught.
    const report = analyseZeroIdleInference({
      entries: [
        { type: 'lifeloop.wake.received', recordedAt: AT.toISOString(), payload: { wakeId: 'w' } },
        { type: 'lifeloop.action.started', recordedAt: AT.toISOString(), payload: { wakeId: 'w' } },
        { type: 'cognition.requested', recordedAt: AT.toISOString(), payload: { requestId: 'r1', origin: 'system' } },
        { type: 'model.request.started', recordedAt: AT.toISOString(), payload: { requestId: 'r1', grantId: null } },
      ],
    })
    expect(report.holds).toBe(false)
    expect(report.violations.map((violation) => violation.code)).toContain(
      'background-call-without-grant',
    )
    expect(report.checks.noBackgroundReasoning).toBe(false)
  })

  it('is reported for a model call with no wake behind it at all', async () => {
    const report = analyseZeroIdleInference({
      entries: [
        { type: 'cognition.requested', recordedAt: AT.toISOString(), payload: { requestId: 'r1', origin: 'agent' } },
        { type: 'cognition.allowed', recordedAt: AT.toISOString(), payload: { requestId: 'r1', grantId: 'g' } },
        { type: 'model.request.started', recordedAt: AT.toISOString(), payload: { requestId: 'r1', grantId: 'g' } },
      ],
    })
    expect(report.holds).toBe(false)
    expect(report.violations.map((violation) => violation.code)).toContain(
      'model-call-without-wake',
    )
  })

  it('is reported for a model call while STOP ALL was in force', async () => {
    const report = analyseZeroIdleInference({
      entries: [
        { type: 'lifeloop.wake.received', recordedAt: AT.toISOString(), payload: { wakeId: 'w' } },
        { type: 'lifeloop.filter.passed', recordedAt: AT.toISOString(), payload: { wakeId: 'w' } },
        { type: 'security.stop_all.activated', recordedAt: AT.toISOString(), payload: { by: 'owner' } },
        {
          type: 'cognition.requested',
          recordedAt: AT.toISOString(),
          payload: { requestId: 'r1', origin: 'system' },
        },
      ],
    })
    expect(report.violations.map((violation) => violation.code)).toContain(
      'model-call-while-stop-all',
    )
  })

  it('is reported when an authority-shaped key is written into a life-loop payload', async () => {
    // Authority is minted by the Guard and the Governor, never by an event. So a
    // payload carrying one is not a new field, it is an escalation attempt — and the
    // journal is the last place it should be able to appear.
    for (const key of ['capability', 'grant', 'grantId', 'authority', 'verdict', 'approved', 'token', 'budget']) {
      const report = analyseZeroIdleInference({
        entries: [
          { type: 'lifeloop.filter.passed', recordedAt: AT.toISOString(), payload: { wakeId: 'w', [key]: 'granted' } },
        ],
      })
      expect(report.violations.map((violation) => violation.code), key).toContain(
        'authority-key-in-payload',
      )
    }
  })

  it('is reported when the Core validator is asked to accept one, and the log stays readable', async () => {
    // The journal is written first and validated on the way back *in*, so a payload
    // that fails does reach disk. That is why this attack is checked against the
    // validator directly rather than by writing a line and hoping: a rejected line
    // truncates the log on the next read, and takes the derived security state with
    // it.
    const { validateDurableEvent } = await import('../../../core/events/validate')
    const result = validateDurableEvent(
      {
        eventId: 'e1',
        sequence: 1,
        type: 'lifeloop.filter.passed',
        schemaVersion: 1,
        occurredAt: AT.toISOString(),
        source: 'core',
        actor: 'system',
        correlationId: 'c1',
        causationId: null,
        payload: { wakeId: 'w', capability: 'cognition.request' },
      },
      0,
    )
    expect(result.ok).toBe(false)
  })
})

describe('attack: a restart is used as a free reset', () => {
  it('changes no decision, spends nothing, and preserves every ceiling', async () => {
    const c = await start()
    await c.handleCommand({ command: 'conversation.create', requestId: 'c1', payload: {} })
    const before = c.lifeLoop()
    await c.stop('first process')
    const second = await start()
    const after = second.lifeLoop()
    // The state is the same, the counters are the same, and the ceilings are the same
    // object as reported — a restart is not a way to widen a bound.
    expect(after.state).toBe(before.state)
    expect(after.counters).toEqual(before.counters)
    expect(after.limits).toEqual(before.limits)
    // And the second launch adds no spend.
    const types = (await entries()).map((entry) => entry.type)
    expect(types.filter((type) => type === 'model.request.started')).toHaveLength(0)
  })

  it('does not let a folded retry allowance be re-derived from nothing', async () => {
    // The attempt count is journaled precisely so this cannot happen: a step that
    // crashes the app on every try would otherwise be retried three times per
    // launch, for ever.
    const h = { entries: [] as LifeLoopJournalEntry[] }
    const { reduceLifeLoopState } = await import('../../../core/lifeloop')
    const entry = (type: string, payload: Record<string, unknown>): LifeLoopJournalEntry => ({
      type,
      recordedAt: AT.toISOString(),
      payload,
    })
    h.entries.push(
      entry('lifeloop.wake.received', {
        wakeId: 'w1', source: 'work-transition', kind: 'run-completed', wakeKey: 'k',
        iteration: 0, goalRef: 'goal-1', sourceRef: 'run-9',
        occurredAt: AT.toISOString(), observedAt: AT.toISOString(),
      }),
      entry('lifeloop.filter.passed', { wakeId: 'w1', wakeKey: 'k', code: 'cognition-justified', iteration: 0 }),
      entry('lifeloop.action.started', { wakeId: 'w1', iteration: 0, actionIndex: 1, deadlineType: 'action', deadlineExpiresAt: AT_PLUS_1H.toISOString() }),
      entry('lifeloop.action.failed', { wakeId: 'w1', iteration: 0, actionIndex: 1, code: 'boom' }),
      entry('lifeloop.reset', { wakeId: 'w1', iteration: 0, code: 'retry' }),
    )
    const first = reduceLifeLoopState(h.entries).state
    expect(first.attemptCount).toBe(1)
    // A second launch over the same journal, and a fresh wake about the *same* goal.
    const carried = [...h.entries, entry('lifeloop.wake.received', {
      wakeId: 'w2', source: 'work-transition', kind: 'run-completed', wakeKey: 'k2',
      iteration: 0, goalRef: 'goal-1', sourceRef: 'run-9',
      occurredAt: AT.toISOString(), observedAt: AT.toISOString(),
    })]
    expect(reduceLifeLoopState(carried).state.attemptCount).toBe(1)
    // A genuinely different unit of work starts fresh, which is the only reset.
    const other = [...h.entries, entry('lifeloop.wake.received', {
      wakeId: 'w3', source: 'work-transition', kind: 'run-completed', wakeKey: 'k3',
      iteration: 0, goalRef: 'goal-2', sourceRef: 'run-10',
      occurredAt: AT.toISOString(), observedAt: AT.toISOString(),
    })]
    expect(reduceLifeLoopState(other).state.attemptCount).toBe(0)
  })
})

describe('attack: STOP ALL is used as a thing that clears itself', () => {
  it('cannot be cleared by any life-loop entry except the owner resume', async () => {
    const { reduceLifeLoopState } = await import('../../../core/lifeloop')
    const entry = (type: string, payload: Record<string, unknown>): LifeLoopJournalEntry => ({
      type,
      recordedAt: AT.toISOString(),
      payload,
    })
    const latched = entry('lifeloop.stopped', { wakeId: '', iteration: 0, code: 'stop-all-latched' })
    for (const attempt of [
      entry('lifeloop.reset', { wakeId: '', iteration: 0, code: 'closed-out' }),
      entry('lifeloop.reconciled', { code: 'restart-recovery', from: 'STOP', wakeId: '', iteration: 0, deadlineType: null, deadlineExpiresAt: null }),
      entry('lifeloop.unstopped', { code: 'stop-latch-cleared' }),
    ]) {
      const folded = reduceLifeLoopState([latched, attempt])
      // `unstopped` is the one the owner causes, and it is still refused here because
      // this journal has no `security.stop_all.cleared` behind it — Core is the
      // boundary, and the fold's job is only to insist a stop existed.
      expect(folded.state.state, `${attempt.type} moved a latched loop`).toBe('STOP')
    }
    // And the owner's own resume, through Core, is what actually lifts it.
    const c = await start()
    await c.handleCommand({ command: 'security.stopAll', requestId: 's1', payload: { reason: 'attack' } })
    expect(c.lifeLoop().isStopped).toBe(true)
    await c.handleCommand({ command: 'security.resume', requestId: 'r1', payload: {} })
    expect(c.lifeLoop().isStopped).toBe(false)
  })

  it('spends nothing while latched, however many authoritative events arrive', async () => {
    const c = await start()
    await c.handleCommand({ command: 'security.stopAll', requestId: 's2', payload: { reason: 'attack' } })
    for (let index = 0; index < 5; index += 1) {
      await c.attentionTick(clock)
    }
    const types = (await entries()).map((entry) => entry.type)
    expect(types.filter((type) => type === 'model.request.started')).toHaveLength(0)
    expect(types.filter((type) => type === 'cognition.requested')).toHaveLength(0)
  })
})

describe('attack: a schedule backlog is turned into a stampede', () => {
  it('costs at most one wake per tick and no model calls', async () => {
    const c = await start()
    for (let index = 0; index < 12; index += 1) {
      await c.handleCommand({
        command: 'attention.schedule.register',
        requestId: `sched-${index}`,
        payload: {
          kind: 'reminder',
          text: 'look again',
          dueAt: AT.toISOString(),
          condition: 'always',
        },
      })
    }
    const fired = await c.attentionTick(clock)
    // Attention's own bound holds at 64 and fires all twelve; the loop is offered at
    // most one, because it is single-threaded and the rest would be refused as busy.
    const types = (await entries()).map((entry) => entry.type)
    expect(types.filter((type) => type === 'lifeloop.wake.received')).toHaveLength(1)
    expect(types.filter((type) => type === 'model.request.started')).toHaveLength(0)
    expect(fired).toBe(12)
  })
})

describe('attack: the projection is used as a side channel', () => {
  it('carries no prompt, no answer, no provider and no event text', async () => {
    const c = await start()
    await c.handleCommand({ command: 'conversation.create', requestId: 'c9', payload: { title: 'FREYA_SENTINEL_TITLE' } })
    await c.attentionTick(clock)
    const serialised = JSON.stringify(c.lifeLoop())
    for (const sentinel of ['FREYA_SENTINEL_TITLE', 'prompt', 'grantId', 'providerId', 'model']) {
      expect(serialised.includes(sentinel), `leaked ${sentinel}`).toBe(false)
    }
  })

  it('keeps the loop\'s own writes out of the journal as prose', async () => {
    const c = await start()
    await c.handleCommand({ command: 'conversation.create', requestId: 'c8', payload: { title: 'FREYA_SENTINEL_TITLE' } })
    await c.attentionTick(clock)
    const raw = await readFile(await journalPath(), 'utf8')
    for (const line of raw.split('\n').filter((entry) => entry.includes('lifeloop.'))) {
      expect(line.includes('FREYA_SENTINEL_TITLE')).toBe(false)
      // Every life-loop line is metadata. A long string in one of these is how the
      // least protected file in the system becomes a transcript.
      for (const value of Object.values(JSON.parse(line).payload as Record<string, unknown>)) {
        if (typeof value === 'string') expect(value.length).toBeLessThanOrEqual(200)
      }
    }
  })
})

describe('attack: the source contains a loop that runs on its own', () => {
  it('has no timer anywhere in the life loop', async () => {
    // Structural rather than behavioural, and that is the point: a heartbeat that
    // re-arms itself is a heartbeat that runs on a stopped Freya, and a loop that
    // schedules its own next tick is a loop nobody bounded. The word "setInterval"
    // appears in this very file's comments, which is why the scan strips them.
    const dirPath = join(process.cwd(), 'core', 'lifeloop')
    const files = await readdir(dirPath)
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      if (!file.endsWith('.ts')) continue
      const source = await readFile(join(dirPath, file), 'utf8')
      expect(findTimerUsageInSource(source), file).toEqual([])
      expect(findUnboundedLoopInSource(source), file).toEqual([])
    }
  })

  it('has no timer in the Core wiring either', async () => {
    // Core already had exactly one `setTimeout` before this phase — the bounded drain
    // race in `drainResearch` — and this phase adds none. So the assertion is on the
    // *polling* shapes rather than on every timer: a `setInterval` or an animation
    // frame in Core would be a self-running loop, and there is none. The per-file
    // scan above covers `core/lifeloop/` completely, timers included.
    const source = await readFile(join(process.cwd(), 'core', 'index.ts'), 'utf8')
    const findings = findTimerUsageInSource(source)
    expect(findings, 'Core gained a polling primitive').not.toContain('setInterval')
    expect(findings, 'Core gained a frame-driven loop').not.toContain('requestAnimationFrame')
    expect(findings, 'Core gained an unconditional loop').not.toContain('while-true')
    // Exactly the pre-existing research drain, and nothing else.
    expect(findings.filter((finding) => finding === 'setTimeout')).toHaveLength(1)
  })
})

describe('attack: the zero-idle promise is checked rather than believed', () => {
  it('holds over a journal this Core actually wrote, across every phase of the loop', async () => {
    const c = await start()
    await c.handleCommand({ command: 'conversation.create', requestId: 'c7', payload: {} })
    await c.attentionTick(clock)
    await c.handleCommand({ command: 'security.stopAll', requestId: 's3', payload: { reason: 'attack' } })
    await c.handleCommand({ command: 'security.resume', requestId: 'r3', payload: {} })
    await c.stop('attack')
    const report = analyseZeroIdleInference({ entries: await entries() })
    expect(report.violations).toEqual([])
    expect(report.holds).toBe(true)
    expect(Object.values(report.checks)).toEqual(Object.values(report.checks).map(() => true))
  })
})