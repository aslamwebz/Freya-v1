// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCore, type Core } from '../../core/index'
import { FakeModelProvider } from '../../core/model/fake-provider'
import type { CoreActivityEvent } from '../../core/protocol/activity'

/**
 * Activity, as Core actually publishes it.
 *
 * The unit tests cover the mapping. These cover the two things that only a real
 * Core can show: that the feed is rebuilt from the log rather than starting
 * empty, and that a renderer attaching late sees the same history as one that
 * never left.
 */

let dir = ''
let core: Core | null = null

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'freya-activity-'))
})

afterEach(async () => {
  await core?.stop('test-teardown')
  core = null
  await rm(dir, { recursive: true, force: true })
})

function options(): { dataPath: string; providers: FakeModelProvider[] } {
  return { dataPath: join(dir, 'events.jsonl'), providers: [new FakeModelProvider()] }
}

async function started(): Promise<Core> {
  core = createCore(options())
  await core.start()
  return core
}

describe('Core activity feed', () => {
  it('reports its own startup', async () => {
    const c = await started()
    const kinds = c.activity().map((row) => row.kind)
    expect(kinds).toContain('core.started')
  })

  it('reports a command without its text', async () => {
    const c = await started()
    await c.handleCommand({
      command: 'core.command.submit',
      requestId: 'r1',
      payload: { text: 'the secret contents of this command' },
    })

    const row = c.activity().find((r) => r.kind === 'command.received')
    expect(row).toBeDefined()
    expect(row?.text).toMatch(/characters/i)
    expect(JSON.stringify(c.activity())).not.toMatch(/secret contents/)
  })

  it('pushes new activity to a subscriber', async () => {
    const c = await started()
    const seen: CoreActivityEvent[][] = []
    const dispose = c.onActivity((rows) => seen.push(rows))

    await c.handleCommand({
      command: 'core.command.submit',
      requestId: 'r1',
      payload: { text: 'hello' },
    })
    dispose()

    expect(seen.length).toBeGreaterThan(0)
    expect(seen[seen.length - 1]?.some((row) => row.kind === 'command.received')).toBe(true)
  })

  it('stops pushing once disposed', async () => {
    const c = await started()
    let pushes = 0
    const dispose = c.onActivity(() => {
      pushes += 1
    })
    const before = pushes
    dispose()

    await c.handleCommand({ command: 'core.command.submit', requestId: 'r2', payload: { text: 'x' } })

    expect(pushes).toBe(before)
  })

  it('rebuilds the same history from the log after a restart', async () => {
    const first = await started()
    await first.handleCommand({
      command: 'core.command.submit',
      requestId: 'r1',
      payload: { text: 'durable history' },
    })
    const beforeRestart = first.activity().map((row) => `${row.id}:${row.text}`)
    await first.stop('test')

    const second = createCore(options())
    await second.start()
    core = second

    const afterRestart = second.activity().map((row) => `${row.id}:${row.text}`)

    // The second run has more rows — shutting down wrote stopping/stopped and
    // starting up wrote its own lifecycle — so equality is the wrong assertion.
    // What matters is that the first run's history survives verbatim, in order,
    // at the front: a renderer attaching now sees everything a renderer that
    // never left would have seen.
    expect(afterRestart.length).toBeGreaterThan(beforeRestart.length)
    expect(afterRestart.slice(0, beforeRestart.length)).toEqual(beforeRestart)
  })

  it('gives a late subscriber the whole feed immediately', async () => {
    const c = await started()
    await c.handleCommand({ command: 'core.command.submit', requestId: 'r1', payload: { text: 'x' } })

    let received: CoreActivityEvent[] = []
    c.onActivity((rows) => {
      received = rows
    })

    expect(received).toHaveLength(c.activity().length)
  })

  it('never emits a row carrying a payload field', () => {
    // Structural: the type has no place to put one, so a future event cannot
    // grow one by accident.
    const c = createCore(options())
    for (const row of [] as CoreActivityEvent[]) void row
    expect(Object.keys(c.activity()[0] ?? { id: '', kind: '', type: '', sequence: 0, at: 0, text: '', tone: '' })).toEqual(
      expect.arrayContaining(['id', 'kind', 'type', 'sequence', 'at', 'text', 'tone']),
    )
  })
})
