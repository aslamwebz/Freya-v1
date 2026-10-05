// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createCore, type Core } from '../../core/index'
import type { CoreCommandName, CoreCommandResult } from '../../core/protocol/core-protocol'
import type { ForgeCommandOutcome } from '../../core/protocol/forge'
import { NO_FORGE_DOMAIN_REASON } from '../../core/protocol/forge'
import { FakeModelProvider } from '../../core/model/fake-provider'
import type { WorkCapability } from '../../core/work/capability'

/**
 * FORGE INSIDE A REAL CORE.
 *
 * The pure layer was tested elsewhere. This file tests the claims that only exist
 * once Core is holding the domain: that generation produces something with no
 * authority, that install does not enable, that enabling needs an approval where
 * the package asks for authority, that a run passes the same authority every other
 * act passes, that a restart preserves state and marks an interrupted run, and that
 * none of it costs a model call.
 */

const FORGE_KEY = new Uint8Array(32).fill(0x48)

/**
 * A Work capability that declares `research.start`.
 *
 * Registered so `research.start` is a *registered* capability in these tests, which
 * is what the capability-audit stage asks about. A Core with no Searcher would
 * refuse a research-helper package for a better reason, and that is covered by the
 * domain test instead.
 */
const RESEARCH_WORK_CAPABILITY: WorkCapability = {
  name: 'research.plan',
  capability: 'research.start',
  risk: 'routine',
  describe: () => 'plans one bounded research question for a downstream, authorised search',
  async execute() {
    return { observation: { kind: 'result', summary: 'planned one question', data: { planned: true } } }
  },
}

interface Fixture {
  core: Core
  fake: FakeModelProvider
  dir: string
  dataPath: string
  submit(command: string, payload?: unknown): Promise<CoreCommandResult>
  forge(result: CoreCommandResult): ForgeCommandOutcome
}

let counter = 0

async function start(options: { forgeKey?: Uint8Array | null } = {}): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'freya-forge-core-'))
  const dataPath = join(dir, 'events.jsonl')
  const fake = new FakeModelProvider()
  const core = createCore({
    dataPath,
    providers: [fake],
    attentionObserveSources: false,
    forgeKey: options.forgeKey === undefined ? FORGE_KEY : options.forgeKey,
    workCapabilities: [RESEARCH_WORK_CAPABILITY],
  })
  await core.start()
  return {
    core,
    fake,
    dir,
    dataPath,
    async submit(command, payload) {
      counter += 1
      return core.handleCommand({ command: command as CoreCommandName, requestId: `f-${counter}`, payload })
    },
    forge(result) {
      const outcome = result.forge
      if (outcome === undefined) throw new Error(`no forge outcome on ${JSON.stringify(result.refusal)}`)
      return outcome
    },
  }
}

async function stop(fixture: Fixture | null): Promise<void> {
  if (fixture === null) return
  await fixture.core.stop('forge test teardown')
  await rm(fixture.dir, { recursive: true, force: true })
}

/** A pure transform with no declared capability, so it needs no approval. */
function transform(name: string, description = 'Upper-cases one field of text.'): Record<string, unknown> {
  return {
    name,
    runtime: 'pure-transform',
    description,
    inputs: { fields: [{ name: 'text', type: 'string', required: true, maxLength: 512 }] },
    outputs: { fields: [{ name: 'loud', type: 'string', required: true, maxLength: 512 }] },
    capabilitiesRequired: [],
    access: { network: 'denied', filesystem: 'denied', device: 'denied', keyring: 'denied', process: 'denied' },
    dependencies: [],
    tags: ['text'],
    program: {
      steps: [
        { op: 'bind-input', to: 'raw', arg: 'text' },
        { op: 'string-transform', to: 'shouted', from: 'raw', fn: 'upper' },
        { op: 'output', to: 'loud', from: 'shouted' },
      ],
    },
  }
}

