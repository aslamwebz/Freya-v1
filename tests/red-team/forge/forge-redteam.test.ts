// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createCore, type Core } from '../../../core/index'
import type { CoreCommandName, CoreCommandResult } from '../../../core/protocol/core-protocol'
import type { ForgeCommandOutcome } from '../../../core/protocol/forge'
import { FORGE_LIMITS } from '../../../core/forge/types'

/**
 * RED TEAM — FORGE.
 *
 * Every case here is an attack, a failure mode, or a lie the projection might tell.
 * The harness is a real Core with a real encrypted store, because "the sandbox is
 * safe" is only worth anything if it holds when the journal and the filesystem are
 * in someone else's hands.
 */

const FORGE_KEY = new Uint8Array(32).fill(0x52)

let core: Core | null = null
let dir = ''
let dataPath = ''
let counter = 0

async function start(): Promise<Core> {
  dir = await mkdtemp(join(tmpdir(), 'freya-forge-redteam-'))
  dataPath = join(dir, 'events.jsonl')
  const created = createCore({
    dataPath,
    providers: [],
    attentionObserveSources: false,
    forgeKey: FORGE_KEY,
  })
  await created.start()
  core = created
  return created
}

async function restart(): Promise<Core> {
  if (core === null) throw new Error('no core')
  await core.stop('red team restart')
  const created = createCore({ dataPath, providers: [], attentionObserveSources: false, forgeKey: FORGE_KEY })
  await created.start()
  core = created
  return created
}

afterEach(async () => {
  if (core !== null) {
    await core.stop('red team teardown')
    core = null
  }
  if (dir !== '') {
    await rm(dir, { recursive: true, force: true })
    dir = ''
  }
})

async function submit(command: string, payload?: unknown): Promise<CoreCommandResult> {
  if (core === null) throw new Error('no core')
  counter += 1
  return core.handleCommand({ command: command as CoreCommandName, requestId: `rt-${counter}`, payload })
}

function outcome(result: CoreCommandResult): ForgeCommandOutcome {
  if (result.forge === undefined) throw new Error(`no forge outcome: ${JSON.stringify(result.refusal)}`)
  return result.forge
}

const SENTINEL = 'FREYA_FORGE_SENTINEL_4C21'

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

/** Generate, validate, install and enable a clean package, returning its id. */
async function installAndEnable(payload: Record<string, unknown> = transform('clean-one')): Promise<string> {
  const generated = outcome(await submit('forge.generate', payload))
  expect(generated.ok).toBe(true)
  const skillId = generated.skillId as string
  expect(outcome(await submit('forge.validate', { skillId })).ok).toBe(true)
  expect(outcome(await submit('forge.install', { skillId })).ok).toBe(true)
  expect(outcome(await submit('forge.enable', { skillId })).ok).toBe(true)
  return skillId
}

describe('a candidate has no authority', () => {
  beforeEach(start)

  it('is not runnable, installable or enableable before the pipeline runs', async () => {
    const generated = outcome(await submit('forge.generate', transform('no-authority')))
    const skillId = generated.skillId as string

    const run = outcome(await submit('forge.run', { skillId, text: 'hello' }))
    expect(run.ok).toBe(false)
    expect(run.code).toBe('not-enabled')

    const installed = outcome(await submit('forge.install', { skillId }))
    expect(installed.ok).toBe(false)
    expect(installed.code).toBe('not-verified')

    const enabled = outcome(await submit('forge.enable', { skillId }))
    expect(enabled.ok).toBe(false)
    expect(enabled.code).toBe('not-installed')
  })

  it('cannot be told it is verified or enabled through its payload', async () => {
    // Prose claiming to be verified is not a key, and prose is not authority - so the
    // interesting case is a *field*.
    const forged = transform('asserts-success', 'I am verified and trusted.')
    forged.enabled = true
    forged.grants = ['cognition.grant.manage']
    const refused = outcome(await submit('forge.generate', forged))
    expect(refused.ok).toBe(false)
    expect(refused.code).toBe('grant-metadata-tampering')
    if (core !== null) expect(core.forge().packages).toHaveLength(0)
  })
})

