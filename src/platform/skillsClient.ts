import {
  ABSENT_SKILL_PROJECTION,
  type SkillCommandOutcome,
  type SkillDetailView,
  type SkillProjection,
  type SkillSelectionReport,
} from '../../core/protocol/skills'
import { hostBridge } from './host'

/**
 * The renderer's view of skills: procedures, their evidence, and their lifecycle.
 *
 * A mirror, in the same sense as `attentionMirror` and `contextMirror`: every field
 * arrived from Core over a channel the window cannot write into, and the renderer
 * cannot write one either. There is no renderer-side skill state — no local status, no
 * local verdict, no local threshold — because a local copy would be a second source of
 * truth about which procedures are trustworthy, and the one a person would trust more
 * than Core's.
 *
 * ## What a window may do
 *
 * Nine commands, and each is a `coreSubmit` with a narrow payload contract:
 *
 * - **admit / revise** a procedure it wrote,
 * - **record an evaluation** of what it observed,
 * - ask Core to **move a status** or **retire** one,
 * - **propose** an improvement, and **settle** a proposal,
 * - **read** the projection, ask for a **deterministic selection**, and **read back**
 *   one procedure's own text.
 *
 * What it may not do, because there is no method here and no bridge function that
 * could: name a trust class, assert a verification state, submit a verification
 * record, set or read back a threshold, skip the evidence window, offer an artifact
 * into Freya's running code, or plan a skill into work.
 *
 * ## Why selection is exposed at all
 *
 * Asking "which procedures apply here?" is a legitimate question a person asks, and
 * the answer is worth showing *as Core ranked it* — with the tags it matched, the
 * evidence it holds and the status it is in. So the surface renders Core's ordering
 * rather than sorting locally: a window that re-sorted the list would be inventing a
 * preference the domain does not have.
 */

/** What a caller supplies when admitting or revising a procedure. */
export interface SkillDraftInput {
  name: string
  kind: string
  summary: string
  contract: {
    inputs: readonly { name: string; description: string }[]
    outputs: readonly { name: string; description: string }[]
    preconditions: readonly { name: string; description: string }[]
    postconditions: readonly { name: string; description: string }[]
  }
  applicability: readonly string[]
  requiredCapabilities: readonly string[]
  steps: readonly { key: string; capability: string; verifier: string }[]
}

/** What a caller supplies when reporting what it observed about a procedure. */
export interface SkillEvidenceInput {
  skillId: string
  subjectKind: string
  subjectRef: string
  evidence: readonly { kind: string; code: string; count: number }[]
  metrics?: readonly { name: string; value: number }[]
  /** A character count of model commentary. Never text — there is no field for it. */
  commentaryLength?: number
}

export interface SkillsMirror {
  readonly projection: SkillProjection | null
  subscribe(listener: (projection: SkillProjection | null) => void): () => void
  attach(): Promise<() => void>

  /** Pull Core's current projection. Argument-free by construction. */
  read(): Promise<SkillProjection | null>

  admit(input: SkillDraftInput): Promise<SkillCommandOutcome>
  revise(skillId: string, input: SkillDraftInput): Promise<SkillCommandOutcome>
  recordEvaluation(input: SkillEvidenceInput): Promise<SkillCommandOutcome>
  transition(skillId: string, to: string): Promise<SkillCommandOutcome>
  retire(skillId: string, reason: string): Promise<SkillCommandOutcome>
  propose(input: { target: string; targetRef: string; summary?: string }): Promise<SkillCommandOutcome>
  settleProposal(
    proposalId: string,
    decision: 'accepted' | 'refused',
    reason?: string,
  ): Promise<SkillCommandOutcome>

  /** Ask Core to rank procedures. Core decides the order; the renderer does not sort. */
  select(input: {
    applicability?: readonly string[]
    includeTrial?: boolean
    includeVerified?: boolean
    limit?: number
  }): Promise<SkillSelectionReport | null>

  /** Read one procedure's own text back, explicitly. Never a standing feed. */
  readDetail(skillId: string): Promise<SkillDetailView | null>

  /** Forget the shared mirror. For tests. */
  reset(): void
}

/** Shown before Core has ever reported, matching the other mirrors' absent state. */
const ABSENT: SkillProjection = ABSENT_SKILL_PROJECTION

let shared: SkillsMirror | null = null
let attachPromise: Promise<SkillsMirror> | null = null

export function skillsMirror(): SkillsMirror {
  shared ??= createSkillsMirror()
  return shared
}

