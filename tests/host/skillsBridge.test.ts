// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ElectronCoreHost } from '../../electron/coreHost'
import type { SkillProjection } from '../../core/protocol/skills'

/**
 * The Skills lane across the host and the preload bridge.
 *
 * The host half tests what is mirrored and what crosses the process boundary. The
 * bridge half reads the bridge's own source to prove that the authority it does
 * **not** expose is absent from the code rather than merely unused by the tests — the
 * distinction that matters for "there is no `skill.execute` anywhere".
 */

const SKILL_KEY = new Uint8Array(32).fill(0x61)

let dir = ''
let host: ElectronCoreHost | null = null

function procedure(name: string): Record<string, unknown> {
  return {
    name,
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
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'freya-skills-host-'))
  host = new ElectronCoreHost(join(dir, 'core-events.jsonl'), {}, {
    attentionObserveSources: false,
    skillKey: SKILL_KEY,
  })
})

afterEach(async () => {
  await host?.stop('test-teardown')
  host = null
  await rm(dir, { recursive: true, force: true })
})

describe('the Skills mirror belongs to the process, not the window', () => {
  it('reports nothing before Core has started', () => {
    expect(host!.skills()).toBeNull()
    const seen: SkillProjection[] = []
    host!.onSkills((projection) => seen.push(projection))
    expect(seen).toHaveLength(0)
  })

  it('pushes a ready projection the moment a window attaches', async () => {
    await host!.start()
    const seen: SkillProjection[] = []
    const dispose = host!.onSkills((projection) => seen.push(projection))
    expect(seen).toHaveLength(1)
    expect(seen[0]?.health).toBe('ready')
    expect(seen[0]?.counts.retained).toBe(0)
    expect(seen[0]?.persistence.durable).toBe(true)
    dispose()
  })

  it('mirrors an admission through the command surface', async () => {
    await host!.start()
    const seen: SkillProjection[] = []
    host!.onSkills((projection) => seen.push(projection))

    const result = await host!.submit({
      command: 'skill.admit',
      requestId: 'r1',
      payload: procedure('summarise-a-file'),
    })
    expect(result.ok).toBe(true)
    expect(result.skill?.operation).toBe('admitted')
    expect(host!.skills()?.counts.retained).toBe(1)
    expect(seen.at(-1)?.counts.retained).toBe(1)
  })

  it('forwards a refusal on the envelope as well as in the Skills slot', async () => {
    await host!.start()
    const result = await host!.submit({
      command: 'skill.admit',
      requestId: 'r1',
      payload: { ...procedure('launder'), requiredCapabilities: ['security.stop'] },
    })
    // A window that only read `ok` would otherwise render this as a success.
    expect(result.ok).toBe(false)
    expect(result.refusal).toBeDefined()
    expect(result.skill?.ok).toBe(false)
    expect(result.skill?.code).toBe('forbidden-capability-required')
  })

  it('says plainly that bodies are ephemeral when no key was supplied', async () => {
    const ephemeralDir = await mkdtemp(join(tmpdir(), 'freya-skills-ephemeral-'))
    const ephemeral = new ElectronCoreHost(join(ephemeralDir, 'core-events.jsonl'), {}, {
      attentionObserveSources: false,
      skillKey: null,
    })
    try {
      await ephemeral.start()
      const projection = ephemeral.skills()
      expect(projection?.persistence.mode).toBe('ephemeral')
      expect(projection?.persistence.durable).toBe(false)
      expect(projection?.persistence.reason).toMatch(/in this process only/i)
    } finally {
      await ephemeral.stop('teardown')
      await rm(ephemeralDir, { recursive: true, force: true })
    }
  })

  it('costs no model call for anything it mirrors', async () => {
    await host!.start()
    const before = host!.status().durableUsage.calls
    const result = await host!.submit({
      command: 'skill.admit',
      requestId: 'r1',
      payload: procedure('summarise-a-file'),
    })
    const skillId = result.skill?.skillId
    await host!.submit({
      command: 'skill.recordEvaluation',
      requestId: 'r2',
      payload: {
        skillId,
        subjectKind: 'trial-run',
        subjectRef: 'run-1',
        evidence: [{ kind: 'test-result', code: 'passed', count: 1 }],
        commentaryLength: 3_000,
      },
    })
    await host!.submit({ command: 'skill.status.read', requestId: 'r3' })
    await host!.submit({ command: 'skill.select', requestId: 'r4', payload: { applicability: ['research'] } })
    if (before !== undefined) {
      expect(host!.status().durableUsage.calls).toBe(before)
    }
  })
})

