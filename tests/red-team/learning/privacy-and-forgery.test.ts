// @vitest-environment node
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LearningEngine } from '../../../core/learning'
import { MemoryLearningStore } from '../../../core/vault/repositories/learning-store'
import { deepStrings, expectNoSentinels, RED_TEAM_SENTINELS } from '../harness'

/**
 * PRIVACY AND FORGERY IN THE LEARNING DOMAIN.
 *
 * Two claims, tested separately.
 *
 * **Privacy**: what Freya learned can be as revealing as what she knows — a claim about a
 * failing tool says something about the machine, and a claim about a release process says
 * something about how work is done here. So no lesson or claim text crosses in a broad
 * read, and the two reads that do are Core-internal.
 *
 * **Forgery**: a renderer, an untrusted page or a hand-edited file cannot manufacture a
 * learning record. There is no write verb on the protocol surface, no `learning.*` command
 * on the Core surface, and no renderer-reachable path to the domain.
 */

const SENTINEL = RED_TEAM_SENTINELS[0]
const NOW = new Date('2026-06-01T12:00:00.000Z')
const NOW_ISO = NOW.toISOString()
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))

function makeEngine(): LearningEngine {
  let counter = 0
  return new LearningEngine({
    store: new MemoryLearningStore(),
    now: () => NOW,
    newId: () => `gen-${(counter += 1)}`,
  })
}

async function seed(engine: LearningEngine, text: string): Promise<string> {
  await engine.recordVerifiedOutcome({
    outcomeId: 'out-1',
    sourceDomain: 'work',
    verificationId: 'ver-1',
    verifierId: 'work.step.verified',
    checked: `the run completed and its verifier inspected ${SENTINEL}`,
    subjectRef: 'run-1',
    result: 'succeeded',
    establishedAt: NOW_ISO,
  })
  await engine.distilExperience('out-1', {
    experienceId: 'exp-1',
    kind: 'tool-lesson',
    lesson: `the release verifier inspected the artefact bundle ${text}`,
    scope: 'one-instance',
    scopeLimits: ['observed-once', 'no-future-guarantee'],
    observedAt: NOW_ISO,
  })
  await engine.deriveKnowledge({
    knowledgeId: 'kn-1',
    kind: 'process-fact',
    claim: `a release check has to inspect the artefact bundle ${text}`,
    scope: 'one-instance',
    scopeLimits: ['observed-once', 'no-future-guarantee'],
    supports: ['exp-1'],
    tags: ['release'],
    observedAt: NOW_ISO,
  })
  return 'kn-1'
}

async function sourceFiles(dir: string, extensions = ['.ts', '.tsx']): Promise<string[]> {
  const output: string[] = []
  async function walk(current: string): Promise<void> {
    for (const item of await readdir(current, { withFileTypes: true })) {
      const path = join(current, item.name)
      if (item.isDirectory()) await walk(path)
      else if (item.isFile() && extensions.some((end) => item.name.endsWith(end))) output.push(path)
    }
  }
  await walk(dir)
  return output
}

