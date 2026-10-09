// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCore, type Core, type CoreOptions } from '../../core/index'
import { FakeModelProvider } from '../../core/model/fake-provider'
import { workforceOwnerScope } from '../../core/testing'
import { WorkRegistry } from '../../core/work/capability'
import { registerFileInspection } from '../../core/work/file-inspection'
import type { EventFabric } from '../../core/events/fabric'
import type { Principal } from '../../core/security/guard'
import type { MissionEngine } from '../../core/missions/engine'
import { EncryptedMissionStore } from '../../core/missions/encrypted-store'

let dir: string
let core: Core | undefined
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'freya-mind-missions-')) })
afterEach(async () => { await core?.stop('teardown'); core = undefined; await rm(dir, { recursive: true, force: true }) })

it('plans a natural goal, executes two actual file inspections and continues on verified events', async () => {
  const file = join(dir, 'private-example.txt')
  await writeFile(file, 'actual file data')
  const provider = new FakeModelProvider()
  const complete = vi.spyOn(provider, 'complete').mockImplementation(async request => ({
    requestId: request.requestId, providerId: provider.id, model: provider.model,
    inputTokens: 30, outputTokens: 100,
    text: JSON.stringify({ steps: [
      { intent: 'Inspect the supplied file', capability: 'filesystem.inspect', input: { path: file }, dependsOn: [] },
      { intent: 'Recheck the same file', capability: 'filesystem.inspect', input: { path: file }, dependsOn: [0] },
    ] }),
  }))
  core = createCore({ dataPath: join(dir, 'events.jsonl'), providers: [provider], missionKey: new Uint8Array(32).fill(9), missionReadRoots: [dir] })
  await core.start()
  const result = await core.handleCommand({ command: 'mission.create', requestId: 'create', payload: { title: 'Inspect file', intent: `Inspect ${file} twice and verify its metadata.` } })
  const id = result.mission!.missionId!
  const scope = workforceOwnerScope(core)
  const worker = await scope.createWorker({ name: 'Inspector', specialisation: 'general' })
  await scope.assignCapability(worker.workerId!, 'cognition.request')
  await core.handleCommand({ command: 'cognition.grant.create', requestId: 'grant', payload: {
    grantId: 'planning-grant', expiresAt: new Date(Date.now() + 60000).toISOString(),
    allowedOrigins: ['agent'], allowedCauses: ['run_finished'], goalId: id,
    backgroundAllowed: true, maxCalls: 1, maxOutputTokens: 2048,
  } })
  const planned = await core.planMissionGoal({ missionId: id, grantId: 'planning-grant', continueAfterVerification: true })
  expect(planned).toMatchObject({ ok: true })
  if (!planned.ok) throw new Error('planning refused')
  expect(planned.plan.steps[1]?.dependsOn).toEqual([planned.plan.steps[0]!.stepId])
  expect(planned.plan.steps.every(step => step.risk === 'routine' && step.verifier === 'filesystem.inspect.verified')).toBe(true)
  expect(complete).toHaveBeenCalledTimes(1)
  expect(complete.mock.calls[0]![0].prompt).toContain(JSON.stringify(file).slice(1, -1))
  await core.advanceMission(id, 'manual')
  await vi.waitFor(() => expect(core!.mission().missions.find(mission => mission.missionId === id)?.status).toBe('completed'), { timeout: 10000 })
  expect(core.work().runs.filter(run => run.parentId === id)).toHaveLength(2)
  expect(await readFile(file, 'utf8')).toBe('actual file data')
  expect(await readFile(join(dir, 'events.jsonl'), 'utf8')).not.toContain(file)
  expect(await readFile(join(dir, 'events.jsonl'), 'utf8')).not.toContain(JSON.stringify(file).slice(1, -1))
  expect(await readFile(join(dir, 'events.jsonl'), 'utf8')).not.toContain('Inspect the supplied file')
  expect(await readFile(join(dir, 'events.jsonl.missions'), 'utf8')).not.toContain(file)
  expect(runs(id).every(run => run.status === 'completed' && run.steps.every(step => step.status === 'verified'))).toBe(true)
  expect(complete).toHaveBeenCalledTimes(1)
  await core.stop('restart-completed-mission')
  core = createCore({ dataPath: join(dir, 'events.jsonl'), providers: [provider], missionKey: new Uint8Array(32).fill(9), missionReadRoots: [dir] })
  await core.start()
  expect(core.mission().missions.find(mission => mission.missionId === id)?.status).toBe('completed')
  expect(runs(id)).toHaveLength(2)
  expect(complete).toHaveBeenCalledTimes(1)
})

