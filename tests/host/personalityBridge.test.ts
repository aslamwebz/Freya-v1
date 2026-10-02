// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ElectronCoreHost } from '../../electron/coreHost'
import {
  ABSENT_PERSONALITY_PROJECTION,
  NO_PERSONALITY_DOMAIN_REASON,
  type PersonalityProjection,
  type PersonalitySource,
} from '../../core/protocol/personality'
import { projectPersonality } from '../../core/personality/projection'

/**
 * The Personality lane across the host and the preload bridge.
 *
 * The same bargain as Workforce, and a narrower one: a window gets a pull and
 * a subscription and there is no verb with which to *write* a relationship.
 * So the host half tests what is mirrored (and what a build with no
 * Personality domain honestly says instead), and the bridge half reads the
 * bridge's own source to prove that the write it does not expose is absent
 * from the code rather than merely unused by the tests.
 */

let dir = ''
let host: ElectronCoreHost | null = null

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'freya-personality-host-'))
  host = new ElectronCoreHost(join(dir, 'core-events.jsonl'), {})
})

afterEach(async () => {
  await host?.stop('test-teardown')
  host = null
  await rm(dir, { recursive: true, force: true })
})

/** A projection built by the real builder, not by hand. */
function readyProjection(sequence = 7): PersonalityProjection {
  return projectPersonality({
    sequence,
    temperament: null,
    items: [],
    interpretation: null,
    expression: null,
    ledger: null,
  })
}

/** The smallest source the seam accepts, with a `set` for "it changed". */
function fakeSource(initial: PersonalityProjection): {
  source: PersonalitySource
  set: (next: PersonalityProjection) => void
} {
  let current = initial
  const listeners = new Set<(projection: PersonalityProjection) => void>()
  return {
    source: {
      projection: () => current,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    },
    set: (next) => {
      current = next
      for (const listener of [...listeners]) listener(next)
    },
  }
}

describe('the Personality mirror belongs to the process, not the window', () => {
  it('reports nothing before Core has started', () => {
    // Null, not an empty projection: a host with no Core has no Personality to
    // report, and the difference between "no Core yet" and "no relationship
    // record" is a sentence a window must be able to tell apart.
    expect(host!.personality()).toBeNull()
    const seen: PersonalityProjection[] = []
    host!.onPersonality((projection) => seen.push(projection))
    expect(seen).toHaveLength(0)
  })

  it('pushes Core’s honest "no domain" reading the moment a window attaches', async () => {
    await host!.start()
    const seen: PersonalityProjection[] = []
    const dispose = host!.onPersonality((projection) => seen.push(projection))

    expect(seen).toHaveLength(1)
    expect(seen[0]?.health).toBe('unavailable')
    expect(seen[0]?.reason).toBe(NO_PERSONALITY_DOMAIN_REASON)
    expect(seen[0]?.items).toEqual([])
    expect(seen[0]?.temperament).toBeNull()
    // This build's sentence, not the generic one — a window must not read "no
    // domain" as "Core has not got round to reporting yet".
    expect(seen[0]?.reason).not.toBe(ABSENT_PERSONALITY_PROJECTION.reason)
    dispose()
  })

  it('forwards a source into Core and mirrors what comes back', async () => {
    const { source, set } = fakeSource(readyProjection())
    await host!.stop('rebuild with a source')
    host = new ElectronCoreHost(join(dir, 'core-events.jsonl'), {}, { personalitySource: source })
    await host!.start()

    const seen: PersonalityProjection[] = []
    const dispose = host!.onPersonality((projection) => seen.push(projection))
    expect(seen[0]?.health).toBe('ready')
    expect(seen[0]?.sequence).toBe(7)
    // Core's own read agrees with what was pushed: one truth, two doors.
    expect(host!.personality()?.sequence).toBe(7)

    // A window detaching mid-flight does not disturb the Core it attached to.
    dispose()
    set(readyProjection(8))
    expect(host!.personality()?.sequence).toBe(8)

    const second: PersonalityProjection[] = []
    host!.onPersonality((projection) => second.push(projection))
    expect(second).toHaveLength(1)
    expect(second[0]?.sequence).toBe(8)
  })

  it('serves a failed read as a failed read, never as a stale ready one', async () => {
    await host!.stop('rebuild with a throwing source')
    host = new ElectronCoreHost(join(dir, 'core-events.jsonl'), {}, {
      personalitySource: {
        projection: () => {
          throw new Error('relationship store is sealed')
        },
      },
    })
    await host!.start()

    const read = host!.personality()
    expect(read?.health).toBe('unavailable')
    expect(read?.reason).toContain('could not be read')
    expect(read?.items).toEqual([])
    expect(read?.reason).not.toBe(NO_PERSONALITY_DOMAIN_REASON)
  })

  it('drops a window that throws rather than taking the mirror down with it', async () => {
    const { source, set } = fakeSource(readyProjection())
    await host!.stop('rebuild with a source')
    host = new ElectronCoreHost(join(dir, 'core-events.jsonl'), {}, { personalitySource: source })
    await host!.start()

    host!.onPersonality(() => {
      throw new Error('this window is broken')
    })
    const healthy: PersonalityProjection[] = []
    host!.onPersonality((projection) => healthy.push(projection))

    set(readyProjection(9))
    expect(healthy.length).toBeGreaterThan(1)
    expect(healthy.at(-1)?.sequence).toBe(9)
  })
})

