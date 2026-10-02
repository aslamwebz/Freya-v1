import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ABSENT_SKILL_PROJECTION,
  type SkillProjection,
} from '../../core/protocol/skills'
import { initialSkillState, projectSkills } from '../../core/skills'
import {
  createSkillsMirror,
  resetSkillsMirror,
  skillsMirror,
} from '../../src/platform/skillsClient'

/**
 * The renderer's Skills mirror.
 *
 * The boundary properties are the point:
 *
 *  1. It holds what Core pushed and cannot write any of it.
 *  2. Its one read takes **no arguments** — there is no parameter in which a status, a
 *     verdict or a threshold could travel.
 *  3. It exposes no method that executes a skill, submits a verification record, sets a
 *     threshold or offers an artifact into the runtime, so a caller asking for one gets
 *     a missing method rather than a refusal it could learn to phrase differently.
 *  4. Its mutating calls send only the named fields: no trust class, no verification
 *     array, no version, and commentary as a *character count*.
 */

function projection(sequence = 0): SkillProjection {
  return {
    ...projectSkills({
      sequence,
      state: initialSkillState(),
      persistence: { mode: 'encrypted', durable: true, reason: null },
    }),
  }
}

let coreSubmit: ReturnType<typeof vi.fn>
let coreSkills: ReturnType<typeof vi.fn>
let handlers: Set<(projection: SkillProjection) => void>

function push(next: SkillProjection): void {
  for (const handler of [...handlers]) handler(next)
}

beforeEach(() => {
  resetSkillsMirror()
  handlers = new Set()
  coreSubmit = vi.fn(async () => ({
    requestId: 'r1',
    ok: true,
    skill: { operation: 'admitted', ok: true, skillId: 'sk_1', version: 1, status: 'candidate' },
  }))
  coreSkills = vi.fn(async () => projection())
  window.freyaHost = {
    isDesktop: true,
    coreSubmit: coreSubmit as never,
    coreSkills: coreSkills as never,
    onCoreSkills: ((next: (p: SkillProjection) => void) => {
      handlers.add(next)
      return () => {
        handlers.delete(next)
      }
    }) as never,
  } as never
})

afterEach(() => {
  resetSkillsMirror()
  delete window.freyaHost
})

const DRAFT = {
  name: 'summarise-a-file',
  kind: 'procedure',
  summary: 'Reads a file and produces a bounded summary of it.',
  contract: {
    inputs: [{ name: 'path', description: 'The file to read.' }],
    outputs: [{ name: 'summary', description: 'A bounded summary.' }],
    preconditions: [],
    postconditions: [{ name: 'recorded', description: 'The step closed on its verifier.' }],
  },
  applicability: ['research'],
  requiredCapabilities: ['work.execute'],
  steps: [{ key: 'read', capability: 'test.record', verifier: 'test.record.matches' }],
} as const

describe('a mirror that holds only what Core sent', () => {
  it('is absent before anything has reported', () => {
    expect(createSkillsMirror().projection).toBeNull()
  })

  it('reads once and then follows pushes', async () => {
    const mirror = createSkillsMirror()
    await mirror.attach()
    expect(coreSkills).toHaveBeenCalledTimes(1)
    expect(mirror.projection?.health).toBe('ready')
    push({ ...projection(5), counts: { ...projection().counts, retained: 1 } })
    expect(mirror.projection?.counts.retained).toBe(1)
  })

  it('publishes Core’s absent projection when the host has no Core yet', async () => {
    coreSkills.mockImplementation(async () => null)
    const mirror = createSkillsMirror()
    await mirror.attach()
    expect(mirror.projection?.health).toBe('unavailable')
    expect(mirror.projection?.reason).toBe(ABSENT_SKILL_PROJECTION.reason)
  })

  it('does not let a late pull overwrite a newer push', async () => {
    const mirror = createSkillsMirror()
    coreSkills.mockImplementation(async () => projection(99))
    await mirror.attach()
    push(projection(10))
    await mirror.read()
    expect(mirror.projection?.sequence).toBe(10)
  })

  it('tolerates a bridge that predates this lane', async () => {
    delete (window.freyaHost as { coreSkills?: unknown }).coreSkills
    delete (window.freyaHost as { onCoreSkills?: unknown }).onCoreSkills
    const mirror = createSkillsMirror()
    await expect(mirror.attach()).resolves.toBeTypeOf('function')
    expect(mirror.projection).toBeNull()
    expect(await mirror.read()).toBeNull()
  })

  it('stops publishing after reset', async () => {
    const mirror = skillsMirror()
    await mirror.attach()
    expect(mirror.projection).not.toBeNull()
    mirror.reset()
    expect(mirror.projection).toBeNull()
    expect(handlers.size).toBe(0)
  })
})

