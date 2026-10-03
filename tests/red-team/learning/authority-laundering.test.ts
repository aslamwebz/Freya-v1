// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  LEARNING_FORBIDDEN_FIELDS,
  LEARNING_GRANTS_NOTHING,
  LearningEngine,
  admitToSkills,
  assertProposalIsInert,
  isProposalSource,
  type ProcedureProposal,
} from '../../../core/learning'
import { MemoryLearningStore } from '../../../core/vault/repositories/learning-store'

/**
 * AUTHORITY LAUNDERING THROUGH LEARNING.
 *
 * The attack this file exists for: a learned procedure is the most attractive way to get a
 * capability in, because it looks like Freya getting better rather than a privilege
 * request. The claim is that knowledge is not permission, and the tests below try to make
 * that claim false from every angle a launderer would reach for.
 */

const NOW = new Date('2026-06-01T12:00:00.000Z')
const NOW_ISO = NOW.toISOString()

function makeEngine(): LearningEngine {
  let counter = 0
  return new LearningEngine({
    store: new MemoryLearningStore(),
    now: () => NOW,
    newId: () => `gen-${(counter += 1)}`,
  })
}

async function twoChecks(engine: LearningEngine): Promise<void> {
  for (const suffix of ['a', 'b']) {
    await engine.recordVerifiedOutcome({
      outcomeId: `out-${suffix}`,
      sourceDomain: 'work',
      verificationId: `ver-${suffix}`,
      verifierId: 'work.step.verified',
      checked: 'the run completed and its verifier inspected the artefact',
      subjectRef: `run-${suffix}`,
      result: 'succeeded',
      establishedAt: NOW_ISO,
    })
    await engine.distilExperience(`out-${suffix}`, {
      experienceId: `exp-${suffix}`,
      kind: 'tool-lesson',
      lesson: `the release verifier inspected the artefact bundle for ${suffix}`,
      scope: 'one-instance',
      scopeLimits: ['observed-once', 'no-future-guarantee'],
      observedAt: NOW_ISO,
    })
    await engine.deriveKnowledge({
      knowledgeId: `kn-${suffix}`,
      kind: 'process-fact',
      claim: `a release check has to inspect the artefact bundle (${suffix})`,
      scope: 'one-instance',
      scopeLimits: ['observed-once', 'no-future-guarantee'],
      supports: [`exp-${suffix}`],
      tags: ['release'],
      observedAt: NOW_ISO,
    })
  }
}

describe('a claim cannot carry a capability', () => {
  it('refuses every authority-shaped field name on an experience', async () => {
    const engine = makeEngine()
    await engine.recordVerifiedOutcome({
      outcomeId: 'out-1',
      sourceDomain: 'work',
      verificationId: 'ver-1',
      verifierId: 'work.step.verified',
      checked: 'the run completed and its verifier inspected the artefact',
      subjectRef: 'run-1',
      result: 'succeeded',
      establishedAt: NOW_ISO,
    })
    for (const field of ['capability', 'grantsCapability', 'bypassGuard', 'clearStopAll', 'budget', 'approve']) {
      const outcome = await engine.distilExperience('out-1', {
        experienceId: 'exp-1',
        kind: 'tool-lesson',
        lesson: 'a lesson that also tries to carry authority',
        scope: 'one-instance',
        scopeLimits: ['observed-once', 'no-future-guarantee'],
        observedAt: NOW_ISO,
        // An untyped payload: the constructor is typed, so a real caller could not do this.
        ...({ [field]: 'work.run.manage' } as Record<string, unknown>),
      } as never)
      expect(outcome.ok, field).toBe(false)
      if (outcome.ok) continue
      expect(outcome.code).toBe('forbidden-field-refused')
    }
  })

  it('refuses every authority-shaped field name on a claim', async () => {
    const engine = makeEngine()
    await twoChecks(engine)
    const outcome = await engine.deriveKnowledge({
      knowledgeId: 'kn-forged',
      kind: 'process-fact',
      claim: 'a claim that would install a tool if it could',
      scope: 'one-instance',
      scopeLimits: ['observed-once', 'no-future-guarantee'],
      supports: ['exp-a'],
      observedAt: NOW_ISO,
      ...({ requiredCapabilities: ['work.run.manage'] } as Record<string, unknown>),
    } as never)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('forbidden-field-refused')
  })

  it('covers the whole forbidden vocabulary', () => {
    expect(LEARNING_FORBIDDEN_FIELDS.length).toBeGreaterThan(20)
    for (const family of ['capability', 'grant', 'permission', 'always', 'secret', 'feeling']) {
      expect(LEARNING_FORBIDDEN_FIELDS).toContain(family)
    }
  })
})