/** One file's code with its prose removed. */
async function codeOnly(path: string): Promise<string> {
  const source = await readFile(new URL(path, import.meta.url), 'utf8')
  return source
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trimStart()
      return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*')
    })
    .join('\n')
}

describe('the preload bridge gives a window a read and the nine owner commands', () => {
  it('names the pull and the subscription, and nothing that executes or verifies', async () => {
    const source = await codeOnly('../../electron/preload.ts')
    const keys = [...source.matchAll(/^\s{2}(\w*[Ss]kill\w*):/gm)].map((match) => match[1])
    expect([...keys].sort()).toEqual(['coreSkills', 'onCoreSkills'])
    expect(source).not.toMatch(/skill\w*(Execute|Run|Verify|Promote\.artifact|Threshold|Tick)/)
  })

  it('whitelists exactly the ten skill commands, and none of the dangerous names', async () => {
    const source = await codeOnly('../../electron/preload.ts')
    const listed = source.slice(source.indexOf('const CORE_COMMANDS'), source.indexOf('function readString'))
    const names = [...listed.matchAll(/'(skill\.[^']+)'/g)].map((match) => match[1]).sort()
    expect(names).toEqual([
      'skill.admit',
      'skill.detail.read',
      'skill.proposal.settle',
      'skill.propose',
      'skill.recordEvaluation',
      'skill.retire',
      'skill.revise',
      'skill.select',
      'skill.status.read',
      'skill.transition',
    ])
    for (const forbidden of [
      'skill.execute',
      'skill.verify',
      'skill.promote.artifact',
      'skill.threshold.set',
      'skill.tick',
      'skill.run',
      'skill.source.write',
    ]) {
      expect(listed).not.toContain(forbidden)
    }
  })

  it('has no channel that could take a source-file path or a runtime write', async () => {
    const preload = await codeOnly('../../electron/preload.ts')
    const main = await codeOnly('../../electron/main.ts')
    const hostBridge = await codeOnly('../../src/platform/host.ts')
    expect(preload).toContain("ipcRenderer.invoke('freya:core:skills')")
    expect(preload).toContain("ipcRenderer.on('freya:core:skills'")
    expect(main).toContain("ipcMain.handle('freya:core:skills'")
    expect(main).toContain("webContents.send('freya:core:skills'")
    for (const file of [preload, main, hostBridge]) {
      expect(file).not.toContain('freya:core:skills:write')
      expect(file).not.toMatch(/skill\.(execute|verify|tick|run)\b/)
    }
  })

  it('forwards no trust class, no verification array and no threshold from a window', async () => {
    const preload = await codeOnly('../../electron/preload.ts')
    const skillArms = preload.slice(preload.indexOf("case 'skill.admit'"), preload.indexOf("case 'voice.capture.end'"))
    // The payload is rebuilt from named fields, so these never even cross the bridge.
    expect(skillArms).toContain('requiredCapabilities')
    expect(skillArms).not.toContain('trustClass:')
    expect(skillArms).not.toContain('verification:')
    expect(skillArms).not.toContain('thresholds')
    // Commentary is a *count*, and there is no field for its text.
    expect(skillArms).toContain('commentaryLength')
    expect(skillArms).not.toMatch(/commentary[^:]*:\s*string/)
  })

  it('keeps the "no Skill domain" sentence in one place, quoted from the protocol', async () => {
    const protocol = await codeOnly('../../core/protocol/skills.ts')
    const preload = await codeOnly('../../electron/preload.ts')
    const main = await codeOnly('../../electron/main.ts')
    expect(protocol).toContain('NO_SKILL_DOMAIN_REASON')
    expect(protocol).toContain('this Core has no Skill domain')
    for (const file of [preload, main]) {
      expect(file).not.toContain('no Skill domain')
      expect(file).not.toContain('none is simulated')
    }
  })
})

