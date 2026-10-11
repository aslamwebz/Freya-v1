import type { Capability } from '../../shared/contracts/capabilities'
import type { PrincipalId } from '../../shared/contracts/identity'
import {
  isForbiddenSkillCapability,
  isSelectableSkillStatus,
  isSkillCapability,
  SKILL_LIMITS,
  type SkillRecord,
  type SkillRefusalCode,
} from './types'
import type { SkillFoldRecord } from './state'

/**
 * SKILL EXECUTION — only ever inside an authorised Mission / Work / Run / Step.
 *
 * ## The rule this file exists to make structural
 *
 * > A stored skill never grants capability, and it never executes outside work.
 *
 * Both halves are enforced by *shape*, not by discipline:
 *
 * - `SkillExecutionRequest` **requires** `missionId`, `runId` and `stepId`. There is
 *   no overload without them and no "just render the template" entry point, so
 *   `planSkillExecution` cannot be called in a world with no Run.
 * - `SkillExecutionPort` is a **read** port. It exposes four lookups and no write, no
 *   capability grant, no approval, and no execution. A skill cannot reach the Run it
 *   is planning into; it can only ask whether the Run, the Step and the capabilities
 *   are already there.
 * - The capabilities a skill declares are checked against **the capabilities the Run
 *   already holds**, not against what the skill wants. A skill that declares
 *   `work.approval.decide` is refused outright at admission *and* again here.
 *
 * ## The refusals, and what each is for
 *
 * | code                     | means |
 * | ------------------------ | ----- |
 * | `not-in-work`            | one of the three required references is missing |
 * | `stop-all`               | Freya is stopped; nothing is planned |
 * | `work-run-unusable`      | the Run does not exist, or is terminal |
 * | `work-step-missing`      | the Step does not exist in that Run |
 * | `capability-not-granted` | the Run does not hold a capability the skill declares |
 * | `capability-laundering`  | the skill declares a capability no skill may ever require |
 * | `not-executable`         | the skill's status or trust class does not permit execution |
 * | `no-such-skill`          | there is no such skill, or no such version of it |
 *
 * ## What a successful plan is
 *
 * A `SkillRunPlan`: the ordered steps the skill declares, each mapped onto the
 * existing Work vocabulary of `{ capability, verifier }`. It is a *plan*, not an
 * execution. Handing it to Work goes through Work's own `work.run.create`, which
 * validates every capability and verifier against the registry, evaluates Guard, and
 * requires an approval for anything `consequential`. Nothing here bypasses that, and
 * nothing here is a substitute for it.
 */

/** What a caller must supply. All three, or the call is refused. */
export interface SkillExecutionRequest {
  readonly missionId: string
  readonly runId: string
  readonly stepId: string
  /** The principal the Run executes under. Core supplies this; it is not a payload field. */
  readonly principal: PrincipalId
  /** Bounded, sanitised arguments for the skill's declared inputs. */
  readonly arguments?: Readonly<Record<string, string>>
}

/**
 * The narrow read port Skills have on Work.
 *
 * Four lookups, no writes. An implementation that needs to *do* something cannot
 * express it here, which is the point: the only way a skill can cause work is by
 * producing a plan that somebody else submits through Work's own command surface.
 */
export interface SkillExecutionPort {
  missionExists(missionId: string): boolean
  runExists(runId: string): boolean
  /** `'running' | 'terminal' | 'missing'` — deliberately not the full Run status. */
  runState(runId: string): 'running' | 'terminal' | 'missing'
  stepExists(runId: string, stepId: string): boolean
  /**
   * The Guard capabilities this Run already holds.
   *
   * A Run's capability set is what it was planned with and what Guard evaluated. It
   * is read, never requested: there is no `requestCapability`, no `grant`, and no
   * `approve` on this interface.
   */
  runCapabilities(runId: string): readonly Capability[]
}

/** One step of a plan, in Work's own vocabulary. */
export interface PlannedSkillStep {
  readonly key: string
  readonly capability: string
  readonly verifier: string
}

/** What a successful planning produced. A plan, never an execution. */
export interface SkillRunPlan {
  readonly skillId: string
  readonly version: number
  readonly runId: string
  readonly stepId: string
  readonly steps: readonly PlannedSkillStep[]
  readonly requiredCapabilities: readonly Capability[]
}

export type SkillExecutionOutcome =
  | { readonly ok: true; readonly plan: SkillRunPlan }
  | { readonly ok: false; readonly code: SkillRefusalCode; readonly reason: string }

export interface PlanSkillExecutionInput {
  readonly record: SkillFoldRecord | null
  /** The private body, read from the encrypted store. Null when there is none. */
  readonly body: SkillRecord | null
  readonly request: SkillExecutionRequest
  readonly work: SkillExecutionPort
  /** Read fresh, per call. A stopped Freya plans nothing. */
  readonly stopAll: () => boolean
}

/**
 * Plan a skill into an existing Run and Step, or refuse in words.
 *
 * Deterministic and total: the same inputs always produce the same plan or the same
 * refusal. It reads no clock, reaches no model, writes nothing and holds no authority.
 */
