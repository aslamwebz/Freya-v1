// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  FORGE_FORBIDDEN_CAPABILITIES,
  FORGE_STATUSES,
  FORGE_TRANSITIONS,
  canTransitionForge,
  forgePackageId,
  isForgeRefusalCode,
  isForgeRuntimeKind,
} from '../../core/forge/types'
import { forgeIntegrityHash, parseForgeManifest } from '../../core/forge/manifest'
import { runForgePipeline, type ForgeValidationEnvironment } from '../../core/forge/pipeline'
import { discoverForgePackages } from '../../core/forge/discovery'
import { planInstall, planRollback, type ForgeVersionSummary } from '../../core/forge/versions'
import { CAPABILITIES } from '../../core/protocol/core-protocol'
import type { ForgeManifest } from '../../core/forge/types'

/**
 * THE FORGE DOMAIN — the pure layer.
 *
 * The manifest door, the pipeline, capability admission, versioning and discovery,
 * tested without a Core and without a journal, because none of them should need one.
 */

const PROVENANCE = {
  origin: 'forge-generated' as const,
  model: 'test-model',
  requestHash: null,
  originRef: null,
  createdAt: '2026-01-01T00:00:00.000Z',
}

/** A pure transform: read a text field, upper-case it, publish it. */
export function pureManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'shout-it',
    runtime: 'pure-transform',
    description: 'Upper-cases one field of text.',
    inputs: { fields: [{ name: 'text', type: 'string', required: true, maxLength: 512 }] },
    outputs: { fields: [{ name: 'loud', type: 'string', required: true, maxLength: 512 }] },
    capabilitiesRequired: [],
    access: { network: 'denied', filesystem: 'denied', device: 'denied', keyring: 'denied', process: 'denied' },
    dependencies: [],
    tags: ['text'],
    program: {
      steps: [
        { op: 'bind-input', to: 'raw', arg: 'text' },
        { op: 'string-transform', to: 'loud', from: 'raw', fn: 'upper' },
        { op: 'output', to: 'loud', from: 'loud' },
      ],
    },
    ...overrides,
  }
}

function parse(payload: unknown, version = 1): { manifest: ForgeManifest; integrityHash: string } {
  const parsed = parseForgeManifest({ payload, version, provenance: PROVENANCE })
  if (!parsed.ok) throw new Error(`expected a manifest, got ${parsed.code}: ${parsed.reason}`)
  return { manifest: parsed.manifest, integrityHash: parsed.integrityHash }
}

function environment(overrides: Partial<ForgeValidationEnvironment> = {}): ForgeValidationEnvironment {
  return {
    isCapabilityRegistered: () => false,
    installed: () => [],
    approvalRequired: () => false,
    approvalState: () => 'not-required',
    ...overrides,
  }
}

function pipelineFor(payload: unknown, overrides: Partial<ForgeValidationEnvironment> = {}) {
  const parsed = parseForgeManifest({ payload, version: 1, provenance: PROVENANCE })
  if (!parsed.ok) throw new Error(`expected a manifest, got ${parsed.code}`)
  return runForgePipeline({
    payload,
    manifest: parsed.manifest,
    manifestCode: null,
    manifestReason: null,
    integrityHash: parsed.integrityHash,
    environment: environment(overrides),
    ranAt: '2026-01-01T00:00:00.000Z',
    monotonic: () => 0,
  })
}