function internal() {
  return core as unknown as { fabric: EventFabric; owner: Principal; missionEngine: MissionEngine; workRegistry: WorkRegistry }
}

async function started(options: Partial<CoreOptions> = {}, proposal?: (file: string) => unknown) {
  const file = join(dir, 'private-example.txt')
  await writeFile(file, 'actual file data')
  const provider = new FakeModelProvider()
  const complete = vi.spyOn(provider, 'complete').mockImplementation(async request => ({
    requestId: request.requestId, providerId: provider.id, model: provider.model,
    inputTokens: 30, outputTokens: 100,
    text: JSON.stringify(proposal ? proposal(file) : { steps: [
      { intent: 'Inspect the supplied file', capability: 'filesystem.inspect', input: { path: file }, dependsOn: [] },
      { intent: 'Recheck the same file', capability: 'filesystem.inspect', input: { path: file }, dependsOn: [0] },
    ] }),
  }))
  const config: CoreOptions = { dataPath: join(dir, 'events.jsonl'), providers: [provider], missionKey: new Uint8Array(32).fill(9), missionReadRoots: [dir], ...options }
  core = createCore(config)
  await core.start()
  const result = await core.handleCommand({ command: 'mission.create', requestId: 'create', payload: { title: 'Inspect file', intent: `Inspect ${file} twice and verify its metadata.` } })
  expect(result.ok).toBe(true)
  const id = result.mission!.missionId!
  const scope = workforceOwnerScope(core)
  const worker = await scope.createWorker({ name: 'Inspector', specialisation: 'general' })
  expect(await scope.assignCapability(worker.workerId!, 'cognition.request')).toMatchObject({ ok: true })
  expect(await core.handleCommand({ command: 'cognition.grant.create', requestId: 'grant', payload: {
    grantId: 'planning-grant', expiresAt: new Date(Date.now() + 60000).toISOString(),
    allowedOrigins: ['agent'], allowedCauses: ['run_finished'], goalId: id,
    backgroundAllowed: true, maxCalls: 1, maxOutputTokens: 2048,
  } })).toMatchObject({ ok: true })
  return { file, id, complete, config }
}

function view(id: string) { return core!.mission().missions.find(mission => mission.missionId === id)! }
function runs(id: string) { return core!.work().runs.filter(run => run.parentId === id) }
function prepare(id: string, continueAfterVerification = false) {
  return core!.planMissionGoal({ missionId: id, grantId: 'planning-grant', continueAfterVerification })
}

it.each([
  ['unknown capability', 'private.not.registered', {}, [], 'capability_unavailable'],
  ['test fixture capability', 'test.record', {}, [], 'capability_unavailable'],
  ['forward dependency', 'filesystem.inspect', { path: 'x' }, [1], 'invalid_proposal'],
  ['nested execution input', 'filesystem.inspect', { path: { unsafe: true } }, [], 'invalid_proposal'],
] as const)('refuses %s without creating any Work', async (_label, capability, input, dependsOn, reason) => {
  const { id } = await started({}, () => ({ steps: [{ intent: 'Private proposed task', capability, input, dependsOn }] }))
  expect(await prepare(id, true)).toEqual({ ok: false, reason })
  expect(view(id).status).toBe('blocked')
  expect(runs(id)).toHaveLength(0)
  expect(internal().missionEngine.record(id)?.activePlan).toBeNull()
  expect(await readFile(join(dir, 'events.jsonl'), 'utf8')).not.toContain('private.not.registered')
})

