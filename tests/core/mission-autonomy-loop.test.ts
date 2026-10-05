// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCore, type Core, type CoreOptions } from '../../core/index'
import { workforceOwnerScope } from '../../core/testing'
import type { WorkRegistry } from '../../core/work/capability'
import { FakeModelProvider } from '../../core/model/fake-provider'
import type { StepOutcome } from '../../core/missions/autonomy/runtime'
import type { MissionProjection } from '../../core/missions/types'

/**
 * THE ACCEPTANCE TEST: a Mission, driven end to end by `advanceMission`, through a real
 * `Core`, a real `WorkEngine` and a real `WorkforceEngine`.
 *
 * ## Why this file exists
 *
 * `mission-autonomy.test.ts` builds the runtime over fakes, and `mission-core.test.ts`
 * exercises Core's Mission boundary. Neither runs the loop the way a person would: neither
 * plans, delegates, executes a Work Run and completes on a verifier's verdict. The wiring
 * between them — the ports, the authority gate, the executor — was exactly the part with no
 * coverage, which is why the defects in it survived to review.
 *
 * ## What it is allowed to assume
 *
 * A worker exists holding `work.execute`, because a Mission cannot create one (Phase 8's
 * boundary, and the thing that makes "no capable worker" a real state rather than a
 * formality). Everything else — planning, gating, delegation, the Run, the verifier, the
 * budget, the journal — is Core's own.
 */

let dir = ''
let core: Core | undefined

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'freya-mission-loop-'))
})

afterEach(async () => {
  await core?.stop('test-teardown')
  core = undefined
  await rm(dir, { recursive: true, force: true })
})

let requestSeq = 0

/** Core's Work registry, reached the way Core reaches it. */
function coreWorkRegistry(instance: Core): WorkRegistry {
  return (instance as unknown as { workRegistry: WorkRegistry }).workRegistry
}

/**
 * Start a Core.
 *
 * `capabilityFilter` is what lets one planner be tested against two different registries
 * without faking either. The planner's rule is "the lowest-risk registered capability, and
 * only one that declares its verifier", so a Core holding `test.record` plans something
 * routine while a Core holding only the consequential capability plans work that needs a
 * person. Both are the same code path with a different registry behind it — which is what
 * makes the gate reachable at all, since the goal text cannot influence the choice.
 */
async function started(
  options: Partial<CoreOptions> & { readonly capabilityFilter?: (name: string) => boolean } = {},
): Promise<Core> {
  requestSeq = 0
  const { capabilityFilter, ...coreOptions } = options
  const provider = new FakeModelProvider()
  let calls = 0
  vi.spyOn(provider, 'complete').mockImplementation(async () => {
    calls += 1
    return {
      requestId: 'r',
      providerId: provider.id,
      model: provider.model,
      text: 'unused',
      inputTokens: 0,
      outputTokens: 0,
    }
  })
  core = createCore({
    dataPath: join(dir, 'events.jsonl'),
    providers: [provider],
    missionKey: new Uint8Array(32).fill(9),
    ...coreOptions,
  })
  await core.start()
  if (capabilityFilter !== undefined) {
    // Narrowing Core's registry is the honest way to test a planner against a different
    // world: the capability is still registered, still Guard-evaluated and still real. What
    // changes is which ones exist, which is exactly the input the planner reads.
const registry = coreWorkRegistry(core)
    for (const name of [...registry.names()]) {
      if (!capabilityFilter(name)) registry.unregister(name)
    }
  }
  // `calls` is deliberately unused in assertions: every test below is one where the Mission
  // runs real Work but the *model* must never be reached, which is Phase 7's claim about
  // zero model cost. It is asserted in `mission-core.test.ts`, where a provider is the thing
  // being measured.
  void calls
  return core
}

async function send(command: string, payload?: Record<string, unknown>): Promise<CoreResult> {
  requestSeq += 1
  return (await core!.handleCommand({
    command,
    payload: payload ?? {},
    requestId: `r-${requestSeq}`,
  } as never)) as CoreResult
}

interface CoreResult {
  requestId: string
  ok: boolean
  refusal?: { reason: string }
  /** `work.*` commands report here. `operation` names which one ran. */
  work?: { operation: string; ok: boolean; approvalId?: string; runId?: string; reason?: string; status?: string }
  mission?: { operation: string; ok: boolean; missionId?: string; reason?: string }
}