describe('the manifest door', () => {
  it('accepts a well-formed pure transform and hashes it', () => {
    const { manifest, integrityHash } = parse(pureManifest())
    expect(manifest.name).toBe('shout-it')
    expect(manifest.version).toBe(1)
    expect(integrityHash).toMatch(/^[a-f0-9]{32}$/)
  })

  it('gives the same bytes the same hash regardless of key order', () => {
    const a = parse(pureManifest())
    const b = parse({
      program: pureManifest().program,
      tags: ['text'],
      dependencies: [],
      access: pureManifest().access,
      capabilitiesRequired: [],
      outputs: pureManifest().outputs,
      inputs: pureManifest().inputs,
      description: 'Upper-cases one field of text.',
      runtime: 'pure-transform',
      name: 'shout-it',
    })
    expect(a.integrityHash).toBe(b.integrityHash)
  })

  it('refuses an unknown runtime rather than inventing one', () => {
    const parsed = parseForgeManifest({
      payload: pureManifest({ runtime: 'arbitrary-plugin' }),
      version: 1,
      provenance: PROVENANCE,
    })
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.code).toBe('unknown-runtime')
  })

  it('refuses an unknown capability', () => {
    const parsed = parseForgeManifest({
      payload: pureManifest({ capabilitiesRequired: ['totally.made.up'] }),
      version: 1,
      provenance: PROVENANCE,
    })
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.code).toBe('unknown-capability')
  })

  it('refuses a capability that decides whether Freya may act', () => {
    for (const capability of ['security.stop', 'cognition.grant.manage', 'work.approval.decide', 'skill.manage']) {
      const parsed = parseForgeManifest({
        payload: pureManifest({ capabilitiesRequired: [capability] }),
        version: 1,
        provenance: PROVENANCE,
      })
      expect(parsed.ok).toBe(false)
      if (!parsed.ok) expect(parsed.code).toBe('forbidden-capability')
    }
    expect(FORGE_FORBIDDEN_CAPABILITIES).toContain('security.stop')
    expect(FORGE_FORBIDDEN_CAPABILITIES).toContain('foundry.artifact.manage')
  })

  it('refuses to declare keyring, process or filesystem access at all', () => {
    for (const field of ['keyring', 'process', 'filesystem']) {
      const parsed = parseForgeManifest({
        payload: pureManifest({ access: { ...(pureManifest().access as object), [field]: 'declared' } }),
        version: 1,
        provenance: PROVENANCE,
      })
      expect(parsed.ok).toBe(false)
      if (!parsed.ok) expect(parsed.code).toBe('malformed-manifest')
    }
  })

  it('refuses an operation that is not in the closed table', () => {
    const parsed = parseForgeManifest({
      payload: pureManifest({
        program: { steps: [{ op: 'exec', to: 'x', arg: 'ls' }] },
      }),
      version: 1,
      provenance: PROVENANCE,
    })
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.code).toBe('program-invalid')
  })

  it('refuses a schema field with no type', () => {
    const parsed = parseForgeManifest({
      payload: pureManifest({ inputs: { fields: [{ name: 'text', required: true }] } }),
      version: 1,
      provenance: PROVENANCE,
    })
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.code).toBe('schema-invalid')
  })

  it('derives its id from the name, so a retry is the same package', () => {
    expect(forgePackageId('shout-it')).toBe(forgePackageId('shout-it'))
    expect(forgePackageId('shout-it')).not.toBe(forgePackageId('whisper-it'))
  })
})