export function planSkillExecution(input: PlanSkillExecutionInput): SkillExecutionOutcome {
  const { record, body, request, work } = input

  const refuse = (code: SkillRefusalCode, reason: string): SkillExecutionOutcome => ({
    ok: false,
    code,
    reason,
  })

  if (
    typeof request.missionId !== 'string' ||
    request.missionId.trim().length === 0 ||
    typeof request.runId !== 'string' ||
    request.runId.trim().length === 0 ||
    typeof request.stepId !== 'string' ||
    request.stepId.trim().length === 0
  ) {
    return refuse(
      'not-in-work',
      'a skill executes only inside a Mission, Run and Step, and all three references are required',
    )
  }

  if (input.stopAll()) {
    return refuse('stop-all', 'Freya is stopped, so no skill is planned into anything')
  }

  if (record === null || body === null) {
    return refuse('no-such-skill', 'there is no such skill, or its body is not readable')
  }

  if (body.skillId !== record.skillId || body.version !== record.version) {
    return refuse(
      'no-such-version',
      `the stored body is version ${body.version} and the record is at version ${record.version}; nothing is planned from a mismatched pair`,
    )
  }

  if (record.status === 'blocked' || record.status === 'retired') {
    return refuse('not-executable', `this skill is ${record.status} and cannot be planned into work`)
  }

  if (!isSelectableSkillStatus(record.status)) {
    return refuse(
      'not-executable',
      `a skill at status ${record.status} may be recorded but not executed; it must reach trial first`,
    )
  }

  if (record.trustClass === 'untrusted-content') {
    return refuse(
      'untrusted-content',
      'this procedure came from untrusted content and may never be executed, however many times it is revised',
    )
  }

  // Capability laundering, checked before anything exists to launder. A skill that
  // declares a forbidden capability is refused even if the Run somehow holds it.
  for (const capability of body.requiredCapabilities) {
    if (isForbiddenSkillCapability(capability)) {
      return refuse(
        'capability-laundering',
        `this skill declares ${capability}, which no reusable procedure may require; Guard, the Governor, approvals and STOP ALL are not procedure inputs`,
      )
    }
  }

  if (body.steps.length === 0) {
    return refuse('not-executable', 'this skill declares no steps, so there is nothing to plan')
  }
  if (body.steps.length > SKILL_LIMITS.maxSteps) {
    return refuse('not-executable', `a skill may declare at most ${SKILL_LIMITS.maxSteps} steps`)
  }

  if (!work.missionExists(request.missionId)) {
    return refuse('work-run-unusable', 'the Mission this execution names does not exist')
  }

  const runState = work.runState(request.runId)
  if (runState === 'missing') return refuse('work-run-unusable', 'the Run this execution names does not exist')
  if (runState === 'terminal') {
    return refuse(
      'work-run-unusable',
      'the Run is terminal, and a finished or failed Run is never extended by a skill',
    )
  }
  if (!work.stepExists(request.runId, request.stepId)) {
    return refuse('work-step-missing', 'the Step this execution names is not part of that Run')
  }

  // The load-bearing check: the *Run's* capabilities, not the skill's wishes.
  const held = new Set<string>(work.runCapabilities(request.runId))
  for (const capability of body.requiredCapabilities) {
    if (!held.has(capability)) {
      return refuse(
        'capability-not-granted',
        `the Run does not hold ${capability}; a stored skill cannot obtain a capability, only use one its Run already has`,
      )
    }
  }

  for (const step of body.steps) {
    // A step normally names a *registered Work capability* (`test.record`), not a
    // Guard vocabulary entry — and this file holds no registry, so it cannot map one to
    // the other, nor should it: mapping is Work's business and Work re-validates every
    // step against the registry when the Run is created.
    //
    // What *is* checkable here is a step that names a Guard capability directly, because
    // that is a claim about authority rather than about an implementation. It is a
    // second line of defence against an admission bug that let one through, and it is
    // skipped rather than approximated when the name is not in the vocabulary.
    if (!isSkillCapability(step.capability)) continue
    if (!held.has(step.capability)) {
      return refuse(
        'capability-not-granted',
        `step ${step.key} names ${step.capability}, which the Run does not hold`,
      )
    }
  }

  return {
    ok: true,
    plan: {
      skillId: record.skillId,
      version: record.version,
      runId: request.runId,
      stepId: request.stepId,
      steps: body.steps.map((step) => ({
        key: step.key,
        capability: step.capability,
        verifier: step.verifier,
      })),
      requiredCapabilities: [...body.requiredCapabilities],
    },
  }
}

/**
 * A port that says no to everything.
 *
 * Shipped as the default so a Core with no Work subsystem wiring plans nothing
 * rather than planning something on the strength of a missing check. "There is no
 * Work to plan into" is the honest answer, and it is the same answer a Core that
 * has not started gives.
 */
export class ClosedSkillExecutionPort implements SkillExecutionPort {
  missionExists(): boolean {
    return false
  }
  runExists(): boolean {
    return false
  }
  runState(): 'running' | 'terminal' | 'missing' {
    return 'missing'
  }
  stepExists(): boolean {
    return false
  }
  runCapabilities(): readonly Capability[] {
    return []
  }
}