describe('the owner actions this lane may take', () => {
  it('admits through named fields only, and lets Core’s push be the update', async () => {
    const mirror = skillsMirror()
    const outcome = await mirror.admit(DRAFT)
    expect(outcome.ok).toBe(true)
    const [command, payload] = coreSubmit.mock.calls[0] as [string, Record<string, unknown>]
    expect(command).toBe('skill.admit')
    expect(payload.name).toBe('summarise-a-file')
    // None of the four things Core owns can be supplied from here.
    expect('trustClass' in payload).toBe(false)
    expect('status' in payload).toBe(false)
    expect('verification' in payload).toBe(false)
    expect('version' in payload).toBe(false)
  })

  it('revises with the skill id and nothing the caller decided', async () => {
    const mirror = skillsMirror()
    await mirror.revise('sk_1', DRAFT)
    const [command, payload] = coreSubmit.mock.calls[0] as [string, Record<string, unknown>]
    expect(command).toBe('skill.revise')
    expect(payload.skillId).toBe('sk_1')
    expect('status' in payload).toBe(false)
    expect('trustClass' in payload).toBe(false)
  })

  it('records an evaluation as evidence, metrics and a commentary *count*', async () => {
    const mirror = skillsMirror()
    await mirror.recordEvaluation({
      skillId: 'sk_1',
      subjectKind: 'trial-run',
      subjectRef: 'run-1',
      evidence: [{ kind: 'test-result', code: 'passed', count: 3 }],
      metrics: [{ name: 'attempts', value: 2 }],
      commentaryLength: 2_000,
    })
    const [command, payload] = coreSubmit.mock.calls[0] as [string, Record<string, unknown>]
    expect(command).toBe('skill.recordEvaluation')
    expect(payload.evidence).toEqual([{ kind: 'test-result', code: 'passed', count: 3 }])
    expect(payload.commentaryLength).toBe(2_000)
    // The three things a caller must never be able to send.
    expect('verification' in payload).toBe(false)
    expect('verdict' in payload).toBe(false)
    expect('author' in payload).toBe(false)
  })

  it('moves a status and retires one, carrying nothing but names', async () => {
    const mirror = skillsMirror()
    await mirror.transition('sk_1', 'draft')
    expect(coreSubmit.mock.calls[0]?.[0]).toBe('skill.transition')
    expect(coreSubmit.mock.calls[0]?.[1]).toEqual({ skillId: 'sk_1', to: 'draft' })
    await mirror.retire('sk_1', 'owner-request')
    expect(coreSubmit.mock.calls[1]?.[0]).toBe('skill.retire')
    expect(coreSubmit.mock.calls[1]?.[1]).toEqual({ skillId: 'sk_1', reason: 'owner-request' })
  })

  it('proposes and settles without choosing its own basis', async () => {
    const mirror = skillsMirror()
    await mirror.propose({ target: 'skill', targetRef: 'sk_1', summary: 'do it better' })
    const [command, payload] = coreSubmit.mock.calls[0] as [string, Record<string, unknown>]
    expect(command).toBe('skill.propose')
    // The basis evaluations are Core's; a caller that could choose them could propose an
    // improvement from one good run.
    expect('basisEvaluationIds' in payload).toBe(false)
    await mirror.settleProposal('p1', 'refused', 'revision-limit')
    expect(coreSubmit.mock.calls[1]?.[0]).toBe('skill.proposal.settle')
    expect(coreSubmit.mock.calls[1]?.[1]).toEqual({
      proposalId: 'p1',
      decision: 'refused',
      reason: 'revision-limit',
    })
  })

  it('asks Core to rank, and returns Core’s order rather than sorting itself', async () => {
    coreSubmit.mockImplementation(async () => ({
      requestId: 'r1',
      ok: true,
      skill: {
        operation: 'selected',
        ok: true,
        selection: {
          candidates: [
            {
              skillId: 'sk_b',
              name: 'b',
              kind: 'procedure',
              status: 'promoted',
              version: 1,
              verification: 'verified',
              trustClass: 'owner-declared',
              establishedCount: 9,
              matchedTags: ['research'],
              executionsPlanned: 0,
            },
            {
              skillId: 'sk_a',
              name: 'a',
              kind: 'procedure',
              status: 'trial',
              version: 1,
              verification: 'unverified',
              trustClass: 'owner-declared',
              establishedCount: 1,
              matchedTags: ['research'],
              executionsPlanned: 0,
            },
          ],
          considered: 2,
          emptyReason: null,
        },
      },
    }))
    const mirror = skillsMirror()
    const report = await mirror.select({ applicability: ['research'], includeTrial: true })
    // Verbatim, in Core's order — a window that re-sorted it would be inventing a
    // preference the domain does not have.
    expect(report?.candidates.map((candidate) => candidate.skillId)).toEqual(['sk_b', 'sk_a'])
    const [command, payload] = coreSubmit.mock.calls[0] as [string, Record<string, unknown>]
    expect(command).toBe('skill.select')
    expect(payload.applicability).toEqual(['research'])
    expect(payload.includeTrial).toBe(true)
  })

  it('reads one body back, and nothing else on this lane can', async () => {
    coreSubmit.mockImplementation(async () => ({
      requestId: 'r1',
      ok: true,
      skill: {
        operation: 'detail',
        ok: true,
        detail: {
          skillId: 'sk_1',
          name: 'summarise-a-file',
          kind: 'procedure',
          status: 'candidate',
          version: 1,
          verification: 'unverified',
          contentHash: 'a'.repeat(32),
          summary: 'Reads a file.',
          steps: [{ key: 'read', capability: 'test.record', verifier: 'test.record.matches' }],
          requiredCapabilities: ['work.execute'],
          applicability: ['research'],
          contract: {
            inputs: [{ name: 'path', description: 'The file to read.' }],
            outputs: [{ name: 'summary', description: 'A bounded summary.' }],
            preconditions: [],
            postconditions: [{ name: 'recorded', description: 'Closed on its verifier.' }],
          },
          provenance: {
            source: 'owner',
            trustClass: 'owner-declared',
            admittedBy: 'owner',
            admittedAt: '2026-10-02T09:00:00.000Z',
            parentSkillId: null,
            parentVersion: null,
          },
        },
      },
    }))
    const mirror = skillsMirror()
    const detail = await mirror.readDetail('sk_1')
    expect(detail?.summary).toBe('Reads a file.')
    expect(coreSubmit.mock.calls[0]?.[0]).toBe('skill.detail.read')
  })
})