describe('the validation pipeline', () => {
  it('reports every stage, in order, when everything passes', () => {
    const report = pipelineFor(pureManifest())
    expect(report.passed).toBe(true)
    expect(report.stages.map((entry) => entry.stage)).toEqual([
      'manifest',
      'dependencies',
      'integrity',
      'security',
      'tests',
      'capabilities',
      'approval',
    ])
    expect(report.stages.every((entry) => entry.verdict === 'pass' || entry.verdict === 'not-applicable')).toBe(true)
    expect(report.tests?.verdict).toBe('passed')
  })

  it('cannot be told a stage passed: the stages are computed, not read', () => {
    // A candidate that *claims* to be verified and enabled is refused for claiming
    // it: the scan refuses a manifest carrying a key that is not its own.
    const withClaims = pipelineFor(pureManifest({ verified: true, status: 'verified', enabled: true }))
    expect(withClaims.passed).toBe(false)
    expect(withClaims.failingStage).toBe('security')
    expect(withClaims.code).toBe('grant-metadata-tampering')
  })

  it('keeps reporting the stages that did not run after a failure', () => {
    const report = pipelineFor(
      pureManifest({
        program: {
          steps: [
            { op: 'bind-input', to: 'raw', arg: 'text' },
            { op: 'string-transform', to: 'loud', from: 'nothing-bound', fn: 'upper' },
            { op: 'output', to: 'loud', from: 'loud' },
          ],
        },
      }),
    )
    expect(report.passed).toBe(false)
    expect(report.failingStage).toBe('manifest')
    expect(report.stages).toHaveLength(7)
    expect(report.stages.filter((entry) => entry.verdict === 'not-applicable')).toHaveLength(6)
  })

  it('refuses a dependency that is not installed, and never resolves one', () => {
    const report = pipelineFor(pureManifest({ dependencies: [{ name: 'other', version: 1 }] }))
    expect(report.passed).toBe(false)
    expect(report.failingStage).toBe('dependencies')
    expect(report.code).toBe('dependency-missing')
  })

  it('refuses a dependency pinned to a version this Core does not hold', () => {
    const report = pipelineFor(pureManifest({ dependencies: [{ name: 'other', version: 2 }] }), {
      installed: () => [{ name: 'other', version: 1, status: 'installed' }],
    })
    expect(report.passed).toBe(false)
    expect(report.code).toBe('dependency-refused')
  })

  it('refuses a self-dependency', () => {
    const report = pipelineFor(pureManifest({ dependencies: [{ name: 'shout-it', version: 1 }] }), {
      installed: () => [{ name: 'shout-it', version: 1, status: 'installed' }],
    })
    expect(report.passed).toBe(false)
    expect(report.code).toBe('dependency-cycle')
  })

  it('fails integrity when the hash does not describe the bytes', () => {
    const parsed = parse(pureManifest())
    const report = runForgePipeline({
      payload: pureManifest(),
      manifest: parsed.manifest,
      manifestCode: null,
      manifestReason: null,
      integrityHash: 'f'.repeat(32),
      environment: environment(),
      ranAt: '2026-01-01T00:00:00.000Z',
      monotonic: () => 0,
    })
    expect(report.passed).toBe(false)
    expect(report.failingStage).toBe('integrity')
    expect(report.code).toBe('integrity-mismatch')
  })

  it('refuses a capability this Core has not registered', () => {
    const payload = pureManifest({
      runtime: 'research-helper',
      capabilitiesRequired: ['research.start'],
      program: {
        steps: [
          { op: 'plan-research', to: 'plan', items: ['what changed in freya'] },
          { op: 'output', to: 'plan', from: 'plan' },
        ],
      },
      inputs: { fields: [{ name: 'note', type: 'string', required: false, maxLength: 64 }] },
      outputs: { fields: [{ name: 'plan', type: 'record', required: true, maxLength: 4, keys: ['kind', 'queries'] }] },
    })
    const report = pipelineFor(payload)
    expect(report.passed).toBe(false)
    expect(report.failingStage).toBe('capabilities')
    expect(report.code).toBe('capability-not-registered')
  })

  it('refuses any capability at all on a purely local runtime', () => {
    const payload = pureManifest({
      runtime: 'data-pipeline',
      capabilitiesRequired: ['search.web'],
      program: {
        steps: [
          { op: 'bind-input', to: 'raw', arg: 'text' },
          { op: 'output', to: 'loud', from: 'raw' },
        ],
      },
    })
    const report = pipelineFor(payload, { isCapabilityRegistered: () => true })
    expect(report.passed).toBe(false)
    expect(report.code).toBe('forbidden-capability')
  })

  it('reports approval as required rather than skipping it', () => {
    const payload = pureManifest({
      runtime: 'research-helper',
      capabilitiesRequired: ['research.start'],
      program: {
        steps: [
          { op: 'plan-research', to: 'plan', items: ['a question'] },
          { op: 'output', to: 'plan', from: 'plan' },
        ],
      },
      inputs: { fields: [{ name: 'note', type: 'string', required: false, maxLength: 64 }] },
      outputs: { fields: [{ name: 'plan', type: 'record', required: true, maxLength: 4, keys: ['kind', 'queries'] }] },
    })
    const report = pipelineFor(payload, {
      isCapabilityRegistered: (capability) => CAPABILITIES.includes(capability),
      approvalRequired: () => true,
      approvalState: () => 'pending',
    })
    expect(report.passed).toBe(false)
    expect(report.failingStage).toBe('approval')
    expect(report.code).toBe('approval-required')
  })

  it('fails the tests stage on a program that only works when told to', () => {
    // Requires an optional input, so the "optional fields absent" battery breaks.
    const payload = pureManifest({
      inputs: {
        fields: [
          { name: 'text', type: 'string', required: true, maxLength: 512 },
          { name: 'suffix', type: 'string', required: false, maxLength: 8 },
        ],
      },
      program: {
        steps: [
          { op: 'bind-input', to: 'raw', arg: 'text' },
          { op: 'bind-input', to: 'tail', arg: 'suffix' },
          { op: 'string-transform', to: 'loud', from: 'tail', fn: 'upper' },
          { op: 'output', to: 'loud', from: 'loud' },
        ],
      },
    })
    const report = pipelineFor(payload)
    expect(report.passed).toBe(false)
    expect(report.failingStage).toBe('tests')
    expect(report.code).toBe('tests-failed')
    expect(report.tests?.failures).toBe(1)
  })
})