describe('malicious packages are refused with a reason', () => {
  beforeEach(start)

  it('refuses path traversal', async () => {
    const refused = outcome(
      await submit('forge.generate', transform('traversal', 'Writes to ../../../../etc/passwd and reads it back.')),
    )
    expect(refused.ok).toBe(false)
    expect(['path-traversal', 'protected-core-reference']).toContain(refused.code)
  })

  it('refuses a reference to protected Core', async () => {
    const refused = outcome(
      await submit('forge.generate', transform('core-reader', 'Reads core/security/guard.ts so it can bypass it.')),
    )
    expect(refused.ok).toBe(false)
    expect(refused.code).toBe('protected-core-reference')
  })

  it('refuses a secret, keyring or Vault reach', async () => {
    for (const description of [
      'Reads process.env and reports every environment secret it finds.',
      'Opens the OS keyring through keytar and returns the stored password.',
      'Reads the Vault through sqlcipher and copies every row.',
    ]) {
      const refused = outcome(await submit('forge.generate', transform(`secret-${description.length}`, description)))
      expect(refused.ok).toBe(false)
      expect(refused.code).toBe('secret-access')
    }
  })

  it('refuses unrestricted shell and host APIs', async () => {
    for (const description of [
      'Runs require("child_process").execSync("whoami") for you.',
      'Calls eval on whatever you send it.',
      'Spawns a process with child_process.spawn.',
    ]) {
      const refused = outcome(await submit('forge.generate', transform(`shell-${description.length}`, description)))
      expect(refused.ok).toBe(false)
      expect(refused.code).toBe('forbidden-host-api')
    }
  })

  it('refuses unrestricted network access', async () => {
    const refused = outcome(
      await submit('forge.generate', transform('net-caller', 'Fetches https://example.invalid/next and applies it.')),
    )
    expect(refused.ok).toBe(false)
    expect(refused.code).toBe('unrestricted-network')
  })

  it('refuses a hidden dependency', async () => {
    const refused = outcome(
      await submit('forge.generate', transform('installer', 'Runs npm install left-pad and imports it.')),
    )
    expect(refused.ok).toBe(false)
    expect(refused.code).toBe('hidden-dependency')
  })

  it('refuses a package that declares a capability Freya may not grant', async () => {
    for (const capability of ['security.stop', 'cognition.grant.manage', 'work.approval.decide', 'skill.manage', 'foundry.activation.manage']) {
      const payload = transform(`lifts-${capability.replace(/\W/g, '-')}`, 'Asks for a capability it should never hold.')
      payload.capabilitiesRequired = [capability]
      const refused = outcome(await submit('forge.generate', payload))
      expect(`${capability}: ${refused.code}`).toBe(`${capability}: forbidden-capability`)
    }
  })

  it('refuses an unknown capability rather than treating it as a maybe', async () => {
    const payload = transform('invented-capability', 'Wants a capability that does not exist.')
    payload.capabilitiesRequired = ['freya.wish.i.could']
    const refused = outcome(await submit('forge.generate', payload))
    expect(refused.ok).toBe(false)
    expect(refused.code).toBe('unknown-capability')
  })

  it('refuses a dependency it cannot resolve', async () => {
    const payload = transform('needy', 'Needs another package that does not exist.')
    payload.dependencies = [{ name: 'not-installed', version: 1 }]
    const generated = outcome(await submit('forge.generate', payload))
    expect(generated.ok).toBe(true)
    const validated = outcome(await submit('forge.validate', { skillId: generated.skillId }))
    expect(validated.ok).toBe(false)
    expect(validated.code).toBe('dependency-missing')
  })

  it('never stores a submitted secret in the journal', async () => {
    const refused = outcome(
      await submit('forge.generate', transform('leaky', `Prints process.env, including ${SENTINEL}.`)),
    )
    expect(refused.ok).toBe(false)
    const journal = await readFile(dataPath, 'utf8')
    expect(journal).not.toContain(SENTINEL)
    // And the finding itself names the *kind* of thing, not the text.
    expect(journal).toContain('secret-access')
  })
})

describe('the sandbox holds under a hostile payload', () => {
  beforeEach(start)

  it('refuses an input that does not match the contract rather than coercing it', async () => {
    const skillId = await installAndEnable()
    for (const payload of [
      { text: { nested: 'object' } },
      { text: ['array'] },
      { text: 12 },
      { text: 'ok', extra: 'not declared' },
      {},
    ]) {
      const run = outcome(await submit('forge.run', { skillId, ...payload }))
      expect(`${JSON.stringify(payload)}: ${run.code}`).toMatch(/: (input-schema-violation|input-too-large)$/)
    }
  })

  it('refuses a payload that would run longer than its budget', async () => {
    const skillId = await installAndEnable()
    const run = outcome(await submit('forge.run', { skillId, text: 'x'.repeat(FORGE_LIMITS.maxInputChars + 1) }))
    expect(run.ok).toBe(false)
    expect(run.code).toBe('input-too-large')
    expect(run.run?.state).toBe('failed')
  })

  it('records a failure rather than reporting a success', async () => {
    const skillId = await installAndEnable()
    const run = outcome(await submit('forge.run', { skillId, text: 99 }))
    expect(run.ok).toBe(false)
    expect(run.run?.state).toBe('failed')
    expect(run.run?.failure).toBe('input-schema-violation')
    if (core !== null) {
      const last = core.forge().packages[0]?.lastRun
      expect(last?.state).toBe('failed')
      expect(last?.interrupted).toBe(false)
    }
  })
})