describe('the skill domain itself imports nothing that could reach a model or a file', () => {
  it('has no gateway, provider, authority or filesystem import outside persistence/', async () => {
    const { readdir } = await import('node:fs/promises')
    const { fileURLToPath } = await import('node:url')
    const dir = fileURLToPath(new URL('../../core/skills', import.meta.url))
    const files: string[] = []
    const walk = async (current: string): Promise<void> => {
      for (const entry of await readdir(current, { withFileTypes: true })) {
        const full = join(current, entry.name)
        if (entry.isDirectory()) await walk(full)
        else if (entry.name.endsWith('.ts')) files.push(full)
      }
    }
    await walk(dir)
    expect(files.length).toBeGreaterThan(8)
    for (const file of files) {
      const source = await readFile(file, 'utf8')
      const isPersistence = file.includes(join('skills', 'persistence'))
      // Import *specifiers* only: a doc comment may name `node:fs` in order to say the
      // module does not import it, and matching prose would be matching the wrong thing.
      const specifiers = [...source.matchAll(/^\s*(?:import|export)[^'"]*from '([^']+)'/gm)].map(
        (match) => match[1]!,
      )
      // `errors.ts` is a closed code table with nothing to import, which is itself
      // worth asserting rather than skipping: a file that grew an import would now fail.
      if (!file.endsWith('errors.ts')) expect(specifiers.length, file).toBeGreaterThan(0)
      for (const specifier of specifiers) {
        expect(specifier, file).not.toMatch(/model\/(gateway|provider|fake-provider|nanogpt)/)
        expect(specifier, file).not.toMatch(/\.\.\/authority$/)
        expect(specifier, file).not.toMatch(/\.\.\/index$/)
        // `node:fs` belongs to the encrypted store and nothing else: a skill body may
        // be written to exactly one place, and the domain may not touch a file at all.
        if (!isPersistence) expect(specifier, file).not.toMatch(/node:fs/)
        // `node:crypto` is allowed in exactly two places: the deterministic identity
        // digest (a change detector, not a secret) and the encrypted store. Anywhere
        // else it would be somewhere a skill body could quietly be hashed or sealed.
        const mayUseCrypto =
          isPersistence || file.endsWith(join('skills', 'identity.ts'))
        if (!mayUseCrypto) expect(specifier, file).not.toMatch(/node:crypto/)
      }
    }
  })

  it('lets no module reach a provider, a gateway or an authority object', async () => {
    const { readdir, readFile: read } = await import('node:fs/promises')
    const { fileURLToPath } = await import('node:url')
    const dir = fileURLToPath(new URL('../../core/skills', import.meta.url))
    const files: string[] = []
    const walk = async (current: string): Promise<void> => {
      for (const entry of await readdir(current, { withFileTypes: true })) {
        const full = join(current, entry.name)
        if (entry.isDirectory()) await walk(full)
        else if (entry.name.endsWith('.ts')) files.push(full)
      }
    }
    await walk(dir)
    for (const file of files) {
      const source = await read(file, 'utf8')
      for (const forbidden of ['Gateway', 'ModelProvider', 'OwnerAuthority', 'WorkerAuthority', 'requestCognition']) {
        expect(source, file).not.toContain(forbidden)
      }
    }
  })
})