it('rejects model authority fields', async () => {
  const { id, complete } = await started({}, file => ({ steps: [{ intent: 'Inspect', capability: 'filesystem.inspect', input: { path: file }, dependsOn: [], requiresApproval: false }] }))
  expect(await prepare(id)).toEqual({ ok: false, reason: 'invalid_proposal' })
  expect(complete).toHaveBeenCalledTimes(1)
  expect(runs(id)).toHaveLength(0)
})

it('does not contact a model without an existing scoped grant', async () => {
  const { id, complete } = await started()
  expect(await core!.planMissionGoal({ missionId: id, grantId: 'missing-grant' })).toEqual({ ok: false, reason: 'planning_denied' })
  expect(complete).not.toHaveBeenCalled()
  expect(runs(id)).toHaveLength(0)
  expect(view(id).status).toBe('blocked')
})

it('refuses planning if encrypted durable content is unavailable', async () => {
  const { id, complete } = await started({ missionKey: undefined })
  expect(await prepare(id)).toEqual({ ok: false, reason: 'mission_unavailable' })
  expect(complete).not.toHaveBeenCalled()
})

it('refuses planning when a real journal open failure causes temporary event storage', async () => {
  const directoryInsteadOfFile = join(dir, 'not-a-log-file')
  await mkdir(directoryInsteadOfFile)
  const { id, complete } = await started({ dataPath: directoryInsteadOfFile })
  expect(await prepare(id)).toEqual({ ok: false, reason: 'mission_unavailable' })
  expect(complete).not.toHaveBeenCalled()
  expect(runs(id)).toHaveLength(0)
})

it('enforces a narrowed durable model budget before contacting the provider', async () => {
  const { complete } = await started()
  const mission = await internal().missionEngine.create({ title: 'No model budget', intent: 'Inspect a file' }, undefined, { budget: { maxModelCalls: 1 } })
  expect(mission.ok).toBe(true)
  await internal().missionEngine.charge({ missionId: mission.missionId!, modelCalls: 1, actions: 0, externalRequests: 0, retries: 0, delegations: 0 })
  expect(await prepare(mission.missionId!)).toEqual({ ok: false, reason: 'budget_exhausted' })
  expect(complete).not.toHaveBeenCalled()
  expect(view(mission.missionId!).status).toBe('blocked')
})

it('rejects a proposal exceeding the remaining action budget', async () => {
  const { complete, file } = await started()
  const mission = await internal().missionEngine.create({ title: 'One action', intent: `Inspect ${file}` }, undefined, { budget: { maxActions: 1 } })
  expect(mission.ok).toBe(true)
  expect(await core!.handleCommand({ command: 'cognition.grant.create', requestId: 'limited-grant', payload: {
    grantId: 'limited-plan', expiresAt: new Date(Date.now() + 60000).toISOString(),
    allowedOrigins: ['agent'], allowedCauses: ['run_finished'], goalId: mission.missionId!,
    backgroundAllowed: true, maxCalls: 1, maxOutputTokens: 2048,
  } })).toMatchObject({ ok: true })
  expect(await core!.planMissionGoal({ missionId: mission.missionId!, grantId: 'limited-plan' })).toEqual({ ok: false, reason: 'budget_exhausted' })
  expect(complete).toHaveBeenCalledTimes(1)
  expect(runs(mission.missionId!)).toHaveLength(0)
})

it('refuses Work execution after actual principal capability withdrawal', async () => {
  const { id } = await started()
  expect(await prepare(id, true)).toMatchObject({ ok: true })
  internal().owner = { ...internal().owner, capabilities: new Set([...internal().owner.capabilities].filter(capability => capability !== 'work.execute')) }
  await core!.advanceMission(id, 'manual')
  expect(runs(id)).toHaveLength(0)
  expect(view(id).status).toBe('blocked')
})

it('fails a path outside host-authorized roots without claiming success or retrying', async () => {
  await mkdir(join(dir, 'allowed'))
  const { id, file } = await started({ missionReadRoots: [join(dir, 'allowed')] })
  expect(await prepare(id, true)).toMatchObject({ ok: true })
  await core!.advanceMission(id, 'manual')
  expect(view(id).status).toBe('blocked')
  expect(runs(id)).toHaveLength(1)
  expect(runs(id)[0]?.status).toBe('failed')
  expect(runs(id)[0]?.actions).toHaveLength(1)
  expect(await readFile(file, 'utf8')).toBe('actual file data')
  expect(await readFile(join(dir, 'events.jsonl'), 'utf8')).not.toContain(file)
})

