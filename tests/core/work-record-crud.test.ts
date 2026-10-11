// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EventFabric } from '../../core/events/fabric'
import { JsonlEventStore } from '../../core/events/jsonl-store'
import { MissionEngine } from '../../core/missions/engine'
import { MemoryMissionStore } from '../../core/missions/memory-store'
import { GoalEngine } from '../../core/longhorizon/engine'
import { MemoryGoalStore } from '../../core/longhorizon/memory-store'
import { initialMissionState, reduceMissionState } from '../../core/missions/state'
import { initialGoalState, reduceGoalState } from '../../core/longhorizon/state'
import { GOAL_REASONS } from '../../core/longhorizon/types'

let directory = ''
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'freya-work-crud-')) })
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

async function setup() {
  const path = join(directory, 'events.jsonl')
  const fabric = await EventFabric.open({ store: await JsonlEventStore.open(path) })
  const missions = new MemoryMissionStore()
  const goals = new MemoryGoalStore()
  const mission = new MissionEngine({ fabric, store: missions, principalId: 'owner', work: {
    run: () => undefined, stepsOf: () => [], isSettled: () => true,
    pauseRun: async () => true, cancelRun: async () => true,
  } })
  const goal = new GoalEngine({ fabric, store: goals, principalId: 'owner', continuation: {
    verifyCheckpoint: async () => ({ established: true, reason: GOAL_REASONS.verification_passed }),
  } })
  await mission.open()
  await goal.open()
  return { mission, goal, missions, goals, fabric, path }
}

describe('owner record CRUD', () => {
  it('edits private draft content, preserves metadata privacy, and refuses active edits/deletes', async () => {
    const { mission, goal, path, fabric } = await setup()
    const m = (await mission.create({ title: 'Old mission', intent: 'Old intent' })).missionId!
    const g = (await goal.createGoal({ title: 'Old goal', description: 'Old description' })).goalId!
    expect(await mission.update(m, { title: 'Secret mission', intent: 'Secret intent' })).toMatchObject({ ok: true, operation: 'updated' })
    expect(await goal.updateGoal(g, { title: 'Secret goal', description: 'Secret description' })).toMatchObject({ ok: true, operation: 'updated' })
    expect((await mission.detail(m))?.content?.title).toBe('Secret mission')
    expect((await goal.detail(g))?.content?.title).toBe('Secret goal')
    await mission.activate(m)
    await goal.activateGoal(g)
    expect((await mission.update(m, { title: 'New', intent: 'New' })).ok).toBe(false)
    expect((await goal.updateGoal(g, { title: 'New', description: 'New' })).ok).toBe(false)
    expect((await mission.delete(m)).ok).toBe(false)
    expect((await goal.deleteGoal(g)).ok).toBe(false)
    expect(await readFile(path, 'utf8')).not.toContain('Secret')
    await fabric.close()
  })

  it('deletes drafts and terminal records, removes private text, and stays deleted on journal replay', async () => {
    const { mission, goal, missions, goals, fabric } = await setup()
    const m = (await mission.create({ title: 'Mission', intent: 'Intent' })).missionId!
    const g = (await goal.createGoal({ title: 'Goal', description: 'Description' })).goalId!
    await goal.cancelGoal(g)
    expect(await mission.delete(m)).toMatchObject({ ok: true, operation: 'deleted' })
    expect(await goal.deleteGoal(g)).toMatchObject({ ok: true, operation: 'deleted' })
    expect(await mission.detail(m)).toBeNull()
    expect(await goal.detail(g)).toBeNull()
    expect((await missions.read(m)).ok).toBe(false)
    expect((await goals.read(g)).ok).toBe(false)
    expect((await fabric.replay(initialMissionState(), reduceMissionState)).missions.has(m)).toBe(false)
    expect((await fabric.replay(initialGoalState(), reduceGoalState)).goals.has(g)).toBe(false)
    await fabric.close()
  })

  it('restores private content and refuses success when an update or delete cannot be journalled', async () => {
    const { mission, goal, fabric } = await setup()
    const m = (await mission.create({ title: 'Mission', intent: 'Intent' })).missionId!
    const g = (await goal.createGoal({ title: 'Goal', description: 'Description' })).goalId!
    const append = vi.spyOn(fabric, 'append').mockRejectedValue(new Error('Journal unavailable'))
    expect((await mission.update(m, { title: 'Changed', intent: 'Changed' })).ok).toBe(false)
    expect((await goal.updateGoal(g, { title: 'Changed', description: 'Changed' })).ok).toBe(false)
    expect((await mission.delete(m)).ok).toBe(false)
    expect((await goal.deleteGoal(g)).ok).toBe(false)
    expect((await mission.detail(m))?.content?.title).toBe('Mission')
    expect((await goal.detail(g))?.content?.title).toBe('Goal')
    append.mockRestore()
    await fabric.close()
  })

  it('refuses Goal creation and removes the private orphan when the journal cannot record creation', async () => {
    const { goal, goals, fabric } = await setup()
    const write = vi.spyOn(goals, 'write')
    const append = vi.spyOn(fabric, 'append').mockRejectedValue(new Error('Journal unavailable'))
    expect((await goal.createGoal({ title: 'Goal', description: 'Description' })).ok).toBe(false)
    const goalId = write.mock.calls[0]![0].goalId
    expect((await goals.read(goalId)).ok).toBe(false)
    expect(goal.projection().goalsTotal).toBe(0)
    append.mockRestore()
    await fabric.close()
  })
})