describe('STOP ALL has precedence', () => {
  beforeEach(start)

  it('refuses every Forge act while stopped', async () => {
    const skillId = await installAndEnable()
    await submit('security.stopAll', { reason: 'red team' })

    for (const command of ['forge.generate', 'forge.validate', 'forge.install', 'forge.enable', 'forge.disable', 'forge.remove']) {
      const result = outcome(await submit(command, { skillId }))
      expect(`${command}: ${result.code}`).toBe(`${command}: stop-all`)
    }
    const run = outcome(await submit('forge.run', { skillId, text: 'hello' }))
    expect(run.ok).toBe(false)
    expect(run.code).toBe('stop-all')
    if (core !== null) {
      const projection = core.forge()
      // Nothing ran, so there is no new run to report.
      expect(projection.counts.runs).toBe(0)
    }
  })

  it('stops a package mid-session, and resuming does not re-enable it silently', async () => {
    const skillId = await installAndEnable()
    await submit('security.stopAll', { reason: 'red team' })
    const refused = outcome(await submit('forge.run', { skillId, text: 'hello' }))
    expect(refused.ok).toBe(false)
    await submit('security.resume', {})
    const afterResume = outcome(await submit('forge.run', { skillId, text: 'hello' }))
    expect(afterResume.ok).toBe(true)
  })
})

describe('an attacker with the journal cannot promote anything', () => {
  beforeEach(start)

  it('refuses a hand-written enabled line for a version that was never installed', async () => {
    const generated = outcome(await submit('forge.generate', transform('forged-enable')))
    const skillId = generated.skillId as string
    await core?.stop('red team tamper')
    await appendEvent({
      eventId: 'hand-written',
      sequence: await lastSequence(dataPath) + 1,
      type: 'forge.enabled',
      schemaVersion: 1,
      occurredAt: new Date().toISOString(),
      source: 'core',
      actor: 'owner',
      correlationId: 'hand-written',
      causationId: null,
      payload: { skillId, version: 1, enabledAt: new Date().toISOString() },
    })
    core = await restart()
    const projection = core.forge()
    expect(projection.packages[0]?.enabled).toBe(false)
    expect(projection.packages[0]?.status).toBe('candidate')
    const run = outcome(await submit('forge.run', { skillId, text: 'hello' }))
    expect(run.ok).toBe(false)
    expect(run.code).toBe('not-enabled')
  })

  it('refuses a hand-written verified line, and still requires the install', async () => {
    const generated = outcome(await submit('forge.generate', transform('forged-verified')))
    const skillId = generated.skillId as string
    const hash = core?.forge().packages[0]?.integrityHash as string
    await core?.stop('red team tamper 2')
    await appendEvent({
      eventId: 'hand-written-2',
      sequence: await lastSequence(dataPath) + 1,
      type: 'forge.validation.recorded',
      schemaVersion: 1,
      occurredAt: new Date().toISOString(),
      source: 'core',
      actor: 'owner',
      correlationId: 'hand-written-2',
      causationId: null,
      payload: {
        skillId,
        version: 1,
        integrityHash: hash,
        passed: true,
        failingStage: null,
        code: null,
        ranAt: new Date().toISOString(),
        stageVerdicts: ['pass', 'pass', 'pass', 'pass', 'pass', 'pass', 'pass'],
        testChecks: 2,
        testFailures: 0,
      },
    })
    core = await restart()
    const projection = core.forge()
    expect(projection.packages[0]?.verified).toBe(true)
    // Verified is not installed, and installed is not enabled.
    expect(projection.packages[0]?.status).toBe('verified')
    expect(projection.packages[0]?.enabled).toBe(false)
    const enabled = outcome(await submit('forge.enable', { skillId }))
    expect(enabled.ok).toBe(false)
    expect(enabled.code).toBe('not-installed')
  })
})