describe('the authority this lane does not expose', () => {
  it('has no method that could execute, verify, grant or write to a runtime', () => {
    const mirror = skillsMirror() as unknown as Record<string, unknown>
    expect(Object.keys(mirror).sort()).toEqual([
      'admit',
      'attach',
      'projection',
      'propose',
      'read',
      'readDetail',
      'recordEvaluation',
      'reset',
      'retire',
      'revise',
      'select',
      'settleProposal',
      'subscribe',
      'transition',
    ])
    for (const forbidden of [
      'execute',
      'plan',
      'run',
      'verify',
      'grant',
      'approve',
      'promoteArtifact',
      'setThreshold',
      'setStatus',
      'stopAll',
    ]) {
      expect(Object.keys(mirror)).not.toContain(forbidden)
    }
  })

  it('reports a refusal rather than throwing when the bridge is missing', async () => {
    delete window.freyaHost
    const outcome = await skillsMirror().admit(DRAFT)
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toMatch(/bridge is not available/i)
  })

  it('reports a refusal when Core refuses, keeping the code', async () => {
    coreSubmit.mockImplementation(async () => ({
      requestId: 'r1',
      ok: false,
      refusal: { reason: 'a Core refusal' },
      skill: { operation: 'refused', ok: false, code: 'boundary-violation', reason: 'a Core refusal' },
    }))
    const outcome = await skillsMirror().admit(DRAFT)
    expect(outcome.ok).toBe(false)
    expect(outcome.code).toBe('boundary-violation')
    expect(outcome.reason).toBe('a Core refusal')
  })

  it('returns null rather than a fabricated selection when Core refused one', async () => {
    coreSubmit.mockImplementation(async () => ({
      requestId: 'r1',
      ok: false,
      refusal: { reason: 'nope' },
      skill: { operation: 'refused', ok: false, reason: 'nope' },
    }))
    expect(await skillsMirror().select({})).toBeNull()
  })
})