// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createCore, type Core } from '../../../core/index'
import type { CoreCommandName, CoreCommandResult } from '../../../core/protocol/core-protocol'
import { FakeModelProvider } from '../../../core/model/fake-provider'
import { RUNTIME_REGISTRY } from '../../../core/runtime'
import type { RuntimeProjection } from '../../../core/runtime'

/**
 * Runtime activation inside a real Core.
 *
 * The claims this file proves: the registry is served truthfully; STOP ALL is
 * respected; a restart reconciles; nothing here costs a model call; and the
 * blocked domains stay blocked with the dependency that would have to be
 * supplied before a later phase could activate them.
 */

let requestCounter = 0

function statusOf(projection: RuntimeProjection, id: string): string {
  const domain = projection.domains.find((entry) => entry.id === id)
  if (domain === undefined) throw new Error(`no domain ${id}`)
  return domain.status
}

async function startCore(dir: string): Promise<{ core: Core; fake: FakeModelProvider }> {
  const fake = new FakeModelProvider()
  const core = createCore({ dataPath: join(dir, 'events.jsonl'), providers: [fake] })
  await core.start()
  return { core, fake }
}

async function submit(core: Core, command: string, payload?: unknown): Promise<CoreCommandResult> {
  requestCounter += 1
  return core.handleCommand({
    command: command as CoreCommandName,
    requestId: `r-${requestCounter}`,
    payload,
  })
}

describe('Core.runtime()', () => {
  it('reports registered domains before start, without inventing status', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'freya-runtime-core-'))
    try {
      const core = createCore({ dataPath: join(dir, 'events.jsonl'), providers: [new FakeModelProvider()] })
      const projection = core.runtime()
      expect(projection.lifecycle).toBe('unstarted')
      expect(projection.domains).toHaveLength(RUNTIME_REGISTRY.length)
      expect(projection.domains.every((domain) => domain.status === 'registered')).toBe(true)
      expect(projection.counts.registered).toBe(RUNTIME_REGISTRY.length)
      expect(core.status().lifecycle).toBe('booting')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('serves a truthful active/available/blocked split after start', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'freya-runtime-core-'))
    const { core, fake } = await startCore(dir)
    try {
      const projection = core.runtime()
      expect(projection.lifecycle).toBe('active')

      // Core-owned domains with every dependency satisfied are active.
      for (const id of [
        'core.security-spine',
        'core.missions',
        'core.work',
        'core.context',
        'core.workforce',
        'core.attention',
        'core.office',
        'core.skills',
        'core.world',
        'core.life',
        'core.consciousness',
        'core.lifeloop',
        'core.foundry',
      ]) {
        expect(statusOf(projection, id), id).toBe('active')
      }

      // Core-owned domains whose optional dependency is absent are degraded, not
      // active: no conversation key, no connector, no local speech engine, no
      // Vault. That is the truthful reading rather than an optimistic one.
      for (const id of ['core.conversation', 'core.brain', 'core.personality', 'core.relay', 'core.voice', 'core.vault']) {
        expect(statusOf(projection, id), id).toBe('degraded')
      }

      // Fail-closed and un-wired domains are blocked, not silently active.
      for (const id of [
        'core.economic',
        'core.enterprise',
        'core.multidevice',
        'core.device-hands',
        'core.long-horizon',
        'core.resilience',
      ]) {
        expect(statusOf(projection, id), id).toBe('blocked')
      }

      // Registered, dependency-checked, not activated by this build.
      for (const id of ['core.sovereignty', 'core.evolution', 'core.threshold']) {
        expect(statusOf(projection, id), id).toBe('available')
      }

      // Every domain is counted exactly once.
      const total = Object.values(projection.counts).reduce((sum, value) => sum + value, 0)
      expect(total).toBe(RUNTIME_REGISTRY.length)

      // Device Hands states the exact dependency it is missing.
      const hands = projection.domains.find((entry) => entry.id === 'core.device-hands')
      expect(hands?.missing.join(' ')).toMatch(/adapter/i)
      expect(hands?.missing.join(' ')).toMatch(/grant/i)

      // Reading the projection costs nothing.
      expect(fake.calls).toBe(0)
    } finally {
      await core.stop('test')
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('journals its decisions durably and serves them to a subscriber', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'freya-runtime-core-'))
    const { core } = await startCore(dir)
    try {
      const seen: RuntimeProjection[] = []
      const dispose = core.onRuntime((projection) => seen.push(projection))
      expect(seen.length).toBeGreaterThanOrEqual(1)
      expect(seen[0]?.domains.length).toBe(RUNTIME_REGISTRY.length)
      dispose()

      const events = await (
        core as unknown as { fabric?: { readAll(): Promise<{ type: string }[]> } }
      ).fabric?.readAll()
      const runtimeEvents = (events ?? []).filter((event) => event.type.startsWith('runtime.'))
      expect(runtimeEvents.length).toBeGreaterThanOrEqual(RUNTIME_REGISTRY.length)
    } finally {
      await core.stop('test')
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('stops activated domains on STOP ALL and brings them back on resume', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'freya-runtime-core-'))
    const { core } = await startCore(dir)
    try {
      expect(statusOf(core.runtime(), 'core.work')).toBe('active')

      const stop = await submit(core, 'security.stopAll', { reason: 'test' })
      expect(stop.ok).toBe(true)
      const stopped = core.runtime()
      expect(stopped.stopAllActive).toBe(true)
      expect(statusOf(stopped, 'core.work')).toBe('blocked')
      // The security spine is what enforces the stop, so it stays.
      expect(statusOf(stopped, 'core.security-spine')).toBe('active')

      const resume = await submit(core, 'security.resume')
      expect(resume.ok).toBe(true)
      const resumed = core.runtime()
      expect(resumed.stopAllActive).toBe(false)
      expect(statusOf(resumed, 'core.work')).toBe('active')
    } finally {
      await core.stop('test')
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reconciles truthfully across a Core restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'freya-runtime-core-'))
    try {
      const first = await startCore(dir)
      expect(statusOf(first.core.runtime(), 'core.work')).toBe('active')
      await first.core.stop('restart test')

      const second = await startCore(dir)
      const projection = second.core.runtime()
      expect(projection.lifecycle).toBe('active')
      // A clean shutdown stopped the domains, so the restart brings them back:
      // the journal records that reactivation as a change from the stopped state.
      expect(statusOf(projection, 'core.work')).toBe('active')
      const events = await (
        second.core as unknown as { fabric?: { readAll(): Promise<{ type: string }[]> } }
      ).fabric?.readAll()
      expect((events ?? []).some((event) => event.type === 'runtime.activation.changed')).toBe(true)
      // The fail-closed domains are still blocked after a restart.
      expect(statusOf(projection, 'core.economic')).toBe('blocked')
      await second.core.stop('restart test')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

})
