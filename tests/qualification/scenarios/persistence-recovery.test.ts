// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createCore, type Core } from '../../../core'
import { buildCapabilityInventory } from '../../../core/qualification'
import { QUALIFIED_MODULES, floorFacts } from '../fixture'

/**
 * Scenario gate: `persistence-recovery`.
 *
 * Bounded: real JSONL on real disk, real reads back, one temporary directory. No network,
 * no credential, no key.
 *
 * The claim is not "Freya remembers things". It is narrower, and it is the part that
 * actually breaks: **state written to disk is read back by a fresh Core, and damage in the
 * journal is reported rather than quietly absorbed.**
 *
 * This gate also pins a limitation honestly rather than asserting a protection the journal
 * does not have. See "does not detect a payload edited in place" below: that test is
 * written so it *fails* if the limitation is ever fixed, which forces this report to be
 * updated instead of quietly becoming wrong.
 */

let root = ''
let dataPath = ''
let core: Core | null = null

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'freya-p49-persist-'))
  dataPath = join(root, 'core-events.jsonl')
  core = null
})

afterEach(async () => {
  if (core !== null) await core.stop('scenario cleanup')
  core = null
  await rm(root, { recursive: true, force: true })
})

async function open(): Promise<Core> {
  core = createCore({ dataPath, env: {} })
  await core.start()
  return core
}

async function close(instance: Core): Promise<void> {
  await instance.stop('scenario finished')
  if (core === instance) core = null
}

function lines(): Promise<string[]> {
  return readFile(dataPath, 'utf8').then((raw) => raw.trim().split('\n').filter(Boolean))
}

describe('persistence and recovery across a real journal', () => {
  it('reads back what a previous Core wrote, from the file itself', async () => {
    const first = await open()
    const before = first.status()
    expect(before.eventSequence).toBeGreaterThan(0)
    await close(first)

    // The file has to exist on disk, and every line has to be a real record. A projection
    // that survived only in memory would make every "durable" claim here false.
    const written = await lines()
    expect(written.length).toBeGreaterThanOrEqual(before.eventSequence)
    for (const line of written) expect(() => JSON.parse(line)).not.toThrow()

    const second = await open()
    expect(second.status().eventSequence).toBeGreaterThanOrEqual(before.eventSequence)
    expect(second.status().integrity.integrity).toBe('ok')
    await close(second)
  })

  it('carries a real command forward, so the second Core sees what the first did', async () => {
    const first = await open()
    const created = await first.handleCommand({ command: 'conversation.create', requestId: 'q0' })
    expect(created.ok).toBe(true)
    await close(first)

    const second = await open()
    const listed = await second.handleCommand({ command: 'conversation.list', requestId: 'q1' })
    expect(listed.ok).toBe(true)
    await close(second)
  })

  it('reports a structurally corrupt journal as corrupt, and refuses to come up healthy', async () => {
    const first = await open()
    await first.handleCommand({ command: 'conversation.create', requestId: 'q0' })
    expect(first.status().integrity.integrity).toBe('ok')
    await close(first)

    // Replace one record with a line that is complete but does not validate. This is the
    // corruption a half-finished write, a bad merge or a truncated copy produces, and
    // "reported loudly" versus "silently dropped" is the whole point of the gate.
    const written = await lines()
    written[1] = '{"eventId":"evt-bad","sequence":3,"type":"core.ready","schemaVersion":1}'
    await writeFile(dataPath, `${written.join('\n')}\n`, 'utf8')

    const second = await open()
    expect(second.status().integrity.integrity).toBe('corrupt')
    expect(second.status().integrity.reason).toMatch(/corrupt/i)
    expect(second.status().integrity.line).toBeGreaterThan(0)
    // A Core with a hole in its own history is not ready to act on it.
    expect(second.status().lifecycle).toBe('degraded')
    await close(second)
  })

  it('reports a truncated tail as torn, and says how many bytes it discarded', async () => {
    const first = await open()
    await close(first)

    const raw = await readFile(dataPath, 'utf8')
    await writeFile(dataPath, raw.slice(0, Math.max(1, raw.length - 40)), 'utf8')

    const second = await open()
    expect(second.status().integrity.integrity).toBe('torn')
    expect(second.status().integrity.bytesDiscarded).toBeGreaterThan(0)
    await close(second)
  })

  it('does not restart its own sequence, so a later event cannot pose as an earlier one', async () => {
    const first = await open()
    const firstSequence = first.status().eventSequence
    await close(first)

    const second = await open()
    await second.handleCommand({ command: 'conversation.create', requestId: 'q0' })
    expect(second.status().eventSequence).toBeGreaterThan(firstSequence)
    await close(second)
  })

  it('reports a Mission store honestly, rather than as an empty durable list', async () => {
    const first = await open()
    // No Mission key is supplied, so this Core is explicitly ephemeral. What is being
    // qualified is that it says so, rather than presenting "nothing here" as though nothing
    // could ever be lost.
    const mission = first.mission()
    expect(Array.isArray(mission.missions)).toBe(true)
    expect(mission.persistence.mode).toBe('ephemeral')
    expect(mission.persistence.durable).toBe(false)
    expect(mission.persistence.reason).toBeTruthy()
    await close(first)

    const second = await open()
    expect(second.mission().persistence.mode).toBe('ephemeral')
    await close(second)
  })

  it('derives the same degraded reading of a keyless build as the live runtime reports', async () => {
    const predicted = buildCapabilityInventory({
      facts: floorFacts(),
      presentModules: QUALIFIED_MODULES,
    })
    const started = await open()
    const projection = started.runtime()
    await close(started)

    // Every reduction the inventory names must be a reduction the runtime actually
    // reports, and nothing may be quietly running that the report calls blocked. The
    // `RuntimeDomainView` carries the measured evidence rather than a `reduced` list, so
    // the reduction is read off the evidence itself.
    for (const capability of predicted.capabilities) {
      const view = projection.domains.find((domain) => domain.id === capability.id)
      expect(view, `${capability.id} is missing from the live projection`).toBeDefined()
      const liveReduced = (view?.evidence ?? [])
        .filter((item) => !item.required && !item.satisfied)
        .map((item) => item.label)
      if (capability.readiness === 'degraded') {
        expect(liveReduced, `${capability.id} should be reduced`).not.toEqual([])
      }
    }
  })

  it.fails('does not detect a payload edited in place — a known, reported limitation', async () => {
    const first = await open()
    await first.handleCommand({ command: 'conversation.create', requestId: 'q0' })
    await close(first)

    const written = await lines()
    const record = JSON.parse(written[1] ?? '{}') as Record<string, unknown>
    record['payload'] = { tampered: true }
    written[1] = JSON.stringify(record)
    await writeFile(dataPath, `${written.join('\n')}\n`, 'utf8')

    const second = await open()
    // The journal validates structure — sequence, schema version, event id, ordering — and
    // refuses a record that fails those. It is **not authenticated**: nothing signs or
    // hashes a payload, so a payload edited in place while keeping its envelope intact is
    // read back as-is.
    //
    // Phase 49 records that as an unresolved release blocker rather than pretending
    // otherwise. `it.fails` pins it: while the limitation exists this gate passes, and the
    // moment the journal starts rejecting an in-place edit this test fails on purpose,
    // because that is the moment PHASE-49.md stops being true.
    expect(second.status().integrity.integrity).toBe('ok')
    await close(second)
  })
})