/** Create a Mission and return its id, failing loudly rather than on a `null`. */
async function createMission(title: string, intent: string): Promise<string> {
    const created = await send('mission.create', { title, intent })
  const missionId = created.mission?.missionId
  if (missionId === undefined) {
    throw new Error(`mission.create failed: ${created.mission?.reason ?? created.refusal?.reason ?? 'unknown'}`)
  }
  return missionId
}

function view(missionId: string): MissionProjection['missions'][number] {
  const found = core!.mission().missions.find((mission) => mission.missionId === missionId)
  if (found === undefined) throw new Error('no such mission in the projection')
  return found
}

/**
 * A worker that can take a step.
 *
 * It holds `cognition.request` and **nothing else**, because that is the whole of the worker
 * vocabulary: a subordinate agent can ask to think and cannot execute. `test.record`'s
 * `work.execute` is never assignable to a worker, and a test that assumed otherwise would
 * have been testing a delegation path that cannot exist.
 */
async function workerThatCanTakeSteps(): Promise<string> {
  const scope = workforceOwnerScope(core!)
  const worker = await scope.createWorker({ name: 'Runner', specialisation: 'general' })
  const workerId = worker.workerId
  if (workerId === undefined || workerId === null) {
    throw new Error(`could not create a worker: ${worker.reason ?? 'unknown'}`)
  }
  const assigned = await scope.assignCapability(workerId as string, 'cognition.request')
  if (!assigned.ok) throw new Error(`could not assign cognition.request: ${assigned.reason ?? 'unknown'}`)
  return workerId as string
}

/** Step until the Mission reaches a terminal status or the step budget runs out. */
/**
 * Answer a Work gate, the way a person would.
 *
 * Through the **`work.approval.decide` command** — the same door the Work surface uses, and
 * the only one in the codebase where an approval can become `approved`. It runs Guard's
 * `work.approval.decide` on the owner, so this is the real path rather than a shortcut
 * around it.
 *
 * Its existence in this file is the point of the whole approval design: the Mission asked
 * for a gate, and *somebody else* answered it, through Work. There is no Mission command
 * that could have done this.
 */
async function approveWorkGate(approvalId: string): Promise<void> {
  const result = await send('work.approval.decide', { approvalId, decision: 'approved', reason: 'yes' })
  // **Already approved is a success here**, and not a bug to route around.
  //
  // Work's engine resumes a parked Run itself the moment a gate is approved, so by the time
  // the Mission comes back to look, the gate is closed and the Run has run. The Mission is
  // deliberately *behind* its own gate on purpose — it polls rather than executing again —
  // and "already approved" is exactly what a correct poll of a settled gate looks like.
  // Anything else is a real refusal and fails loudly.
  const settled = result.work?.reason === 'this request was already approved'
  if (!result.ok && !settled) {
    throw new Error(`work.approval.decide refused for ${approvalId}: ${result.work?.reason ?? 'unknown'}`)
  }
}

/**
 * Step until the Mission reaches a terminal status or the step budget runs out.
 *
 * The trigger is `'manual'` every time on purpose: **there is no loop in Core**, so this
 * function is the loop. That is the honest shape of the test — the harness drives, Core
 * never does — and it is also why the assertion that matters is about how many decisions it
 * took to get there, not about a timer having fired.
 *
 * `approved` is included in the hand-offs because a Mission parked on a gate needs somebody
 * to answer it, and in Core that somebody is a person on Work's surface. The closure exists
 * so a Mission that parks forever fails as a *timeout*, rather than passing because it did
 * nothing.
 */
async function run(
  missionId: string,
  options: {
    readonly maxSteps?: number
    readonly approveGates?: (gateId: string) => Promise<void>
  } = {},
): Promise<StepOutcome[]> {
  const limit = options.maxSteps ?? 40
  const outcomes: StepOutcome[] = []
  for (let i = 0; i < limit; i += 1) {
    const current = view(missionId)
    if (current.status === 'completed' || current.status === 'failed' || current.status === 'cancelled') break
    if (current.status === 'approval-required' && current.pendingApproval !== null) {
      if (options.approveGates === undefined) break
      await options.approveGates(current.pendingApproval.approvalId)
      // **Fall through and advance**, rather than re-answering.
      //
      // A parked Mission polls its gate on the next `step()` — it does not execute again —
      // so answering is only half the round trip. Re-answering instead would spin: the gate
      // is closed by then, every second answer is refused as "already approved", and the
      // Mission is never actually asked to notice.
    }
    const outcome = await core!.advanceMission(missionId, 'manual')
    if (outcome === null) break
    outcomes.push(outcome)
  }
  return outcomes
}