/**
 * One file's code with its prose removed — several comments explain in words
 * exactly which channel or command they do *not* expose, and leaving the prose
 * in would let a comment satisfy the assertion it describes.
 */
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

describe('the preload bridge gives a window exactly two Personality verbs', () => {
  it('names the pull and the subscription, and nothing that writes one', async () => {
    const source = await codeOnly('../../electron/preload.ts')

    const personalityKeys = [...source.matchAll(/^\s{2}(\w*[Pp]ersonality\w*):/gm)].map((match) => match[1])
    expect([...personalityKeys].sort()).toEqual(['corePersonality', 'onCorePersonality'])

    // No function that could record, admit, supersede, retire or otherwise
    // author a relationship entry — the write does not exist to be blocked.
    expect(source).not.toMatch(/personality\w*(Write|Submit|Set|Update|Admit|Record|Edit|Retire|Config)/i)
  })

  it('whitelists no `personality.*` command at all', async () => {
    const source = await codeOnly('../../electron/preload.ts')
    const listed = source.slice(
      source.indexOf('const CORE_COMMANDS'),
      source.indexOf('function readString'),
    )
    expect(listed).not.toBe('')
    const names = [...listed.matchAll(/'(personality\.[^']+)'/g)].map((match) => match[1])
    expect(names).toEqual([])
  })

  it('names only the read channel, with no write one anywhere in the host', async () => {
    const preload = await codeOnly('../../electron/preload.ts')
    const main = await codeOnly('../../electron/main.ts')
    const hostBridge = await codeOnly('../../src/platform/host.ts')

    // The same channel, spelled identically on both ends of the IPC boundary.
    expect(preload).toContain("ipcRenderer.invoke('freya:core:personality')")
    expect(preload).toContain("ipcRenderer.on('freya:core:personality'")
    expect(main).toContain("ipcMain.handle('freya:core:personality'")
    expect(main).toContain("webContents.send('freya:core:personality'")
    for (const file of [preload, main, hostBridge]) {
      expect(file).not.toContain('freya:core:personality:write')
      expect(file).not.toMatch(/personality\.(record|admit|submit|update|write)/)
    }
  })

  it('keeps the refusal sentence in one place, quoted from the protocol', async () => {
    // One sentence, one source: neither end of the bridge may paraphrase the
    // build's "no Personality domain" wording into its own slightly different
    // claim about a domain this build does not have.
    const protocol = await codeOnly('../../core/protocol/personality.ts')
    const preload = await codeOnly('../../electron/preload.ts')
    const main = await codeOnly('../../electron/main.ts')
    expect(protocol).toContain('NO_PERSONALITY_DOMAIN_REASON')
    expect(protocol).toContain('this Core has no Personality domain')
    for (const file of [preload, main]) {
      expect(file).not.toContain('no Personality domain')
      expect(file).not.toContain('none is simulated')
    }
  })
})