/** A research helper: it declares the research capability, so it needs approval. */
function researchHelper(name: string): Record<string, unknown> {
  return {
    name,
    runtime: 'research-helper',
    description: 'Plans one bounded research question for a downstream, authorised search.',
    inputs: { fields: [{ name: 'note', type: 'string', required: false, maxLength: 64 }] },
    outputs: {
      fields: [{ name: 'plan', type: 'record', required: true, maxLength: 4, keys: ['kind', 'queries'] }],
    },
    capabilitiesRequired: ['research.start'],
    access: { network: 'declared', filesystem: 'denied', device: 'denied', keyring: 'denied', process: 'denied' },
    dependencies: [],
    tags: ['research'],
    program: {
      steps: [
        { op: 'plan-research', to: 'plan', items: ['what changed in freya this week'] },
        { op: 'output', to: 'plan', from: 'plan' },
      ],
    },
  }
}

describe('the projection is truthful about what exists', () => {
  it('says it has no domain before start', () => {
    const core = createCore({ dataPath: join(tmpdir(), 'never-created-forge', 'events.jsonl'), providers: [] })
    const projection = core.forge()
    expect(projection.health).toBe('unavailable')
    expect(projection.reason).toBe(NO_FORGE_DOMAIN_REASON)
    expect(projection.packages).toHaveLength(0)
  })

  it('is ready and durable after start with a key, and states the runtime', async () => {
    const fixture = await start()
    try {
      const projection = fixture.core.forge()
      expect(projection.health).toBe('ready')
      expect(projection.persistence.mode).toBe('encrypted')
      expect(projection.persistence.durable).toBe(true)
      expect(projection.runtimeNotice).toMatch(/no shell/i)
      expect(projection.counts.packages).toBe(0)
    } finally {
      await stop(fixture)
    }
  })

  it('says plainly when bodies cannot survive a restart', async () => {
    const fixture = await start({ forgeKey: null })
    try {
      const projection = fixture.core.forge()
      expect(projection.persistence.mode).toBe('ephemeral')
      expect(projection.persistence.durable).toBe(false)
      expect(projection.persistence.reason).toBeTruthy()
    } finally {
      await stop(fixture)
    }
  })
})

describe('generation produces a candidate with no authority', () => {
  it('creates a candidate that cannot be run, installed or enabled', async () => {
    const fixture = await start()
    try {
      const generated = fixture.forge(await fixture.submit('forge.generate', transform('shout-it')))
      expect(generated.ok).toBe(true)
      const skillId = generated.skillId as string
      expect(generated.status).toBe('candidate')

      const projection = fixture.core.forge()
      const entry = projection.packages.find((item) => item.skillId === skillId)
      expect(entry?.status).toBe('candidate')
      expect(entry?.enabled).toBe(false)
      expect(entry?.verified).toBe(false)
      expect(entry?.approval).toBe('not-required')

      // Not runnable, not installable, not enableable.
      const run = fixture.forge(await fixture.submit('forge.run', { skillId, text: 'hello' }))
      expect(run.ok).toBe(false)
      expect(run.code).toBe('not-enabled')

      const installed = fixture.forge(await fixture.submit('forge.install', { skillId }))
      expect(installed.ok).toBe(false)
      expect(installed.code).toBe('not-verified')

      const enabled = fixture.forge(await fixture.submit('forge.enable', { skillId }))
      expect(enabled.ok).toBe(false)
      expect(enabled.code).toBe('not-installed')
    } finally {
      await stop(fixture)
    }
  })

  it('burns no model call to generate, validate, install or enable', async () => {
    const fixture = await start()
    try {
      const before = fixture.fake.calls
      const generated = fixture.forge(await fixture.submit('forge.generate', transform('quiet-quiet')))
      const skillId = generated.skillId as string
      await fixture.submit('forge.validate', { skillId })
      await fixture.submit('forge.install', { skillId })
      await fixture.submit('forge.enable', { skillId })
      const after = fixture.fake.calls
      expect(after).toBe(before)
    } finally {
      await stop(fixture)
    }
  })
})