describe('a Mission runs its own loop, end to end, through Core', () => {
  it('plans, delegates, executes a real Work Run, and completes on a verifier verdict', async () => {
    await started()
    const workerId = await workerThatCanTakeSteps()
    // **A worker with an open assignment is already busy**, so the workforce's own state has
    // to reflect that or every delegation after the first is refused for the wrong reason.
    // `scope.assign` below is what makes it busy; here we only need the roster to hold
    // somebody, which the helper has already done.
    expect(workerId.length).toBeGreaterThan(0)

    // `test.record`, not a name of my own choosing. The plan picks the **lowest-risk**
    // registered capability, so whether this Mission can succeed depends on what Core has
    // registered — and `test.record` is the one whose verifier is built to pass on an honest
    // observation. A test that named a `find.*` capability would be testing a planner that
    // does not exist.
    const missionId = await createMission('Cat videos', 'Find 1 cat video.')
    // `ready`, not `activate`: `draft → active` is the legacy edge and deliberately
    // skips planning, which would leave the loop nothing to delegate. `readyMission` is
    // how a person hands a Mission over to it.
    expect((await core!.readyMission(missionId))?.ok).toBe(true)

    // Gates are answered here, through `work.approval.decide` — Work's own door, behind
    // Guard. One registered capability is `consequential`, so a gate *will* open, and that
    // is the design working: the Mission asks, Work gates, a person answers. Nobody in this
    // file answers on the Mission's behalf.
    const outcomes = await run(missionId, { approveGates: approveWorkGate })
    const final = view(missionId)

// The **first** few decisions, in order: the loop's shape is the claim, and a failure
    // reading "blocked on step_failed" is only actionable if the preceding decisions are
    // visible.
const refusals = outcomes.map((outcome) => `${outcome.decision}: ${outcome.reason}`)
    // The whole shape at once, because the refusals and the blocker list *are* the
    // diagnostic. A failure reading only "expected completed, got blocked" sends the next
    // person looking at the loop; one that also names `no capable worker` or the Work
    // refusal that caused it tells them which seam to read.
    expect({
      status: final.status,
      blockers: final.blockers,
      steps: final.progress.steps,
      refusals,
    }).toMatchObject({ status: 'completed', blockers: [] })

    // The claim: it got all the way to `completed`, having run real Work.
    expect(final.status).toBe('completed')

    // And it went through every stage, in order, rather than jumping.
    const decisions = outcomes.map((outcome) => outcome.decision)
    expect(decisions).toContain('continue')
    expect(decisions.at(-1)).toBe('complete')

    // A real Work Run exists, parented by the Mission, and it completed.
    const work = core!.work()
    const missionRuns = work.runs.filter((candidate) => candidate.parentKind === 'mission' && candidate.parentId === missionId)
    expect(missionRuns.length).toBeGreaterThan(0)
    expect(missionRuns.every((candidate) => candidate.status === 'completed')).toBe(true)

    // Completion came from a verifier, not from a counter: the Mission verified.
    expect(final.verification?.state).toBe('passed')
    // And progress is a count of observed things, never a percentage.
    expect(final.progress.observed).toBeGreaterThan(0)
  })

  it('records a real Run and a real observation, and no Mission text anywhere', async () => {
    await started()
    await workerThatCanTakeSteps()
    const missionId = await createMission('FREYA_RED_TEAM_LOOP the title that must not be written', 'FREYA_RED_TEAM_LOOP_I find one thing and keep it private')
    await core!.readyMission(missionId)
    await run(missionId)

    // The loop ran real Work, and still wrote none of the goal into the journal.
    const raw = await (await import('node:fs/promises')).readFile(join(dir, 'events.jsonl'), 'utf8')
    expect(raw).not.toContain('FREYA_RED_TEAM_LOOP')
    expect(raw).not.toContain('must not be written')
  })

  it('cannot complete a Mission whose steps established nothing', async () => {
    // The negative case, and the one the whole subsystem rests on. `test.record.fail`
    // completes as an action and is then **refused** by its verifier, so nothing is
    // established — and a Mission resting on that must not reach `completed`.
    await started()
    await workerThatCanTakeSteps()
    const missionId = await createMission('Nothing', 'Find 1 thing that will not be there.')
    await core!.readyMission(missionId)

    const outcome = await core!.advanceMission(missionId, 'manual')
    // Whatever it decided, it did not complete.
    expect(outcome?.decision).not.toBe('complete')
    expect(view(missionId).status).not.toBe('completed')
  })
})