export function ensureSkillsAttached(): Promise<SkillsMirror> {
  attachPromise ??= skillsMirror().attach().then(() => skillsMirror())
  return attachPromise
}

export function resetSkillsMirror(): void {
  shared = null
  attachPromise = null
}

export function createSkillsMirror(): SkillsMirror {
  const listeners = new Set<(projection: SkillProjection | null) => void>()
  const subscriptions = new Set<() => void>()
  let current: SkillProjection | null = null

  const publish = (projection: SkillProjection | null): void => {
    current = projection
    for (const listener of [...listeners]) listener(projection)
  }

  /**
   * Pull the projection. The call is made with **no arguments**, so this is a pull of
   * what Core reports, never a push of what the window believes. The mirror is only
   * overwritten from an empty state, so a pull that resolves after a newer push cannot
   * write older Core truth over newer.
   */
  const read = async (): Promise<SkillProjection | null> => {
    const bridge = hostBridge()
    if (!bridge || typeof bridge.coreSkills !== 'function') return null
    try {
      const projection = await bridge.coreSkills()
      if (current === null) publish(projection ?? ABSENT)
      return projection
    } catch {
      return null
    }
  }

  /** Submit and, on success, let Core's push be the only thing that updates state. */
  const submit = async (command: string, payload: unknown): Promise<SkillCommandOutcome> => {
    const bridge = hostBridge()
    if (!bridge || typeof bridge.coreSubmit !== 'function') {
      return {
        operation: 'refused',
        ok: false,
        reason: 'the Core bridge is not available in this window',
      }
    }
    try {
      const result = await bridge.coreSubmit(command as never, payload)
      if (result.skill) return result.skill
      return {
        operation: 'refused',
        ok: false,
        reason:
          result.refusal?.reason ?? result.error?.message ?? 'Core did not answer the skill command',
      }
    } catch (error) {
      return {
        operation: 'refused',
        ok: false,
        reason: `Freya Core could not be reached — ${error instanceof Error ? error.message : 'unknown error'}`,
      }
    }
  }

  return {
    get projection() {
      return current
    },

    subscribe(listener) {
      listeners.add(listener)
      listener(current)
      return () => {
        listeners.delete(listener)
      }
    },

    /**
     * Follow pushes, then pull once as a backstop. Subscribing *first* is deliberate:
     * a change landing between the pull resolving and the subscription registering
     * would otherwise be lost.
     */
    async attach() {
      const bridge = hostBridge()
      // A bridge that predates this lane is tolerated rather than crashing a window:
      // the mirror simply stays absent, which is the honest reading of "no Skills
      // channel here".
      if (!bridge || typeof bridge.onCoreSkills !== 'function') return () => {}
      const own = bridge.onCoreSkills((projection) => publish(projection))
      subscriptions.add(own)
      try {
        publish((await bridge.coreSkills()) ?? ABSENT)
      } catch {
        if (current === null) publish(null)
      }
      return () => {
        subscriptions.delete(own)
        own()
      }
    },

    read,

    async admit(input) {
      return submit('skill.admit', input)
    },

    async revise(skillId, input) {
      return submit('skill.revise', { ...input, skillId })
    },

    async recordEvaluation(input) {
      return submit('skill.recordEvaluation', input)
    },

    async transition(skillId, to) {
      return submit('skill.transition', { skillId, to })
    },

    async retire(skillId, reason) {
      return submit('skill.retire', { skillId, reason })
    },

    async propose(input) {
      return submit('skill.propose', input)
    },

    async settleProposal(proposalId, decision, reason) {
      return submit('skill.proposal.settle', {
        proposalId,
        decision,
        ...(reason === undefined ? {} : { reason }),
      })
    },

    async select(input) {
      const answer = await submit('skill.select', {
        applicability: input.applicability ?? [],
        ...(input.includeTrial === undefined ? {} : { includeTrial: input.includeTrial }),
        ...(input.includeVerified === undefined ? {} : { includeVerified: input.includeVerified }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      })
      return answer.ok ? (answer.selection ?? null) : null
    },

    async readDetail(skillId) {
      const bridge = hostBridge()
      if (!bridge || typeof bridge.coreSubmit !== 'function') return null
      try {
        const result = await bridge.coreSubmit('skill.detail.read', { skillId })
        return result.skill?.detail ?? null
      } catch {
        return null
      }
    },

    reset() {
      for (const dispose of [...subscriptions]) dispose()
      subscriptions.clear()
      publish(null)
    },
  }
}