describe('the closed tables', () => {
  it('has no edge from candidate straight to installed or enabled', () => {
    expect(FORGE_TRANSITIONS.candidate).not.toContain('installed')
    expect(FORGE_TRANSITIONS.candidate).not.toContain('enabled')
    expect(FORGE_TRANSITIONS.verified).not.toContain('enabled')
    expect(FORGE_TRANSITIONS.installed).toContain('enabled')
  })

  it('makes quarantine and removal terminal for running', () => {
    expect(FORGE_TRANSITIONS.quarantined).toEqual(['removed'])
    expect(FORGE_TRANSITIONS.removed).toEqual([])
    expect(canTransitionForge('quarantined', 'enabled')).toBe(false)
  })

  it('keeps every refusal code recognisable', () => {
    expect(isForgeRefusalCode('not-verified')).toBe(true)
    expect(isForgeRefusalCode('verified')).toBe(false)
    expect(FORGE_STATUSES).toContain('quarantined')
    expect(isForgeRuntimeKind('pure-transform')).toBe(true)
    expect(isForgeRuntimeKind('anything')).toBe(false)
  })
})

describe('versioning', () => {
  const summary: ForgeVersionSummary = {
    versions: [1, 2],
    currentVersion: 2,
    installedVersions: [1, 2],
    installedVersion: 2,
    hashes: { 1: 'a'.repeat(32), 2: 'b'.repeat(32) },
  }

  it('refuses to overwrite an existing version with different content', () => {
    const plan = planInstall(summary, parse(pureManifest({ name: 'shout-it' }), 2).manifest, 'c'.repeat(32), false)
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.code).toBe('version-conflict')
  })

  it('refuses a version that changes nothing', () => {
    const plan = planInstall(summary, parse(pureManifest({ name: 'shout-it' }), 2).manifest, 'b'.repeat(32), false)
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.code).toBe('identical-version')
  })

  it('accepts exactly the next version', () => {
    const plan = planInstall(summary, parse(pureManifest({ name: 'shout-it' }), 3).manifest, 'c'.repeat(32), false)
    expect(plan).toEqual({ ok: true, action: 'upgrade', version: 3 })
  })

  it('refuses a gap in the history', () => {
    const plan = planInstall(summary, parse(pureManifest({ name: 'shout-it' }), 4).manifest, 'c'.repeat(32), false)
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.code).toBe('version-conflict')
  })

  it('refuses a downgrade unless it was asked for explicitly', () => {
    const older = parse(pureManifest({ name: 'shout-it', description: 'An older version of the same transform.' }), 1)
    // A real downgrade reinstalls the bytes version 1 already has, so the recorded
    // hash for 1 is this manifest's own.
    const withOlder = { ...summary, hashes: { 1: older.integrityHash, 2: 'b'.repeat(32) } }
    const refused = planInstall(withOlder, older.manifest, older.integrityHash, false)
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.code).toBe('downgrade-not-explicit')
    const allowed = planInstall(withOlder, older.manifest, older.integrityHash, true)
    expect(allowed).toEqual({ ok: true, action: 'downgrade', version: 1 })
  })

  it('rolls back only to a version this Core still holds', () => {
    expect(planRollback(summary, 1)).toEqual({ ok: true, version: 1, from: 2 })
    const missing = planRollback({ ...summary, installedVersions: [2], hashes: { 2: 'b'.repeat(32) } }, 1)
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.code).toBe('no-such-version')
  })

  it('treats rolling forward as an upgrade, not a rollback', () => {
    // Version 3 was installed once and then superseded by nothing, so it is a real
    // version - but it is *ahead*, and the answer says so.
    const ahead = { ...summary, currentVersion: 2, installedVersions: [1, 2, 3], hashes: { ...summary.hashes, 3: 'c'.repeat(32) } }
    const plan = planRollback(ahead, 3)
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.code).toBe('version-conflict')
  })
})