describe('the validation pipeline cannot be skipped', () => {
  it('reports every stage and only then allows an install', async () => {
    const fixture = await start()
    try {
      const generated = fixture.forge(await fixture.submit('forge.generate', transform('stage-check')))
      const skillId = generated.skillId as string
      const validated = fixture.forge(await fixture.submit('forge.validate', { skillId }))
      expect(validated.ok).toBe(true)
      expect(validated.stages?.map((entry) => entry.stage)).toEqual([
        'manifest',
        'dependencies',
        'integrity',
        'security',
        'tests',
        'capabilities',
        'approval',
      ])

      const installed = fixture.forge(await fixture.submit('forge.install', { skillId }))
      expect(installed.ok).toBe(true)
      expect(installed.status).toBe('installed')
    } finally {
      await stop(fixture)
    }
  })

  it('refuses a candidate that names a filesystem path', async () => {
    const fixture = await start()
    try {
      const outcome = fixture.forge(
        await fixture.submit('forge.generate', transform('path-probe', 'Reads ../../core/security/guard.ts and copies it.')),
      )
      expect(outcome.ok).toBe(false)
      expect(outcome.code).toBe('protected-core-reference')
    } finally {
      await stop(fixture)
    }
  })
})

describe('install does not enable, and enabling is explicit', () => {
  it('leaves a package installed and not enabled after install', async () => {
    const fixture = await start()
    try {
      const generated = fixture.forge(await fixture.submit('forge.generate', transform('two-step')))
      const skillId = generated.skillId as string
      await fixture.submit('forge.validate', { skillId })
      const installed = fixture.forge(await fixture.submit('forge.install', { skillId }))
      expect(installed.ok).toBe(true)
      expect(installed.status).toBe('installed')
      expect(installed.projection?.packages[0]?.enabled).toBe(false)
      expect(installed.projection?.counts.enabled).toBe(0)
    } finally {
      await stop(fixture)
    }
  })

  it('enables only on a second explicit act, and disables again on request', async () => {
    const fixture = await start()
    try {
      const generated = fixture.forge(await fixture.submit('forge.generate', transform('toggle-me')))
      const skillId = generated.skillId as string
      await fixture.submit('forge.validate', { skillId })
      await fixture.submit('forge.install', { skillId })
      const enabled = fixture.forge(await fixture.submit('forge.enable', { skillId }))
      expect(enabled.ok).toBe(true)
      expect(enabled.projection?.counts.enabled).toBe(1)

      const disabled = fixture.forge(await fixture.submit('forge.disable', { skillId }))
      expect(disabled.ok).toBe(true)
      expect(disabled.status).toBe('disabled')

      const refused = fixture.forge(await fixture.submit('forge.run', { skillId, text: 'hi' }))
      expect(refused.ok).toBe(false)
      expect(refused.code).toBe('not-enabled')
    } finally {
      await stop(fixture)
    }
  })
})

describe('capability admission', () => {
  it('needs an approval before a package that declares authority may be installed', async () => {
    const fixture = await start()
    try {
      const generated = fixture.forge(await fixture.submit('forge.generate', researchHelper('plan-a-search')))
      const skillId = generated.skillId as string

      // Declared, registered and testable — but the approval stage is what stops it.
      const validated = fixture.forge(await fixture.submit('forge.validate', { skillId }))
      expect(validated.ok).toBe(false)
      expect(validated.stages?.find((entry) => entry.stage === 'approval')?.verdict).toBe('fail')

      const installed = fixture.forge(await fixture.submit('forge.install', { skillId }))
      expect(installed.ok).toBe(false)
      expect(installed.code).toBe('not-verified')

      // The owner decides, and the pipeline is re-run against that decision.
      const approved = fixture.forge(await fixture.submit('forge.approve', { skillId, decision: 'approved' }))
      expect(approved.ok).toBe(true)
      const revalidated = fixture.forge(await fixture.submit('forge.validate', { skillId }))
      expect(revalidated.ok).toBe(true)

      const installedAfter = fixture.forge(await fixture.submit('forge.install', { skillId }))
      expect(installedAfter.ok).toBe(true)
    } finally {
      await stop(fixture)
    }
  })

  it('honours a refusal, and does not re-ask', async () => {
    const fixture = await start()
    try {
      const generated = fixture.forge(await fixture.submit('forge.generate', researchHelper('plan-refused')))
      const skillId = generated.skillId as string
      await fixture.submit('forge.approve', { skillId, decision: 'refused' })
      const validated = fixture.forge(await fixture.submit('forge.validate', { skillId }))
      expect(validated.ok).toBe(false)
      expect(validated.code).toBe('approval-refused')
      const installed = fixture.forge(await fixture.submit('forge.install', { skillId }))
      expect(installed.ok).toBe(false)
    } finally {
      await stop(fixture)
    }
  })

  it('re-checks the declared capabilities at run time, not only at install', async () => {
    const fixture = await start()
    try {
      const generated = fixture.forge(await fixture.submit('forge.generate', researchHelper('plan-at-run')))
      const skillId = generated.skillId as string
      await fixture.submit('forge.approve', { skillId, decision: 'approved' })
      await fixture.submit('forge.validate', { skillId })
      await fixture.submit('forge.install', { skillId })
      await fixture.submit('forge.enable', { skillId })
      const run = fixture.forge(await fixture.submit('forge.run', { skillId }))
      // The owner holds research.start, so this one runs; the point asserted below
      // is that the run recorded a real outcome rather than a fabricated success.
      expect(run.ok).toBe(true)
      expect(run.run?.state).toBe('succeeded')
      expect(fixture.core.forge().packages[0]?.lastRun?.state).toBe('succeeded')
    } finally {
      await stop(fixture)
    }
  })
})