it.each(['malformed JSON', 'truncated JSON', 'provider failure'])('records %s as a planning failure with no fixture fallback', async scenario => {
  const { id, complete, file } = await started()
  complete.mockImplementationOnce(async request => {
    if (scenario === 'provider failure') throw new Error('Private provider error')
    return { requestId: request.requestId, providerId: 'fake', model: 'echo', inputTokens: 30, outputTokens: 100,
      text: scenario === 'malformed JSON' ? 'Here is a plan: no JSON' : JSON.stringify({ steps: [{ intent: 'Inspect', capability: 'filesystem.inspect', input: { path: file }, dependsOn: [] }] }),
      finishReason: scenario === 'truncated JSON' ? 'length' : 'stop',
    }
  })
  expect(await prepare(id, true)).toMatchObject({ ok: false })
  expect(view(id).status).toBe('blocked')
  await core!.advanceMission(id, 'manual')
  expect(runs(id)).toHaveLength(0)
  expect(complete).toHaveBeenCalledTimes(1)
})

it('does not commit a delayed plan after STOP ALL', async () => {
  const { id, complete, file } = await started()
  let release!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  complete.mockImplementationOnce(async request => {
    await waiting
    return { requestId: request.requestId, providerId: 'fake', model: 'echo', inputTokens: 30, outputTokens: 100,
      text: JSON.stringify({ steps: [{ intent: 'Inspect', capability: 'filesystem.inspect', input: { path: file }, dependsOn: [] }] }),
    }
  })
  const planning = prepare(id, true)
  await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1))
  const stopping = core!.handleCommand({ command: 'security.stopAll', requestId: 'stop-planning', payload: {} })
  release()
  expect(await planning).toMatchObject({ ok: false })
  await stopping
  expect(internal().missionEngine.record(id)?.activePlan).toBeNull()
  expect(runs(id)).toHaveLength(0)
})

it('does not start a second model call when planning is already in flight', async () => {
  const { id, complete, file } = await started()
  let release!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  complete.mockImplementationOnce(async request => {
    await waiting
    return { requestId: request.requestId, providerId: 'fake', model: 'echo', inputTokens: 30, outputTokens: 100,
      text: JSON.stringify({ steps: [{ intent: 'Inspect', capability: 'filesystem.inspect', input: { path: file }, dependsOn: [] }] }),
    }
  })
  const first = prepare(id)
  await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1))
  expect(await prepare(id)).toEqual({ ok: false, reason: 'mission_unavailable' })
  expect(await core!.advanceMission(id, 'manual')).toBeNull()
  release()
  expect(await first).toMatchObject({ ok: true })
  expect(complete).toHaveBeenCalledTimes(1)
})