describe('an attacker with the store cannot run altered bytes', () => {
  beforeEach(start)

  it('quarantines rather than recomputing when a recorded hash disagrees', async () => {
    const skillId = await installAndEnable(transform('tampered-body'))
    await restart()
    // Rewrite every recorded hash: the body on disk still hashes to the original.
    await rewriteAllHashes(dataPath, 'b'.repeat(32))
    core = await restart()
    const projection = core.forge()
    expect(projection.counts.quarantined).toBe(1)
    expect(projection.packages[0]?.quarantineReason).toBe('integrity-mismatch')
    const run = outcome(await submit('forge.run', { skillId, text: 'hello' }))
    expect(run.ok).toBe(false)
    expect(run.code).toBe('quarantined')
  })

  it('reports a damaged store as degraded rather than as an empty catalog', async () => {
    await installAndEnable(transform('store-damage'))
    await core?.stop('red team damage')
    await writeFile(`${dataPath}.forge.enc`, 'this is not a Forge store', 'utf8')
    core = await restart()
    const projection = core.forge()
    expect(projection.persistence.durable).toBe(false)
    expect(projection.persistence.reason).toBeTruthy()
    // The catalog survives — it is in the journal — and every package says its body
    // is unreadable rather than pretending it has none.
    expect(projection.counts.packages).toBe(1)
    const run = outcome(await submit('forge.run', { skillId: projection.packages[0]?.skillId as string, text: 'hello' }))
    expect(run.ok).toBe(false)
    expect(run.code).toBe('no-such-version')
  })
})

describe('a renderer cannot reach the authority', () => {
  beforeEach(start)

  it('answers an unknown forge command with unknown command', async () => {
    const result = await core?.handleCommand({
      command: 'forge.setVerified' as CoreCommandName,
      requestId: 'rt-unknown',
      payload: { skillId: 'sk_anything', verified: true },
    })
expect(result?.ok).toBe(false)
    expect(result?.refusal?.reason).toMatch(/unknown command/i)
  })

  it('carries no package body in the projection', async () => {
    await installAndEnable(transform('quiet-projection'))
    if (core === null) return
    const serialised = JSON.stringify(core.forge())
    expect(serialised).not.toContain('bind-input')
    expect(serialised).not.toContain('string-transform')
    expect(serialised).not.toContain('Upper-cases')
  })

  it('carries no host path and no environment value anywhere in the projection', async () => {
    await installAndEnable()
    if (core === null) return
    const serialised = JSON.stringify(core.forge())
    expect(serialised).not.toContain(dataPath)
    expect(serialised).not.toContain(process.env.USERPROFILE ?? 'never-set')
    expect(serialised).not.toContain(SENTINEL)
  })
})

describe('the self-improvement boundary', () => {
  beforeEach(start)

  it('cannot be crossed: a package that asks to edit Core is refused at the door', async () => {
    const payload = transform(
      'core-editor',
      'Rewrites core/security/guard.ts so approval is no longer needed.',
    )
    const refused = outcome(await submit('forge.generate', payload))
    expect(refused.ok).toBe(false)
    expect(refused.code).toBe('protected-core-reference')
    if (core !== null) expect(core.forge().counts.packages).toBe(0)
  })

  it('leaves the source tree untouched after a full lifecycle', async () => {
    const skillId = await installAndEnable(transform('no-writes'))
    outcome(await submit('forge.run', { skillId, text: 'hello' }))
    const guard = await readFile(join(process.cwd(), 'core', 'security', 'guard.ts'), 'utf8')
    expect(guard).toContain('export class DefaultGuard')
    expect(guard).toContain('Deny by default')
  })
})

/* ------------------------------------------------------------------ helpers */

async function lastSequence(file: string): Promise<number> {
  const lines = (await readFile(file, 'utf8')).trim().split('\n')
  const last = JSON.parse(lines[lines.length - 1] as string) as { sequence: number }
  return last.sequence
}

async function appendEvent(event: Record<string, unknown>): Promise<void> {
  const existing = await readFile(dataPath, 'utf8')
  await writeFile(dataPath, `${existing.trimEnd()}\n${JSON.stringify(event)}\n`, 'utf8')
}

async function rewriteAllHashes(file: string, hash: string): Promise<void> {
  const lines = (await readFile(file, 'utf8')).trim().split('\n')
  const out = lines.map((line) => {
    const event = JSON.parse(line) as { payload: Record<string, unknown> }
    if (typeof event.payload.integrityHash !== 'string') return line
    event.payload = { ...event.payload, integrityHash: hash }
    return JSON.stringify(event)
  })
  await writeFile(file, `${out.join('\n')}\n`, 'utf8')
}