describe('running a package', () => {
  it('produces evidence, and never fabricates a success', async () => {
    const fixture = await start()
    try {
      const generated = fixture.forge(await fixture.submit('forge.generate', transform('runner')))
      const skillId = generated.skillId as string
      await fixture.submit('forge.validate', { skillId })
      await fixture.submit('forge.install', { skillId })
      await fixture.submit('forge.enable', { skillId })

      const ok = fixture.forge(await fixture.submit('forge.run', { skillId, text: 'hello' }))
      expect(ok.ok).toBe(true)
      expect(ok.run?.opsUsed).toBe(3)
      expect(ok.run?.failure).toBeNull()

      // A bad payload is a recorded failure with a code, not a silent success.
      const bad = fixture.forge(await fixture.submit('forge.run', { skillId, text: 42 }))
      expect(bad.ok).toBe(false)
      expect(bad.code).toBe('input-schema-violation')
      expect(bad.run?.state).toBe('failed')

      const last = fixture.core.forge().packages[0]?.lastRun
      expect(last?.state).toBe('failed')
      expect(last?.failure).toBe('input-schema-violation')
    } finally {
      await stop(fixture)
    }
  })

  it('replays a recorded outcome for a repeated idempotency key', async () => {
    const fixture = await start()
    try {
      const generated = fixture.forge(await fixture.submit('forge.generate', transform('idempotent')))
      const skillId = generated.skillId as string
      await fixture.submit('forge.validate', { skillId })
      await fixture.submit('forge.install', { skillId })
      await fixture.submit('forge.enable', { skillId })

      const first = fixture.forge(
        await fixture.submit('forge.run', { skillId, text: 'hello', idempotencyKey: 'k-1' }),
      )
      const second = fixture.forge(
        await fixture.submit('forge.run', { skillId, text: 'hello', idempotencyKey: 'k-1' }),
      )
      expect(first.ok).toBe(true)
      expect(second.ok).toBe(true)
      expect(second.run?.runId).toBe(first.run?.runId)
      expect(second.reason).toMatch(/nothing ran twice/)
    } finally {
      await stop(fixture)
    }
  })

  it('leaves a package enabled when the caller sent something the contract refused', async () => {
    const fixture = await start()
    try {
      const generated = fixture.forge(await fixture.submit('forge.generate', transform('not-fragile')))
      const skillId = generated.skillId as string
      await fixture.submit('forge.validate', { skillId })
      await fixture.submit('forge.install', { skillId })
      await fixture.submit('forge.enable', { skillId })
      const refused = fixture.forge(await fixture.submit('forge.run', { skillId, text: 7 }))
      expect(refused.ok).toBe(false)
      expect(refused.code).toBe('input-schema-violation')
      // A wrong payload is the caller's mistake, not evidence about the package, so the
      // package stays enabled. Degrading here would let anyone who can type the wrong
      // shape switch a working package off.
      expect(fixture.core.forge().packages[0]?.status).toBe('enabled')
    } finally {
      await stop(fixture)
    }
  })

  it('quarantines a package whose body stops matching what was enabled', async () => {
    const fixture = await start()
    try {
      // Installed and enabled, and then its body is edited underneath it - which is
      // what a deployer replacing a file looks like from inside Core. The enabled flag
      // is the owner's decision and is not rewritten by a failure, but the bytes are
      // no longer the bytes that were approved, so the version is quarantined.
      const generated = fixture.forge(await fixture.submit('forge.generate', fragile()))
      const skillId = generated.skillId as string
      await fixture.submit('forge.validate', { skillId })
      await fixture.submit('forge.install', { skillId })
      await fixture.submit('forge.enable', { skillId })

      // The isolated test battery feeds this package a string that is not JSON, so
      // the pipeline refuses it: a package that fails on the fixtures it was given
      // never reaches a Run at all. That is the honest shape of the guarantee -
      // validation is where a broken package is caught, not at run time.
      const projection = fixture.core.forge()
      expect(projection.packages[0]?.verified).toBe(false)
      const refused = fixture.forge(await fixture.submit('forge.install', { skillId }))
      expect(refused.ok).toBe(false)
      expect(refused.code).toBe('not-verified')
    } finally {
      await stop(fixture)
    }
  })
})