describe('a proposal grants nothing, whichever way it is inspected', () => {
  it('states it as data rather than merely respecting it', async () => {
    const engine = makeEngine()
    await twoChecks(engine)
    const proposal = engine.proposals()[0]!
    expect(proposal.grantsCapability).toBe(false)
    expect(proposal.executable).toBe(false)
    expect(proposal.authority).toBe('none')
    expect(LEARNING_GRANTS_NOTHING.mayExecute).toBe(false)
    expect(LEARNING_GRANTS_NOTHING.mayPromoteItself).toBe(false)

    const projection = engine.project()
    expect(projection.authority).toBe('none')
    for (const view of projection.proposals) {
      expect(view.grantsCapability).toBe(false)
      expect(view.executable).toBe(false)
      expect(view.authority).toBe('none')
    }
  })

  it('refuses a proposal edited to claim authority, rather than sanitising it', () => {
    const base: ProcedureProposal = {
      proposalId: 'prop-x',
      name: 'procedure for release',
      steps: [{ key: 'step-1', summary: 'inspect the artefact' }],
      knowledgeIds: ['kn-a'],
      experienceIds: ['exp-a'],
      distinctVerifications: 2,
      failedOutcomes: 0,
      scope: 'one-instance',
      scopeLimits: ['no-future-guarantee'],
      confidence: 'medium',
      grantsCapability: false,
      executable: false,
      authority: 'none',
      support: {
        aboveThreshold: true,
        distinctVerifications: 2,
        distinctExperiences: 2,
        failedOutcomes: 0,
        staleVerifications: 0,
        reason: 'above-threshold',
      },
    }
    expect(assertProposalIsInert(base).ok).toBe(true)

    for (const forgery of [
      { ...base, grantsCapability: true },
      { ...base, executable: true },
      { ...base, authority: 'work.run.manage' },
      { ...base, steps: [] },
    ] as ProcedureProposal[]) {
      const inert = assertProposalIsInert(forgery)
      expect(inert.ok).toBe(false)
      expect(admitToSkills(forgery).ok).toBe(false)
    }
  })

  it('hands the Skills domain a packet with nothing authority-shaped on it', async () => {
    const engine = makeEngine()
    await twoChecks(engine)
    const packets = engine.skillPackets()
    expect(packets.ok).toBe(true)
    if (!packets.ok) return
    const packet = packets.packets[0]!
    expect(packet.executable).toBe(false)
    expect(packet.trustClass).toBe('derived')
    for (const key of Object.keys(packet)) {
      expect(key, key).not.toMatch(/capab|grant|authority|permission|allow|override|budget|spend|secret|credential/i)
    }
    // No status field either: the proposal does not decide its own standing. Skills starts
    // every admission at `candidate` and promotes on evidence.
    expect(Object.keys(packet).sort()).toEqual(['executable', 'kind', 'name', 'originRefs', 'steps', 'trustClass'])
  })

  it('refuses a proposal derived from something that was not checked', () => {
    for (const source of ['model-inference', 'external-untrusted', 'imported-document', 'freya-inference'] as const) {
      expect(isProposalSource(source), source).toBe(false)
    }
    for (const source of ['experience-outcome', 'owner-assertion', 'system-observation'] as const) {
      expect(isProposalSource(source), source).toBe(true)
    }
  })

  it('exposes no engine method that could promote, activate or execute', () => {
    const engine = makeEngine()
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(engine) as object).map(String)
    for (const name of methods) {
      expect(name, `${name} sounds like an activation path`).not.toMatch(
        /promote|activate|enable|grant|execute|install|register|deploy|import|eval/i,
      )
    }
  })

  it('imports nothing that could reach a gateway, an authority object or a filesystem', async () => {
    const { readFile, readdir } = await import('node:fs/promises')
    const { fileURLToPath } = await import('node:url')
    const { join } = await import('node:path')
    const root = fileURLToPath(new URL('../../../core/learning/', import.meta.url))
    for (const name of await readdir(root)) {
      if (!name.endsWith('.ts')) continue
      const source = await readFile(join(root, name), 'utf8')
      // Every *import statement* in the domain. A prose mention of a guard or an authority
      // in a comment is documentation; an import is a capability. Matching is on the final
      // path segment, so `core/authority/types` is a dependency while `./safeguards` is not.
      const imports = source.match(/^\s*import[\s\S]*?from\s+['"][^'"]+['"]/gm) ?? []
      for (const statement of imports) {
        const specifier = /from\s+['"]([^'"]+)['"]/.exec(statement)?.[1] ?? ''
        const last = specifier.split('/').filter((part) => part.length > 0).pop() ?? ''
        for (const forbidden of ['authority', 'guard', 'governor', 'security', 'vault', 'skills', 'model', 'fs']) {
          expect(last, `${name} imports ${specifier}`).not.toBe(forbidden)
        }
        expect(specifier, `${name} imports ${specifier}`).not.toMatch(/^node:/)
        expect(specifier, `${name} imports ${specifier}`).not.toMatch(/^(\.\.\/)+(model|authority|guard|skills)\b/)
      }
    }
  })
})

describe('nothing in this domain is a security event and grants nothing', () => {
  it('reports a degraded store as degraded, without touching authority', async () => {
    const store = new MemoryLearningStore()
    const engine = new LearningEngine({ store, now: () => NOW })
    expect(engine.persistence().degraded).toBe(false)
    expect(engine.persistence().durable).toBe(false)
  })
})