it('rejects an actual symlink or junction escape from an authorized root', async () => {
  const allowed = join(dir, 'allowed')
  const outside = join(dir, 'outside')
  await mkdir(allowed)
  await mkdir(outside)
  await writeFile(join(outside, 'secret.txt'), 'private')
  await symlink(outside, join(allowed, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  const registry = new WorkRegistry()
  registerFileInspection(registry, [allowed])
  const request = { runId: 'r', stepId: 's', stepKey: 's', actionId: 'a', attempt: 1,
    input: { path: join(allowed, 'escape', 'secret.txt') }, correlationId: 'c' }
  await expect(registry.capability('filesystem.inspect')!.execute(request,
    { signal: new AbortController().signal, now: () => new Date() })).rejects.toThrow('authorized file metadata')
})

it('does not expand authority when an authorized root itself is redirected', async () => {
  const allowed = join(dir, 'original')
  const outside = join(dir, 'other')
  await mkdir(allowed)
  await mkdir(outside)
  await writeFile(join(allowed, 'file.txt'), 'allowed')
  await writeFile(join(outside, 'file.txt'), 'private')
  const registry = new WorkRegistry()
  registerFileInspection(registry, [allowed])
  const request = { runId: 'r', stepId: 's', stepKey: 's', actionId: 'a', attempt: 1,
    input: { path: join(allowed, 'file.txt') }, correlationId: 'c' }
  const context = { signal: new AbortController().signal, now: () => new Date() }
  const capability = registry.capability('filesystem.inspect')!
  await capability.execute(request, context)
  await rm(allowed, { recursive: true, force: true })
  await symlink(outside, allowed, process.platform === 'win32' ? 'junction' : 'dir')
  await expect(capability.execute(request, context)).rejects.toThrow('authorized file metadata')
})

it('independently checks actual metadata and rejects changed or fabricated observations', async () => {
  const file = join(dir, 'metadata.txt')
  await writeFile(file, 'first')
  const registry = new WorkRegistry()
  registerFileInspection(registry, [dir])
  const request = { runId: 'r', stepId: 's', stepKey: 's', actionId: 'a', attempt: 1, input: { path: file }, correlationId: 'c' }
  const executed = await registry.capability('filesystem.inspect')!.execute(request, { signal: new AbortController().signal, now: () => new Date() })
  expect(executed.observation.data.size).toBe(5)
  const verifier = registry.verifier('filesystem.inspect.verified')!
  expect(await verifier.verify({ ...request, observation: executed.observation })).toMatchObject({ verdict: 'passed' })
  expect(await verifier.verify({ ...request, observation: { ...executed.observation, data: { ...executed.observation.data, size: 123 } } })).toMatchObject({ verdict: 'failed' })
  await writeFile(file, 'different size')
  expect(await verifier.verify({ ...request, observation: executed.observation })).toMatchObject({ verdict: 'failed' })
  await rm(file)
  expect(await verifier.verify({ ...request, observation: executed.observation })).toMatchObject({ verdict: 'failed' })
})

it('preserves encrypted inputs and verified steps after restart without replaying execution', async () => {
  const { id, file, complete, config } = await started()
  expect(await prepare(id)).toMatchObject({ ok: true })
  await core!.advanceMission(id, 'manual')
  expect(runs(id)).toHaveLength(1)
  expect(internal().missionEngine.record(id)?.activePlan?.steps[0]?.status).toBe('verified')
  await core!.stop('restart')
  core = createCore(config)
  await core.start()
  expect(runs(id)).toHaveLength(1)
  expect(internal().missionEngine.record(id)?.activePlan?.steps[0]?.status).toBe('verified')
  const store = await EncryptedMissionStore.open({ path: `${config.dataPath}.missions`, key: config.missionKey! })
  const saved = await store.read(id)
  expect(saved).toMatchObject({ ok: true, value: { executionPlan: { steps: [{ input: { path: file } }, { input: { path: file } }] } } })
  await store.close()
  await core.advanceMission(id, 'manual')
  expect(runs(id)).toHaveLength(2)
  expect(runs(id).every(run => run.status === 'completed')).toBe(true)
  expect(complete).toHaveBeenCalledTimes(1)
})

it('STOP ALL at the first verified event prevents the following step', async () => {
  const { id } = await started()
  expect(await prepare(id, true)).toMatchObject({ ok: true })
  let stopping: Promise<unknown> | undefined
  const dispose = internal().fabric.subscribe(event => {
    if (event.type === 'mission.step.transitioned' && event.payload.missionId === id && event.payload.to === 'verified') {
      stopping = core!.handleCommand({ command: 'security.stopAll', requestId: 'stop', payload: { reason: 'Owner stopped the mission' } })
    }
  })
  await core!.advanceMission(id, 'manual')
  await stopping
  dispose()
  expect(stopping).toBeDefined()
  expect(runs(id)).toHaveLength(1)
  expect(view(id).status).not.toBe('completed')
  expect(await prepare(id, true)).toEqual({ ok: false, reason: 'mission_unavailable' })
})

it('does not continue unless the trusted owner explicitly opted in', async () => {
  const { id } = await started()
  expect(await prepare(id)).toMatchObject({ ok: true })
  await core!.advanceMission(id, 'manual')
  expect(runs(id)).toHaveLength(1)
  expect(internal().missionEngine.record(id)?.activePlan?.steps[1]?.status).toBe('pending')
})