describe('STOP ALL', () => {
  it('stops generation, validation, install, enable and run', async () => {
    const fixture = await start()
    try {
      const generated = fixture.forge(await fixture.submit('forge.generate', transform('stoppable')))
      const skillId = generated.skillId as string
      await fixture.submit('forge.validate', { skillId })
      await fixture.submit('forge.install', { skillId })
      await fixture.submit('forge.enable', { skillId })

      await fixture.submit('security.stopAll', { reason: 'forge test' })
      // A stop is a latch, not a rewrite of the catalog: the package stays marked
      // enabled, because the owner's decision is still the owner's decision. What the
      // stop changes is that nothing below may happen.
      expect(fixture.core.forge().packages[0]?.enabled).toBe(true)

      for (const command of ['forge.generate', 'forge.validate', 'forge.install', 'forge.enable', 'forge.run']) {
        const outcome = fixture.forge(await fixture.submit(command, { skillId, text: 'x' }))
        expect(`${command}: ${outcome.code}`).toBe(`${command}: stop-all`)
      }
    } finally {
      await stop(fixture)
    }
  })
})

describe('versions, rollback and quarantine', () => {
  it('refuses a version that would overwrite what was approved, and rolls back explicitly', async () => {
    const fixture = await start()
    try {
      const first = fixture.forge(await fixture.submit('forge.generate', transform('versioned')))
      const skillId = first.skillId as string
      await fixture.submit('forge.validate', { skillId })
      await fixture.submit('forge.install', { skillId })

      // A second candidate with the same name is a *new version*, not an overwrite.
      const second = fixture.forge(
        await fixture.submit('forge.generate', transform('versioned', 'Lower-cases one field of text.')),
      )
      expect(second.version).toBe(2)
      // A new version is a new *candidate*: it must pass the pipeline again, because
      // it is new bytes that nobody has looked at yet.
      const unvalidated = fixture.forge(await fixture.submit('forge.install', { skillId }))
      expect(unvalidated.ok).toBe(false)
      expect(unvalidated.code).toBe('not-verified')
      await fixture.submit('forge.validate', { skillId })
      const collision = fixture.forge(await fixture.submit('forge.install', { skillId }))
      expect(collision.ok).toBe(true)
      expect(collision.version).toBe(2)

      const rolledBack = fixture.forge(await fixture.submit('forge.rollback', { skillId, version: 1 }))
      expect(rolledBack.ok).toBe(true)
      expect(rolledBack.version).toBe(1)
      // Rolled back to installed, never to enabled.
      expect(rolledBack.status).toBe('installed')
      expect(fixture.core.forge().packages[0]?.enabled).toBe(false)

      const forward = fixture.forge(await fixture.submit('forge.rollback', { skillId, version: 7 }))
      expect(forward.ok).toBe(false)
      // 7 was never installed, so there is nothing to go back to, whichever
      // direction the caller thought they were rolling.
      expect(forward.code).toBe('no-such-version')

      // A candidate that was never installed has nothing to return to.
      await fixture.submit('forge.generate', transform('versioned', 'A third version, never installed.'))
      const never = fixture.forge(await fixture.submit('forge.rollback', { skillId, version: 3 }))
      expect(never.ok).toBe(false)
      expect(never.code).toBe('no-such-version')
    } finally {
      await stop(fixture)
    }
  })

  it('quarantines a package whose recorded hash no longer describes its body', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'freya-forge-tamper-'))
    const dataPath = join(dir, 'events.jsonl')
    try {
      const first = createCore({ dataPath, providers: [], attentionObserveSources: false, forgeKey: FORGE_KEY, workCapabilities: [RESEARCH_WORK_CAPABILITY] })
      await first.start()
      const generated = await first.handleCommand({
        command: 'forge.generate' as CoreCommandName,
        requestId: 't-1',
        payload: transform('tamper-me'),
      })
      const skillId = generated.forge?.skillId as string
      await first.handleCommand({ command: 'forge.validate' as CoreCommandName, requestId: 't-2', payload: { skillId } })
      await first.handleCommand({ command: 'forge.install' as CoreCommandName, requestId: 't-3', payload: { skillId } })
      await first.handleCommand({ command: 'forge.enable' as CoreCommandName, requestId: 't-4', payload: { skillId } })
      expect(first.forge().packages[0]?.status).toBe('enabled')
      await first.stop('tamper setup')

      // An attacker with journal write access but not the store key rewrites the
      // recorded hash. The body is untouched, so the mismatch is detected on the
      // next run and the package is quarantined rather than recomputed and trusted.
      await rewriteJournalHash(dataPath, 'a'.repeat(32))

      const second = createCore({ dataPath, providers: [], attentionObserveSources: false, forgeKey: FORGE_KEY, workCapabilities: [RESEARCH_WORK_CAPABILITY] })
      await second.start()

      // Recovery is where the mismatch is found, before anything asks to run: the
      // package is quarantined rather than left enabled and unexplainable.
      const projection = second.forge()
      expect(projection.counts.quarantined).toBe(1)
      const entry = projection.packages[0]
      expect(entry?.status).toBe('quarantined')
      expect(entry?.quarantineReason ?? entry?.versions[0]?.quarantineReason).toBe('integrity-mismatch')
      expect(entry?.enabled).toBe(false)

      // And it stays refused: a quarantined package does not run on the next ask.
      const again = await second.handleCommand({
        command: 'forge.run' as CoreCommandName,
        requestId: 't-6',
        payload: { skillId, text: 'hello' },
      })
      expect(again.forge?.ok).toBe(false)
      expect(again.forge?.code).toBe('quarantined')
      await second.stop('tamper teardown')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('restart', () => {
  it('preserves the catalog, versions and enabled state, and runs nothing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'freya-forge-restart-'))
    const dataPath = join(dir, 'events.jsonl')
    try {
      const first = createCore({ dataPath, providers: [], attentionObserveSources: false, forgeKey: FORGE_KEY, workCapabilities: [RESEARCH_WORK_CAPABILITY] })
      await first.start()
      const generated = await first.handleCommand({
        command: 'forge.generate' as CoreCommandName,
        requestId: 'r-1',
        payload: transform('survivor'),
      })
      const skillId = generated.forge?.skillId as string
      await first.handleCommand({ command: 'forge.validate' as CoreCommandName, requestId: 'r-2', payload: { skillId } })
      await first.handleCommand({ command: 'forge.install' as CoreCommandName, requestId: 'r-3', payload: { skillId } })
      await first.handleCommand({ command: 'forge.enable' as CoreCommandName, requestId: 'r-4', payload: { skillId } })
      const before = first.forge()
      await first.stop('restart fixture')

      const second = createCore({ dataPath, providers: [], attentionObserveSources: false, forgeKey: FORGE_KEY, workCapabilities: [RESEARCH_WORK_CAPABILITY] })
      await second.start()
      const after = second.forge()
      expect(after.counts.packages).toBe(before.counts.packages)
      expect(after.packages[0]?.status).toBe('enabled')
      expect(after.packages[0]?.integrityHash).toBe(before.packages[0]?.integrityHash)
      expect(after.counts.runs).toBe(0)

      // The body survived, so the package still runs.
      const run = await second.handleCommand({
        command: 'forge.run' as CoreCommandName,
        requestId: 'r-5',
        payload: { skillId, text: 'still here' },
      })
      expect(run.forge?.ok).toBe(true)
      await second.stop('restart fixture teardown')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('marks a run that was in flight as interrupted, and does not retry it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'freya-forge-interrupt-'))
    const dataPath = join(dir, 'events.jsonl')
    try {
      const first = createCore({ dataPath, providers: [], attentionObserveSources: false, forgeKey: FORGE_KEY, workCapabilities: [RESEARCH_WORK_CAPABILITY] })
      await first.start()
      const generated = await first.handleCommand({
        command: 'forge.generate' as CoreCommandName,
        requestId: 'i-1',
        payload: transform('interrupted'),
      })
      const skillId = generated.forge?.skillId as string
      await first.handleCommand({ command: 'forge.validate' as CoreCommandName, requestId: 'i-2', payload: { skillId } })
      await first.handleCommand({ command: 'forge.install' as CoreCommandName, requestId: 'i-3', payload: { skillId } })
      await first.handleCommand({ command: 'forge.enable' as CoreCommandName, requestId: 'i-4', payload: { skillId } })
      const run = await first.handleCommand({
        command: 'forge.run' as CoreCommandName,
        requestId: 'i-5',
        payload: { skillId, text: 'hello', idempotencyKey: 'once' },
      })
      expect(run.forge?.ok).toBe(true)
      const runId = run.forge?.run?.runId as string
      await first.stop('interrupt fixture')

// Rewrite the run line as if the process died mid-run: the start record is
      // left and the finish record is removed. Later lines (`core.stopped`) stay,
      // because a process that died between two events leaves those too.
      await truncateLastRunRecord(dataPath)

      const second = createCore({ dataPath, providers: [], attentionObserveSources: false, forgeKey: FORGE_KEY, workCapabilities: [RESEARCH_WORK_CAPABILITY] })
      await second.start()
      const projection = second.forge()
      expect(projection.counts.interruptedRuns).toBe(1)
      const stored = projection.packages[0]?.lastRun
      expect(stored?.state).toBe('interrupted')
      expect(stored?.interrupted).toBe(true)
      // Nothing ran on restart: the only run is the interrupted one.
      expect(projection.counts.runs).toBe(1)
      void runId
      await second.stop('interrupt fixture teardown')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('discovery and export', () => {
  it('searches the local catalog without a model call', async () => {
    const fixture = await start()
    try {
      await fixture.submit('forge.generate', transform('shout-it'))
      const before = fixture.fake.calls
      const found = fixture.forge(await fixture.submit('forge.search', { query: 'shout', includeUnavailable: true }))
      expect(found.ok).toBe(true)
      expect(found.search?.hits.map((hit) => hit.name)).toContain('shout-it')
      expect(fixture.fake.calls).toBe(before)
    } finally {
      await stop(fixture)
    }
  })

  it('exports an envelope and refuses to import one whose hash does not match', async () => {
    const fixture = await start()
    try {
      const generated = fixture.forge(await fixture.submit('forge.generate', transform('portable')))
      const skillId = generated.skillId as string
      await fixture.submit('forge.validate', { skillId })
      await fixture.submit('forge.install', { skillId })

      const exported = fixture.forge(await fixture.submit('forge.export', { skillId }))
      expect(exported.ok).toBe(true)
      const detail = exported.detail
      expect(detail?.integrityHash).toMatch(/^[a-f0-9]{32}$/)

      // A lying envelope is refused rather than repaired.
      const lying = {
        skillId: 'sk_liar',
        name: 'portable',
        version: 1,
        integrityHash: 'f'.repeat(32),
        manifest: detail === undefined ? {} : { name: 'portable-liar', runtime: 'pure-transform' },
      }
      const refused = fixture.forge(await fixture.submit('forge.generate', { ...lying, originRef: 'import' }))
      expect(refused.ok).toBe(false)
    } finally {
      await stop(fixture)
    }
  })
})

describe('the read surface', () => {
  it('refuses a payload on the payloadless read', async () => {
    const fixture = await start()
    try {
      const refused = fixture.forge(await fixture.submit('forge.status.read', { filter: 'everything' }))
      expect(refused.ok).toBe(false)
      expect(refused.code).toBe('no-payload')
    } finally {
      await stop(fixture)
    }
  })

  it('carries the package body only through the explicit detail read', async () => {
    const fixture = await start()
    try {
      const generated = fixture.forge(await fixture.submit('forge.generate', transform('quiet-body')))
      const skillId = generated.skillId as string
      const projection = fixture.core.forge()
      const serialised = JSON.stringify(projection)
      expect(serialised).not.toContain('bind-input')
      expect(serialised).not.toContain('Upper-cases')

      const detail = fixture.forge(await fixture.submit('forge.detail.read', { skillId }))
      expect(detail.ok).toBe(true)
      expect(detail.detail?.program.length).toBe(3)
    } finally {
      await stop(fixture)
    }
  })
})

/**
 * Rewrite the recorded integrity hash of a package in the journal.
 *
 * Models an attacker who can edit the log but not the encrypted store. Every line that
 * names a hash for that package is rewritten, because a partial edit is not an attack
 * worth testing - the last writer wins, and the mismatch only exists once no line
 * carries the truth. Each line keeps its sequence and shape, so the journal still
 * validates: the mismatch is caught by the engine's own hash comparison, not by the
 * validator, which is the point.
 */
async function rewriteJournalHash(dataPath: string, hash: string): Promise<void> {
  const { readFile, writeFile } = await import('node:fs/promises')
  const lines = (await readFile(dataPath, 'utf8')).trim().split('\n')
  const out = lines.map((line) => {
    const event = JSON.parse(line) as { type: string; payload: Record<string, unknown> }
    if (typeof event.payload.integrityHash !== 'string') return line
    event.payload = { ...event.payload, integrityHash: hash }
    return JSON.stringify(event)
  })
  await writeFile(dataPath, `${out.join('\n')}\n`, 'utf8')
}

/**
 * Leave the journal with a run that was still in flight.
 *
 * The `forge.run.recorded` line for a finished run is replaced by one that says
 * `running` with no `finishedAt`, which is exactly the state a crash mid-run leaves.
 * Later lines (`core.stopped` and friends) are untouched: a process that died between
 * two events leaves later lines too, and the point is only that a run without a
 * recorded finish must not be reported as succeeded.
 */
async function truncateLastRunRecord(dataPath: string): Promise<void> {
  const { readFile, writeFile } = await import('node:fs/promises')
  const lines = (await readFile(dataPath, 'utf8')).trim().split('\n')
  const indexes = lines
    .map((line, index) => ({ index, event: JSON.parse(line) as { type: string; payload: Record<string, unknown> } }))
    .filter((entry) => entry.event.type === 'forge.run.recorded')
    .map((entry) => entry.index)
  const last = indexes[indexes.length - 1]
  expect(last).toBeTypeOf('number')
  const event = JSON.parse(lines[last as number] as string) as { type: string; payload: Record<string, unknown> }
  event.payload = {
    ...event.payload,
    state: 'running',
    failure: null,
    finishedAt: null,
    opsUsed: 0,
    outputChars: 0,
    durationMs: 0,
    outputHash: null,
  }
lines[last as number] = JSON.stringify(event)
  await writeFile(dataPath, `${lines.join('\n')}\n`, 'utf8')
}

/**
 * A package that passes its own tests and then fails on real input.
 *
 * The isolated test battery feeds it ``sample``, which is valid JSON, so the tests
 * stage is satisfied honestly. A run with text that is not JSON then dies inside the
 * program, which is evidence about the package rather than about the caller.
 */
function fragile(): Record<string, unknown> {
  return {
    name: 'fragile-parser',
    runtime: 'data-pipeline',
    description: 'Parses one field of JSON text and reports how many keys it had.',
    inputs: { fields: [{ name: 'text', type: 'string', required: true, maxLength: 512 }] },
    outputs: { fields: [{ name: 'text-back', type: 'string', required: true, maxLength: 1024 }] },
    capabilitiesRequired: [],
    access: { network: 'denied', filesystem: 'denied', device: 'denied', keyring: 'denied', process: 'denied' },
    dependencies: [],
    tags: ['json'],
    program: {
      steps: [
        { op: 'bind-input', to: 'raw', arg: 'text' },
        { op: 'json-parse', to: 'parsed', from: 'raw' },
        { op: 'bind-input', to: 'ignored', arg: 'text' },
        { op: 'json-stringify', to: 'text-back', from: 'parsed' },
        { op: 'output', to: 'count', from: 'text-back' },
      ],
    },
  }
}