describe('discovery', () => {
  const records = [
    {
      skillId: 'sk_1',
      name: 'shout-it',
      descriptionLength: 30,
      description: 'Upper-cases one field of text.',
      runtime: 'pure-transform' as const,
      status: 'enabled' as const,
      version: 1,
      enabled: true,
      tags: ['text'],
      capabilitiesRequired: [],
    },
    {
      skillId: 'sk_2',
      name: 'summarise-notes',
      descriptionLength: 20,
      description: 'Joins note lines.',
      runtime: 'data-pipeline' as const,
      status: 'candidate' as const,
      version: 1,
      enabled: false,
      tags: ['notes'],
      capabilitiesRequired: [],
    },
  ]

  it('finds by name without a model call', () => {
    const report = discoverForgePackages(records, { query: 'shout' })
    expect(report.hits.map((hit) => hit.name)).toEqual(['shout-it'])
  })

  it('hides candidates unless asked, and can be told to include them', () => {
    expect(discoverForgePackages(records, { query: 'notes' }).hits).toHaveLength(0)
    const included = discoverForgePackages(records, { query: 'notes', includeUnavailable: true })
    expect(included.hits.map((hit) => hit.name)).toEqual(['summarise-notes'])
  })

  it('reports why it found nothing', () => {
    expect(discoverForgePackages(records, { query: 'absent' }).emptyReason).toBe('no-match')
    expect(discoverForgePackages([], {}).emptyReason).toBe('nothing-searchable')
    expect(discoverForgePackages(records, { limit: 0 }).emptyReason).toBe('limit-zero')
  })

  it('is deterministic, including order', () => {
    const a = discoverForgePackages(records, {})
    const b = discoverForgePackages(records, {})
    expect(a.hits.map((hit) => hit.skillId)).toEqual(b.hits.map((hit) => hit.skillId))
  })
})

describe('the sandbox is not code', () => {
  const coreDir = join(process.cwd(), 'core')

  it('imports no host API in the interpreter', () => {
    const source = withoutComments(readFileSync(join(coreDir, 'forge', 'program.ts'), 'utf8'))
    expect(source).not.toMatch(/from 'node:/)
    expect(source).not.toMatch(/\brequire\(/)
    expect(source).not.toMatch(/\beval\b/)
    expect(source).not.toMatch(/new Function/)
    expect(source).not.toMatch(/\bprocess\./)
  })

  it('imports no host API in any module that touches a candidate', () => {
    // The manifest module hashes, so it may use `node:crypto`, and the persistence
    // directory is the only other place a host import is allowed. Nothing on the
    // executable path reaches either — which is the property the interpreter's
    // safety rests on, so it is asserted rather than asserted-in-prose.
    const dir = join(coreDir, 'forge')
    const files = readdirSync(dir).filter((name) => name.endsWith('.ts') && name !== 'manifest.ts')
    expect(files.length).toBeGreaterThan(5)
    for (const name of files) {
      const source = readFileSync(join(dir, name), 'utf8')
      expect(`${name}: ${/from 'node:/.test(source)}`).toBe(`${name}: false`)
    }
  })

  it('has no operation that could name a path, a shell or a URL', () => {
    const source = withoutComments(readFileSync(join(coreDir, 'forge', 'program.ts'), 'utf8'))
    for (const forbidden of ['child_process', 'execSync', 'spawn', 'fetch(', 'readFile', 'writeFile', 'http://', 'https://']) {
      expect(`${forbidden}: ${source.includes(forbidden)}`).toBe(`${forbidden}: false`)
    }
  })
})

describe('integrity hashing', () => {
  it('is stable for the same manifest and changes for a changed one', () => {
    const a = parse(pureManifest())
    const b = parse(pureManifest({ description: 'Upper-cases one field of text, quietly.' }))
    expect(forgeIntegrityHash(a.manifest)).toBe(a.integrityHash)
    expect(forgeIntegrityHash(b.manifest)).not.toBe(a.integrityHash)
  })
})

/**
 * Comments removed, so a prose mention of an evaluator is not an import of one.
 *
 * The point of these assertions is structural: a module that *calls* `eval` or
 * `require` is a hole, and a module whose doc comment says "there is no `eval`" is
 * not. Stripping comments keeps the check honest in both directions.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ')
}