describe('a lesson or claim never reaches a broad sink', () => {
  it('keeps both texts out of the projection and the broad read', async () => {
    const engine = makeEngine()
    await seed(engine, SENTINEL)
    expectNoSentinels('learning projection', engine.project())
    expectNoSentinels('learning derivation', engine.derive())
    expectNoSentinels('learning records read', engine.listRecords())
    // And the specific words, not only the sentinel.
    const surface = JSON.stringify({ p: engine.project(), l: engine.listRecords() })
    expect(surface).not.toContain('a release check has to inspect')
    expect(surface).not.toContain('the release verifier inspected')
  })

  it('carries the text only in the single-claim read and the owner export', async () => {
    const engine = makeEngine()
    const claimId = await seed(engine, 'on this machine')
    const single = engine.readClaim(claimId)
    if (!single.ok) throw new Error('the single read refused')
    expect(single.claim.claim).toContain('a release check has to inspect')
    const exported = engine.export()
    if (!exported.ok) throw new Error('export refused')
    expect(exported.export.items.length).toBeGreaterThan(0)
  })

  it('keeps a proposal name code-owned rather than copied from a claim', async () => {
    const engine = makeEngine()
    // Two checks so a proposal exists at all.
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
        claim: `a release check has to inspect the artefact bundle rather than trust the log (${suffix})`,
        scope: 'one-instance',
        scopeLimits: ['observed-once', 'no-future-guarantee'],
        supports: [`exp-${suffix}`],
        tags: ['release'],
        observedAt: NOW_ISO,
      })
    }
    const proposal = engine.proposals()[0]!
    expect(proposal.name).toBe('procedure for release')
    // The step summaries do carry the claims, but they never leave Core: the projection
    // exposes only a step *count*.
    const view = engine.project().proposals[0]!
    expect(Object.keys(view).sort()).toEqual([
      'authority',
      'confidence',
      'distinctVerifications',
      'executable',
      'experienceIds',
      'failedOutcomes',
      'grantsCapability',
      'knowledgeIds',
      'name',
      'proposalId',
      'scope',
      'scopeLimits',
      'stepCount',
      'support',
    ])
    expect(view.stepCount).toBe(2)
    expectNoSentinels('the proposal view', view)
  })

  it('destroys the claim text on withdrawal and on forgetting', async () => {
    const engine = makeEngine()
    const claimId = await seed(engine, SENTINEL)
    expect((await engine.withdraw(claimId)).ok).toBe(true)
    const read = engine.readClaim(claimId)
    if (!read.ok) throw new Error('the single read refused')
    expect(read.claim.claim).toBe('')
    expect(read.claim.textDestroyed).toBe(true)
    expectNoSentinels('the whole surface after withdrawal', {
      projection: engine.project(),
      records: engine.listRecords(),
      claim: read.claim,
    })

    expect((await engine.forget(claimId)).ok).toBe(true)
    const exported = engine.export()
    if (!exported.ok) throw new Error('export refused')
    expect(exported.export.items.some((item) => item.recordId === claimId)).toBe(false)
  })

  it('keeps a secret-shaped lesson out of the store whole, rather than redacting it', async () => {
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
    const outcome = await engine.distilExperience('out-1', {
      experienceId: 'exp-1',
      kind: 'tool-lesson',
      lesson: 'the deploy key is sk-abcdefghijklmnopqrstuvwxyz012345',
      scope: 'one-instance',
      scopeLimits: ['observed-once', 'no-future-guarantee'],
      observedAt: NOW_ISO,
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('invalid-claim')
    expect(engine.export().ok).toBe(true)
    if (!engine.export().ok) return
    expect(deepStrings(engine.export()).some((text) => text.includes('sk-abcdef'))).toBe(false)
  })
})

describe('a renderer cannot manufacture what Freya learned', () => {
  it('exposes no write verb on the learning protocol surface', async () => {
    const protocol = await readFile(join(REPO_ROOT, 'core', 'protocol', 'learning.ts'), 'utf8')
    for (const verb of [
      'recordVerifiedOutcome',
      'distilExperience',
      'deriveKnowledge',
      'recordOwnerLesson',
      'correct',
      'withdraw',
      'forget',
      'write',
      'admit',
    ]) {
      expect(protocol, `${verb} appears as a member of the protocol`).not.toMatch(
        new RegExp(`(readonly\\s+)?${verb}\\s*\\(`),
      )
    }
  })

  it('registers no learning command on the Core surface', async () => {
    const commands = await readFile(join(REPO_ROOT, 'core', 'protocol', 'core-protocol.ts'), 'utf8')
    expect(commands).not.toMatch(/'learning\./)
  })

  it('is not imported by any renderer source', async () => {
    for (const path of await sourceFiles(join(REPO_ROOT, 'src'))) {
      const source = await readFile(path, 'utf8')
      expect(source, path).not.toMatch(/from\s+['"][^'"]*core\/learning/)
      expect(source, path).not.toMatch(/from\s+['"][^'"]*vault\/repositories\/learning-store/)
    }
  })

  it('keeps the Vault out of the domain, so no renderer path reaches a database', async () => {
    for (const path of await sourceFiles(join(REPO_ROOT, 'core', 'learning'))) {
      const source = await readFile(path, 'utf8')
      const imports = source.match(/^\s*import[\s\S]*?from\s+['"][^'"]+['"]/gm) ?? []
      for (const statement of imports) {
        expect(statement, path).not.toMatch(/vault/)
      }
      expect(source, path).not.toMatch(/better-sqlite3|sqlcipher/i)
    }
  })
})

describe('a degraded store is reported, never quietly substituted', () => {
  it('says memory, not durability, for the in-memory store', () => {
    const engine = makeEngine()
    const projection = engine.project()
    expect(projection.persistence.mode).toBe('memory')
    expect(projection.persistence.durable).toBe(false)
    expect(projection.persistence.degraded).toBe(false)
  })

  it('derives durability from the store mode and nothing else', async () => {
    const engine = makeEngine()
    await seed(engine, 'on this machine')
    const projection = engine.project()
    expect(projection.persistence.durable).toBe(projection.persistence.mode === 'encrypted')
  })
})