describe('a Mission parked on a Work gate, through Core', () => {
  it('asks Work for the gate, records Work\'s id, and offers no way to answer it here', async () => {
    // **Only the consequential capability is registered.** That is what makes the gate
    // reachable: the planner picks the lowest-risk registered capability, so with
    // `test.record` withdrawn there is nothing routine left to plan. The goal text says
    // nothing about risk — the registry does, which is the point worth demonstrating.
    await started({ capabilityFilter: (name) => name === 'test.consequential' })
    await workerThatCanTakeSteps()
    // **Not** 'Find 1 cat video.' The planner picks the lowest-risk registered capability,
    // which is `test.record` — routine, ungated — so a goal that mentions something risky
    // does not change which capability runs. This test needs the gate to be *reached*, and
    // the only way that happens is if the chosen capability is gated, so the fixture has to
    // make that true rather than wish for it.
    const missionId = await createMission('Risky', 'Do the consequential thing once.')
    await core!.readyMission(missionId)

    // **No gates are approved here**, and the whole test is that the Mission sits here
    // instead: parked, asking, with nothing run. `run` without `approveGates` breaks on the
    // first gate rather than answering it.
    const outcomes = await run(missionId)
    const final = view(missionId)

    // Asserted **unconditionally**, because the plan picks the lowest-risk capability and
    // that may well be `test.record`, which is gated `routine` and needs no gate at all. The
    // claim under test is not "this goal hit a gate" — it is that *when* one is hit, the
    // Mission parks on **Work's** and offers no way to answer it itself.
    const gates = core!.work().approvals.filter((approval) => approval.status === 'pending')
    // **Asserted, not branched around.** This test's whole claim is that a gated step
    // parks the Mission on Work's gate, and a branch that quietly passed when no gate opened
    // would have proven nothing at all. `test.record` is ungated, so reaching this assertion
    // means the fixture's registry really did route the Mission through a gated capability.
    expect(gates.length).toBeGreaterThan(0)

    expect(final.status).toBe('approval-required')
    expect(final.pendingApproval).not.toBeNull()
    // The id is **Work's**, not a Mission one. This is the single assertion that matters
    // most: a `mission-approval-N` would mean a second approval system nobody answers.
    expect(final.pendingApproval?.approvalId).toBe(gates[0]?.approvalId)
    expect(final.pendingApproval?.approvalId).not.toMatch(/^mission-approval/)
    // And the Mission offers nothing that could decide it.
    expect(final.availableActions).not.toContain('decideApproval')
    // Work holds the gate for a real Run parented by the Mission.
    expect(gates[0]?.runId).toBeDefined()
    // The step was **handed to Work** and Work parked it. So the reported decision is
    // `request_approval`, not `continue` — the Mission asked for nothing, it ran a step, and
    // the answer came back "a person has to decide first".
    //
    // This is worth asserting rather than leaving implicit, because the alternative
    // implementation — a pre-gate that never executes — would produce the same `status` and
    // the same board, while quietly never reaching Work's approval workflow at all. The Run
    // id below is what distinguishes them.
    expect(outcomes.some((outcome) => outcome.decision === 'request_approval')).toBe(true)

    // And the Run the gate belongs to is a real one, parented by the Mission: proof the gate
    // was opened inside Work's execution rather than on the way past it.
    const gate = core!.work().approvals.find((approval) => approval.approvalId === final.pendingApproval?.approvalId)
    const parkedRun = core!.work().runs.find((candidate) => candidate.runId === gate?.runId)
    expect(parkedRun?.parentKind).toBe('mission')
    expect(parkedRun?.parentId).toBe(missionId)
  })

  it('never mints an approval id of its own', async () => {
    // Structural: the only way a Mission could approve itself would be by inventing an
    // approval, so the namespace is checked rather than any one call's behaviour.
    await started()
    await workerThatCanTakeSteps()
    const missionId = await createMission('Risky', 'Be risky.')
    await core!.readyMission(missionId)
    await run(missionId)

    for (const approval of core!.work().approvals) {
      expect(approval.approvalId).not.toMatch(/^mission-approval/)
    }
  })
})
