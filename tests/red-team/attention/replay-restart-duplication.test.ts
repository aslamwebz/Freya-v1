// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCore, type Core } from '../../../core/index'
import { attentionSource } from '../../../core/testing'
import { FakeModelProvider } from '../../../core/model/fake-provider'

/**
 * REPLAY AND RESTART DUPLICATION.
 *
 * The attack: replay the journal or re-deliver an event after a restart and hope
 * Core decides again, doubling budgets and inbox entries. Decisions live in the
 * journal, so replay folds them rather than repeating them; a re-delivered event
 * is recognised by a stable dedupe key derived from the source's own reference.
 */

interface TwoCores {
  dir: string
  path: string
  first: Core
  second: Core
}

const cores: TwoCores[] = []

async function startTwice(): Promise<TwoCores> {
  const dir = await mkdtemp(join(tmpdir(), 'freya-attention-replay-'))
  const path = join(dir, 'events.jsonl')
  const first = createCore({ dataPath: path, providers: [new FakeModelProvider()] })
  await first.start()
  const second = createCore({ dataPath: path, providers: [new FakeModelProvider()] })
  const pair = { dir, path, first, second }
  cores.push(pair)
  return pair
}

afterEach(async () => {
  for (const pair of cores.splice(0)) {
    await pair.first.stop('teardown').catch(() => undefined)
    await pair.second.stop('teardown').catch(() => undefined)
    await rm(pair.dir, { recursive: true, force: true })
  }
})

describe('replay does not repeat a decision', () => {
  it('keeps the decision count when the same event is re-delivered after a restart', async () => {
    const pair = await startTwice()
    const firstWork = attentionSource(pair.first, 'work')
    await firstWork.ingestInternal({ kind: 'work-finished', text: 'done', sourceRef: 'run-1' })
    await pair.first.stop('restart')
    expect(await countDecisions(pair.path)).toBe(1)

    await pair.second.start()
    const secondWork = attentionSource(pair.second, 'work')
    const outcome = await secondWork.ingestInternal({ kind: 'work-finished', text: 'done', sourceRef: 'run-1' })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.decision.reason).toBe('duplicate')
    // No second decision line was appended.
    expect(await countDecisions(pair.path)).toBe(1)
    expect(pair.second.attention().counts.decisions).toBe(1)
  })

  it('folds a replayed decision rather than re-deciding it', async () => {
    const pair = await startTwice()
    await pair.first.handleCommand({
      command: 'attention.event.ingest',
      requestId: 'r1',
      payload: { kind: 'deadline', text: 'due', dueAt: new Date(Date.now() + 1_000).toISOString() },
    })
    await pair.first.stop('restart')
    await pair.second.start()
    // The projection reports the decision that was already on disk.
    expect(pair.second.attention().counts.decisions).toBe(1)
    expect(pair.second.attention().counts.ingested).toBe(1)
  })
})

async function countDecisions(path: string): Promise<number> {
  try {
    const raw = await readFile(path, 'utf8')
    return raw.split('\n').filter((line) => line.includes('"attention.decision.made"')).length
  } catch {
    return 0
  }
}
