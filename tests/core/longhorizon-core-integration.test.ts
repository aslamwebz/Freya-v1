// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCore, type Core } from '../../core/index'
import { FakeModelProvider } from '../../core/model/fake-provider'
import { StaticVaultKeyProvider } from '../../core/vault'
import { testVaultKey } from './testKey'
import { bindingAvailable, loadTestBinding } from './vault/binding'
import type { GoalProjectionView } from '../../core/protocol/longhorizon'

let dir: string
let core: Core | undefined

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'freya-goal-int-'))
})

afterEach(async () => {
  await core?.stop('teardown')
  core = undefined
  await rm(dir, { recursive: true, force: true })
})

describe('Phase 5A — LongHorizon Production Core Integration', () => {
  it('exposes truthful initial goal projection in ephemeral mode when vault is absent', async () => {
    const dataPath = join(dir, 'events.jsonl')
    core = createCore({
      dataPath,
      providers: [new FakeModelProvider()],
    })
    await core.start()

    const proj = core.goals()
    expect(proj.persistence.mode).toBe('ephemeral')
    expect(proj.persistence.durable).toBe(false)
    expect(proj.counts.total).toBe(0)
    expect(proj.counts.active).toBe(0)
    expect(proj.counts.draft).toBe(0)
    expect(proj.goals).toHaveLength(0)
  })

  it('exposes durable encrypted persistence mode when vault is configured', async () => {
    if (!bindingAvailable) return
    const dataPath = join(dir, 'events.jsonl')
    const vaultPath = join(dir, 'freya.db')
    const binding = await loadTestBinding()

    core = createCore({
      dataPath,
      providers: [new FakeModelProvider()],
      vault: {
        path: vaultPath,
        keyProvider: new StaticVaultKeyProvider(testVaultKey()),
        binding,
      },
    })
    await core.start()

    const proj = core.goals()
    expect(proj.persistence.mode).toBe('encrypted')
    expect(proj.persistence.durable).toBe(true)
    expect(proj.persistence.reason).toBeNull()
  })

  it('executes full goal lifecycle (create -> activate -> pause -> resume -> cancel) via Core commands', async () => {
    const dataPath = join(dir, 'events.jsonl')
    core = createCore({
      dataPath,
      providers: [new FakeModelProvider()],
    })
    await core.start()

    const updates: GoalProjectionView[] = []
    core.onGoals((p) => updates.push(p))

    // 1. Create Draft Goal
    const createRes = await core.handleCommand({
      command: 'goal.create',
      requestId: 'cmd-1',
      payload: {
        title: 'Launch Autonomous Product',
        description: 'Design, develop, and deploy software product over 3 months',
        completionCriteria: ['Market research complete', 'Core MVP deployed', 'Telemetry active'],
      },
    })

    expect(createRes.ok).toBe(true)
    expect(createRes.goal).toBeDefined()
    expect(createRes.goal!.operation).toBe('created')
    expect(createRes.goal!.state).toBe('draft')
    const goalId = createRes.goal!.goalId!
    expect(goalId).toBeDefined()

    // 2. Read status
    const statusRes = await core.handleCommand({
      command: 'goal.status.read',
      requestId: 'cmd-read',
    })
    expect(statusRes.ok).toBe(true)
    expect(statusRes.goal?.operation).toBe('status')

    // 3. Activate Goal
    const activateRes = await core.handleCommand({
      command: 'goal.activate',
      requestId: 'cmd-2',
      payload: { goalId },
    })
    expect(activateRes.ok).toBe(true)
    expect(activateRes.goal!.operation).toBe('activated')
    expect(activateRes.goal!.state).toBe('active')

    expect(core.goals().counts.active).toBe(1)
    expect(core.goals().counts.draft).toBe(0)

    // 4. Pause Goal
    const pauseRes = await core.handleCommand({
      command: 'goal.pause',
      requestId: 'cmd-3',
      payload: { goalId },
    })
    expect(pauseRes.ok).toBe(true)
    expect(pauseRes.goal!.operation).toBe('paused')
    expect(pauseRes.goal!.state).toBe('paused')
    expect(core.goals().counts.paused).toBe(1)

    // 5. Resume Goal
    const resumeRes = await core.handleCommand({
      command: 'goal.resume',
      requestId: 'cmd-4',
      payload: { goalId },
    })
    expect(resumeRes.ok).toBe(true)
    expect(resumeRes.goal!.operation).toBe('resumed')
    expect(resumeRes.goal!.state).toBe('active')

    // 6. Cancel Goal
    const cancelRes = await core.handleCommand({
      command: 'goal.cancel',
      requestId: 'cmd-5',
      payload: { goalId },
    })
    expect(cancelRes.ok).toBe(true)
    expect(cancelRes.goal!.operation).toBe('cancelled')
    expect(cancelRes.goal!.state).toBe('cancelled')
    expect(core.goals().counts.cancelled).toBe(1)
    expect(core.goals().counts.active).toBe(0)

    // Verify listeners received updates
    expect(updates.length).toBeGreaterThan(1)
  })

  it('preserves private content privacy split and retrieves content via goalDetail', async () => {
    const dataPath = join(dir, 'events.jsonl')
    core = createCore({
      dataPath,
      providers: [new FakeModelProvider()],
    })
    await core.start()

    const createRes = await core.handleCommand({
      command: 'goal.create',
      requestId: 'cmd-priv',
      payload: {
        title: 'Confidential Strategic Goal',
        description: 'Sensitive private details about market expansion',
        completionCriteria: ['Step A', 'Step B'],
      },
    })
    expect(createRes.ok).toBe(true)
    const goalId = createRes.goal!.goalId!

    // Broad projection: MUST NOT expose title, description, or criteria
    const projection = core.goals()
    const summary = projection.goals.find((g) => g.goalId === goalId)!
    expect(summary).toBeDefined()
    expect((summary as Record<string, unknown>).title).toBeUndefined()
    expect((summary as Record<string, unknown>).description).toBeUndefined()
    expect((summary as Record<string, unknown>).completionCriteria).toBeUndefined()

    // Explicit detail read: MUST return private content
    const detail = await core.goalDetail(goalId)
    expect(detail).not.toBeNull()
    expect(detail!.goalId).toBe(goalId)
    expect(detail!.content).not.toBeNull()
    expect(detail!.content!.title).toBe('Confidential Strategic Goal')
    expect(detail!.content!.description).toBe('Sensitive private details about market expansion')
    expect(detail!.content!.completionCriteria).toEqual(['Step A', 'Step B'])
  })

  it('recovers goal state and encrypted content across Core restart with SQLCipher Vault', async () => {
    if (!bindingAvailable) return
    const dataPath = join(dir, 'events.jsonl')
    const vaultPath = join(dir, 'freya.db')
    const binding = await loadTestBinding()

    // Session 1: Create and activate goal
    core = createCore({
      dataPath,
      providers: [new FakeModelProvider()],
      vault: {
        path: vaultPath,
        keyProvider: new StaticVaultKeyProvider(testVaultKey()),
        binding,
      },
    })
    await core.start()

    const createRes = await core.handleCommand({
      command: 'goal.create',
      requestId: 'cmd-persist',
      payload: {
        title: 'Long-term Autonomous Architecture',
        description: 'Pursue multi-week capability deployment',
        completionCriteria: ['Phase 5A complete', 'Phase 5B complete'],
      },
    })
    expect(createRes.ok).toBe(true)
    const goalId = createRes.goal!.goalId!

    await core.handleCommand({
      command: 'goal.activate',
      requestId: 'cmd-act',
      payload: { goalId },
    })
    expect(core.goals().counts.active).toBe(1)

    // Stop Core Session 1
    await core.stop('clean-restart')
    core = undefined

    // Session 2: Restart Core with same data and Vault
    core = createCore({
      dataPath,
      providers: [new FakeModelProvider()],
      vault: {
        path: vaultPath,
        keyProvider: new StaticVaultKeyProvider(testVaultKey()),
        binding,
      },
    })
    await core.start()

    // Recovery semantics: Active goals at shutdown are reconciled to paused with 'recovery' reason
    const projAfterRestart = core.goals()
    expect(projAfterRestart.counts.total).toBe(1)
    expect(projAfterRestart.counts.active).toBe(0)
    expect(projAfterRestart.counts.paused).toBe(1)

    const summaryAfterRestart = projAfterRestart.goals.find((g) => g.goalId === goalId)!
    expect(summaryAfterRestart.state).toBe('paused')
    expect(summaryAfterRestart.reason).toBeNull()

    // Detail decrypts faithfully from the SQLCipher vault
    const detailAfterRestart = await core.goalDetail(goalId)
    expect(detailAfterRestart).not.toBeNull()
    expect(detailAfterRestart!.content).not.toBeNull()
    expect(detailAfterRestart!.content!.title).toBe('Long-term Autonomous Architecture')
    expect(detailAfterRestart!.content!.description).toBe('Pursue multi-week capability deployment')
    expect(detailAfterRestart!.content!.completionCriteria).toEqual(['Phase 5A complete', 'Phase 5B complete'])

    // Resume recovered goal
    const resumeRes = await core.handleCommand({
      command: 'goal.resume',
      requestId: 'cmd-resume',
      payload: { goalId },
    })
    expect(resumeRes.ok).toBe(true)
    expect(resumeRes.goal!.state).toBe('active')
    expect(core.goals().counts.active).toBe(1)
    expect(core.goals().counts.paused).toBe(0)
  })

  it('refuses goal mutations when STOP ALL is active', async () => {
    const dataPath = join(dir, 'events.jsonl')
    core = createCore({
      dataPath,
      providers: [new FakeModelProvider()],
    })
    await core.start()

    // Trigger STOP ALL
    await core.handleCommand({
      command: 'security.stopAll',
      requestId: 'cmd-panic',
    })

    const createRes = await core.handleCommand({
      command: 'goal.create',
      requestId: 'cmd-stopped',
      payload: {
        title: 'Should be refused',
        description: 'Cannot start work during stop all',
      },
    })

    expect(createRes.ok).toBe(false)
    expect(createRes.goal?.ok).toBe(false)
    expect(createRes.goal?.reason).toContain('STOP ALL is active')
  })

  it('settles goal as failed with specified reason and records it in projection', async () => {
    const dataPath = join(dir, 'events.jsonl')
    core = createCore({
      dataPath,
      providers: [new FakeModelProvider()],
    })
    await core.start()

    const createRes = await core.handleCommand({
      command: 'goal.create',
      requestId: 'cmd-fail-init',
      payload: {
        title: 'Goal destined to block',
        description: 'Testing honest failure reason recording',
      },
    })
    const goalId = createRes.goal!.goalId!

    await core.handleCommand({
      command: 'goal.activate',
      requestId: 'cmd-act-2',
      payload: { goalId },
    })

    const failRes = await core.handleCommand({
      command: 'goal.fail',
      requestId: 'cmd-fail-run',
      payload: {
        goalId,
        reason: 'hard_blocker',
      },
    })

    expect(failRes.ok).toBe(true)
    expect(failRes.goal!.operation).toBe('settled-failed')
    expect(failRes.goal!.state).toBe('failed')

    const proj = core.goals()
    const summary = proj.goals.find((g) => g.goalId === goalId)!
    expect(summary.state).toBe('failed')
    expect(summary.reason).toBe('hard_blocker')
    expect(summary.settledAt).not.toBeNull()
    expect(summary.needsAttention).toBe(true)
  })

  it('rejects malformed goal command payloads honestly', async () => {
    const dataPath = join(dir, 'events.jsonl')
    core = createCore({
      dataPath,
      providers: [new FakeModelProvider()],
    })
    await core.start()

    // Missing title
    const resNoTitle = await core.handleCommand({
      command: 'goal.create',
      requestId: 'cmd-notitle',
      payload: { description: 'has description only' },
    })
    expect(resNoTitle.ok).toBe(false)
    expect(resNoTitle.refusal?.reason).toContain('title is missing')

    // Missing goalId on activate
    const resNoId = await core.handleCommand({
      command: 'goal.activate',
      requestId: 'cmd-noid',
      payload: {},
    })
    expect(resNoId.ok).toBe(false)
    expect(resNoId.refusal?.reason).toContain('id is missing')
  })
})
