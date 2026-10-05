// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The keyring.
 *
 * `safeStorage` is mocked rather than exercised, and that is the right shape for
 * this test. What Freya needs to know about the keyring is *its* behaviour — what
 * it writes, what it adopts, what it refuses — and all of that is decided in this
 * repository's code. The OS's own wrapping is the part nobody should be
 * re-testing; DPAPI and the macOS Keychain are tested by Apple and Microsoft.
 *
 * The properties:
 *
 *  1. **One independent secret per domain.** Recovering the conversation secret must
 *     not yield the Brain. This is the property the whole file exists for.
 *  2. **Phase 3 history stays readable.** The old `.key` file is adopted verbatim.
 *  3. **The legacy file is not deleted.** A migration that can lose access to
 *     existing history on its failure path is not one worth shipping.
 *  4. **No OS secure storage means no key at all** — never a plaintext fallback.
 */

/**
 * The real platform is read-only, and `describeProtection` and the `basic_text`
 * check both branch on it. Stubbing it is what lets a Windows or macOS run exercise
 * the Linux-only path at all.
 */
const realPlatform = process.platform

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true })
}

/**
 * A fake `safeStorage`.
 *
 * Real enough for the properties under test: it is tied to a "user account", so
 * unwrapping under a different account fails exactly as it does on a real machine.
 * `available` and `backend` are mutable so a test can make the OS say no.
 */
const secure = {
  available: true,
  backend: 'gnome_libsecret' as string,
  account: 'user-a',
  throwingSecret: '',
  throwingEncrypt: false,
  attemptedPlaintext: '',
}

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => secure.available,
    getSelectedStorageBackend: () => secure.backend,
    encryptString: (plaintext: string) => {
      if (secure.throwingEncrypt) {
        secure.attemptedPlaintext = plaintext
        throw new Error(`cannot encrypt ${plaintext}`)
      }
      return Buffer.from(`${secure.account}:${Buffer.from(plaintext, 'utf8').toString('base64')}`, 'utf8')
    },
    decryptString: (wrapped: Buffer) => {
      const text = Buffer.from(wrapped).toString('utf8')
      if (secure.throwingSecret && text.includes(secure.throwingSecret)) {
        throw new Error(`cannot decrypt ${secure.throwingSecret}`)
      }
      const separator = text.indexOf(':')
      if (separator === -1) return ''
      // A different OS account cannot open it, which is the property that makes a
      // copied keyring file worthless.
      if (text.slice(0, separator) !== secure.account) return ''
      try {
        return Buffer.from(text.slice(separator + 1), 'base64').toString('utf8')
      } catch {
        return ''
      }
    },
  },
}))

const { loadKeyring, KEYRING_VERSION } = await import('../../electron/keyring')

let dir = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'freya-keyring-'))
  secure.available = true
  secure.backend = 'gnome_libsecret'
  secure.account = 'user-a'
  secure.throwingSecret = ''
  secure.throwingEncrypt = false
  secure.attemptedPlaintext = ''
  setPlatform('linux')
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/**
 * Wrap a secret the way the mocked `safeStorage` does.
 *
 * Returns the raw bytes `encryptString` would produce. Those go on disk verbatim for
 * a Phase 3 `.key` file, and base64'd again for a JSON keyring field — two layers
 * in the keyring's case, and conflating them produces a file that looks plausible
 * and unwraps to nonsense.
 */
function wrap(plaintextBase64: string): Buffer {
  return Buffer.from(`user-a:${Buffer.from(plaintextBase64, 'utf8').toString('base64')}`, 'utf8')
}

/** The same bytes as they appear inside a JSON keyring. */
function wrapField(plaintextBase64: string): string {
  return wrap(plaintextBase64).toString('base64')
}

function dataPath(): string {
  return join(dir, 'core-events.jsonl')
}

/** Write a Phase 3 style single-key file, wrapped the way Electron wraps one. */
async function writeLegacyKey(secret: Uint8Array): Promise<string> {
  const path = `${dataPath()}.key`
  await writeFile(path, wrap(Buffer.from(secret).toString('base64')))
  return path
}

describe('one secret per domain', () => {
  it('does not echo arbitrary keyring field content in format errors', async () => {
    const sensitive = 'private-content-in-version'
    await writeFile(`${dataPath()}.keyring.json`, JSON.stringify({ version: sensitive, keys: {} }))
    const result = await loadKeyring(dataPath())
    expect(result.brain.key).toBeNull()
    expect(result.brain.reason).toMatch(/unrecognised/)
    expect(result.brain.reason).not.toContain(sensitive)
  })

  it('never includes plaintext keys from thrown OS encryption errors in public reasons', async () => {
    secure.throwingEncrypt = true
    const result = await loadKeyring(dataPath())
    expect(secure.attemptedPlaintext).not.toBe('')
    for (const domain of [result.conversation, result.brain, result.mission]) {
      expect(domain.key).toBeNull()
      expect(domain.reason).not.toContain(secure.attemptedPlaintext)
    }
    expect(existsSync(`${dataPath()}.keyring.json`)).toBe(false)
  })

  it('gives every domain a different secret from every other', async () => {
    const keyring = await loadKeyring(dataPath())
    expect(keyring.conversation.key).not.toBeNull()
    expect(keyring.brain.key).not.toBeNull()
    expect(keyring.mission.key).not.toBeNull()
    // The property the whole file exists for. If this ever failed, a leaked
    // conversation key would be a leaked Brain, and "the conversation key leaked"
    // would stop being a bounded problem.
    const domains = [
      keyring.conversation,
      keyring.brain,
      keyring.mission,
      keyring.context,
      keyring.personality,
    ]
    const hexes = domains.map((domain) => Buffer.from(domain.key!).toString('hex'))
    expect(new Set(hexes).size).toBe(domains.length)
  })

  it('gives each domain a full 256-bit secret', async () => {
    const keyring = await loadKeyring(dataPath())
    expect(keyring.conversation.key!.length).toBe(32)
    expect(keyring.brain.key!.length).toBe(32)
    expect(keyring.mission.key!.length).toBe(32)
    expect(keyring.context.key!.length).toBe(32)
    expect(keyring.personality.key!.length).toBe(32)
  })

  it('wraps each secret separately, not as one blob', async () => {
    await loadKeyring(dataPath())
    const file = JSON.parse(await readFile(`${dataPath()}.keyring.json`, 'utf8')) as {
      version: number
      protection: string
      keys: Record<string, string>
    }
    expect(file.version).toBe(KEYRING_VERSION)
    // The record is there so a keyring written on one platform is never read as
    // though it had been written the same way on another.
    expect(file.protection).toBe('gnome_libsecret')
    // Separate domain keys are written for every durable private store.
    expect(Object.keys(file.keys).sort()).toEqual([
      'brain',
      'context',
      'conversation',
      'forge',
      'mission',
      'personality',
      'skill',
      'vault',
    ])
    // Separate wrapped blobs: recovering one domain never unwraps another.
    expect(file.keys.brain).not.toBe(file.keys.conversation)
    expect(file.keys.mission).not.toBe(file.keys.conversation)
    expect(file.keys.mission).not.toBe(file.keys.brain)
    expect(file.keys.skill).not.toBe(file.keys.conversation)
    expect(file.keys.skill).not.toBe(file.keys.brain)
    expect(file.keys.skill).not.toBe(file.keys.mission)
    expect(file.keys.skill).not.toBe(file.keys.context)
    // The one domain that has to be independent *and* is easiest to forget: what
    // Freya has recorded about a person must not be readable by anything holding
    // the conversation key, and vice versa.
    expect(file.keys.personality).not.toBe(file.keys.conversation)
    expect(file.keys.personality).not.toBe(file.keys.brain)
  })

  it('returns the same secrets on the next run', async () => {
    const first = await loadKeyring(dataPath())
    const second = await loadKeyring(dataPath())
    expect(Buffer.from(second.brain.key!).equals(Buffer.from(first.brain.key!))).toBe(true)
    expect(Buffer.from(second.conversation.key!).equals(Buffer.from(first.conversation.key!))).toBe(true)
  })

  it('will not unwrap a keyring copied to another OS account', async () => {
    await loadKeyring(dataPath())
    // Copied wholesale to a different account. The file travels; the OS secret does
    // not, so there is nothing readable here.
    secure.account = 'user-b'
    const elsewhere = await loadKeyring(dataPath())
    expect(elsewhere.brain.key).toBeNull()
    expect(elsewhere.conversation.key).toBeNull()
    // Refused, not replaced with something weaker.
    expect(elsewhere.brain.reason).toMatch(/could not be decrypted/)
  })
})

/**
 * Phase 7's third domain, and the migration that introduces it.
 *
 * The hard part is not generating a key, it is adding one to a file that already
 * exists without endangering the two that are in it. Those keys belong to people's
 * conversations and their own long-term memory, and there is no way to regenerate
 * them — so a rewrite that failed halfway would be unrecoverable rather than
 * merely inconvenient.
 */
describe('the Mission domain, and the migration that introduces it', () => {
  /** A Phase 6 keyring: correct, current, and missing the Mission key. */
  async function writeTwoDomainKeyring(): Promise<{ conversation: string; brain: string }> {
    const conversation = randomBytes(32).toString('base64')
    const brain = randomBytes(32).toString('base64')
    await writeFile(
      `${dataPath()}.keyring.json`,
      JSON.stringify({
        version: KEYRING_VERSION,
        protection: 'gnome_libsecret',
        keys: { conversation: wrapField(conversation), brain: wrapField(brain) },
      }),
    )
    return { conversation, brain }
  }

  it('reads a Mission key written by an earlier run', async () => {
    const first = await loadKeyring(dataPath())
    const second = await loadKeyring(dataPath())
    // Durable Missions, not per-launch ones: a key regenerated on every start would
    // make every Mission written encrypted unreadable at the next start, which reads
    // exactly like losing them.
    expect(Buffer.from(second.mission.key!).equals(Buffer.from(first.mission.key!))).toBe(true)
  })

  it('adds a Mission key to an existing keyring without disturbing the other two', async () => {
    const before = await writeTwoDomainKeyring()

    const keyring = await loadKeyring(dataPath())

    // The two existing secrets must survive byte-for-byte. These are somebody's
    // history; there is no second copy and no way to regenerate them.
    expect(Buffer.from(keyring.conversation.key!).toString('base64')).toBe(before.conversation)
    expect(Buffer.from(keyring.brain.key!).toString('base64')).toBe(before.brain)
    expect(keyring.mission.key).not.toBeNull()
    expect(keyring.mission.key!.length).toBe(32)

    // And it was persisted, rather than generated afresh each launch.
    const file = JSON.parse(await readFile(`${dataPath()}.keyring.json`, 'utf8')) as {
      keys: Record<string, string>
    }
    expect(Object.keys(file.keys).sort()).toEqual([
      'brain',
      'context',
      'conversation',
      'forge',
      'mission',
      'personality',
      'skill',
      'vault',
    ])
  })

  it('gives the migrated Mission key a different secret from both existing ones', async () => {
    await writeTwoDomainKeyring()
    const keyring = await loadKeyring(dataPath())
    const hexes = [keyring.conversation, keyring.brain, keyring.mission].map((domain) =>
      Buffer.from(domain.key!).toString('hex'),
    )
    // A Mission re-wrapping the conversation secret would be worse than no
    // migration: it would look correct and quietly merge two blast radii.
    expect(new Set(hexes).size).toBe(3)
  })

  it('will not rewrite a keyring whose existing secrets it cannot read', async () => {
    await writeTwoDomainKeyring()
    const onDisk = await readFile(`${dataPath()}.keyring.json`, 'utf8')

    // Copied to another OS account: the file travels, the secrets do not.
    secure.account = 'user-b'

    const keyring = await loadKeyring(dataPath())

    // Nothing was written, so the original is intact for whoever does hold the keys.
    expect(await readFile(`${dataPath()}.keyring.json`, 'utf8')).toBe(onDisk)

    // And no Mission key is claimed, because adding one would mean re-wrapping
    // secrets this process cannot open.
    expect(keyring.mission.key).toBeNull()
    // And it says the two true things: the keyring was not touched, and the Mission
    // will forget itself rather than take anything else down with it.
    expect(keyring.mission.reason).toMatch(/left untouched/i)
    expect(keyring.mission.reason).toMatch(/memory/i)
  })

  it('still keeps the readable domains when the OS cannot write the new one', async () => {
    await writeTwoDomainKeyring()
    secure.throwingEncrypt = true

    const keyring = await loadKeyring(dataPath())

    // A migration that costs history because it could not add a key is a strictly
    // worse outcome than a Mission that forgets itself.
    expect(keyring.conversation.key).not.toBeNull()
    expect(keyring.brain.key).not.toBeNull()
    expect(keyring.mission.key).toBeNull()
    expect(keyring.mission.reason).not.toContain(secure.attemptedPlaintext)
  })

  it('does not mistake a two-domain keyring for a corrupt one', async () => {
    // The migration is an upgrade, not an error. A file that predates the Mission
    // domain is exactly what this code is expected to meet.
    await writeTwoDomainKeyring()
    const keyring = await loadKeyring(dataPath())
    expect(keyring.conversation.reason).toBeNull()
    expect(keyring.brain.reason).toBeNull()
    expect(keyring.mission.reason).toBeNull()
  })
})

describe('adopting Phase 3 history', () => {
  it('adopts the legacy key verbatim as the conversation secret', async () => {
    const legacy = randomBytes(32)
    await writeLegacyKey(legacy)
    const keyring = await loadKeyring(dataPath())
    // Byte-identical, because a derived key would make every existing transcript
    // unreadable — and a silent inability to read your own history is exactly the
    // kind of failure nobody notices until it is too late.
    expect(Buffer.from(keyring.conversation.key!).equals(legacy)).toBe(true)
  })

  it('still mints an independent Brain secret', async () => {
    const legacy = randomBytes(32)
    await writeLegacyKey(legacy)
    const keyring = await loadKeyring(dataPath())
    expect(Buffer.from(keyring.brain.key!).equals(legacy)).toBe(false)
  })

  it('leaves the legacy file in place', async () => {
    const legacyPath = await writeLegacyKey(randomBytes(32))
    await loadKeyring(dataPath())
    // Not deleted. If adoption ever failed, the next run should still find the key
    // it already had rather than a keyring that cannot open anything.
    expect(existsSync(legacyPath)).toBe(true)
  })

  it('does not read the legacy file once a keyring exists', async () => {
    await writeLegacyKey(randomBytes(32))
    const first = await loadKeyring(dataPath())
    // A second legacy file appears. The keyring is authoritative from here on;
    // re-adopting would silently change the conversation secret under existing
    // transcripts.
    const other = randomBytes(32)
    await writeLegacyKey(other)
    const second = await loadKeyring(dataPath())
    expect(Buffer.from(second.conversation.key!).equals(Buffer.from(first.conversation.key!))).toBe(true)
  })

  it('mints a fresh conversation secret when the legacy file is unusable', async () => {
    // A wrong-length or unopenable legacy file is treated as absent. That makes
    // existing history unreadable — which is the safe direction, because it is
    // immediately visible rather than a key of unknown origin being reused.
    await writeFile(`${dataPath()}.key`, Buffer.from('garbage', 'utf8'))
    const keyring = await loadKeyring(dataPath())
    expect(keyring.conversation.key!.length).toBe(32)
  })
})

describe('when the OS says no', () => {
  it('returns no key at all when secure storage is unavailable', async () => {
    secure.available = false
    const keyring = await loadKeyring(dataPath())
    expect(keyring.conversation.key).toBeNull()
    expect(keyring.brain.key).toBeNull()
    // Never a plaintext fallback. Writing the key beside the data it protects would
    // be a worse bug than forgetting a conversation, and it is undetectable.
    expect(existsSync(`${dataPath()}.keyring.json`)).toBe(false)
  })

  it('refuses the insecure basic_text backend on Linux', async () => {
    // Electron reports encryption as available while having selected a backend
    // whose wrapping key comes from a hard-coded plaintext password.
    secure.backend = 'basic_text'
    const keyring = await loadKeyring(dataPath())
    expect(keyring.brain.key).toBeNull()
    expect(keyring.brain.reason).toMatch(/basic_text/)
  })

  it('ignores the backend name off Linux, where it does not apply', async () => {
    setPlatform('darwin')
    secure.backend = 'basic_text'
    const keyring = await loadKeyring(dataPath())
    expect(keyring.brain.key).not.toBeNull()
  })
})

describe('a keyring it cannot trust', () => {
  it('isolates thrown OS decrypt failures and never reports key material', async () => {
    const conversation = Buffer.alloc(32, 0x61)
    const brain = Buffer.alloc(32, 0x62)
    await writeFile(`${dataPath()}.keyring.json`, JSON.stringify({
      version: KEYRING_VERSION,
      protection: 'gnome_libsecret',
      keys: { conversation: wrapField(conversation.toString('base64')), brain: wrapField(brain.toString('base64')) },
    }))
    secure.throwingSecret = Buffer.from(brain.toString('base64')).toString('base64')
    const result = await loadKeyring(dataPath())
    expect(result.conversation.key).not.toBeNull()
    expect(Buffer.from(result.conversation.key!)).toEqual(conversation)
    expect(result.brain.key).toBeNull()
    expect(result.brain.reason).not.toContain(secure.throwingSecret)
    expect(result.brain.reason).not.toContain(brain.toString('base64'))
  })

  it('refuses a malformed keyring rather than overwriting it', async () => {
    const path = `${dataPath()}.keyring.json`
    await writeFile(path, 'not json at all', 'utf8')
    const keyring = await loadKeyring(dataPath())
    expect(keyring.brain.key).toBeNull()
    // Falling back to generating fresh keys would produce a Brain that silently
    // cannot read its own history, which is far harder to notice than a failure.
    expect(await readFile(path, 'utf8')).toBe('not json at all')
  })

  it('refuses a keyring from a future version rather than guessing', async () => {
    const path = `${dataPath()}.keyring.json`
    await writeFile(path, JSON.stringify({ version: 99, keys: {} }), 'utf8')
    const keyring = await loadKeyring(dataPath())
    expect(keyring.brain.key).toBeNull()
    expect(keyring.brain.reason).toMatch(/version 99/)
  })

  it('refuses a secret of the wrong length', async () => {
    const path = `${dataPath()}.keyring.json`
    const short = wrapField(Buffer.from('u').toString('base64'))
    await writeFile(
      path,
      JSON.stringify({
        version: KEYRING_VERSION,
        protection: 'gnome_libsecret',
        keys: { conversation: short, brain: short },
      }),
      'utf8',
    )
    const keyring = await loadKeyring(dataPath())
    expect(keyring.brain.key).toBeNull()
    expect(keyring.brain.reason).toMatch(/wrong length/)
  })

  it('reports each domain independently, so a half-working keyring is visible', async () => {
    const path = `${dataPath()}.keyring.json`
    await writeFile(
      path,
      JSON.stringify({
        version: KEYRING_VERSION,
        protection: 'gnome_libsecret',
        keys: {
          conversation: wrapField(randomBytes(32).toString('base64')),
          // One character: opens fine, and is the wrong length for a key.
          brain: wrapField(Buffer.from('u').toString('base64')),
        },
      }),
      'utf8',
    )
    const keyring = await loadKeyring(dataPath())
    // One works, one does not. A single ok/fail would either lose readable history
    // or present an ephemeral Brain as though it were durable.
    expect(keyring.conversation.key).not.toBeNull()
    expect(keyring.brain.key).toBeNull()
  })
})

describe('secrets never leak', () => {
  it('upgrades a three-domain keyring with an independent, stable Context key', async () => {
    const path = `${dataPath()}.keyring.json`
    const keys = { conversation: randomBytes(32), brain: randomBytes(32), mission: randomBytes(32) }
    await writeFile(path, JSON.stringify({ version: KEYRING_VERSION, protection: 'gnome_libsecret', keys: {
      conversation: wrapField(keys.conversation.toString('base64')),
      brain: wrapField(keys.brain.toString('base64')),
      mission: wrapField(keys.mission.toString('base64')),
    } }))
    const first = await loadKeyring(dataPath())
    expect(first.context?.key).toBeInstanceOf(Uint8Array)
    for (const domain of ['conversation', 'brain', 'mission'] as const) {
      expect(Buffer.from(first[domain].key!)).toEqual(keys[domain])
      expect(Buffer.from(first.context.key!)).not.toEqual(keys[domain])
    }
    const second = await loadKeyring(dataPath())
    expect(second.context.key).toEqual(first.context.key)
    const raw = await readFile(path, 'utf8')
    expect(raw).not.toContain(Buffer.from(first.context.key!).toString('base64'))
  })

  it('preserves an existing Mission key when the Context upgrade cannot be written', async () => {
    const path = `${dataPath()}.keyring.json`
    const mission = randomBytes(32)
    await writeFile(path, JSON.stringify({ version: KEYRING_VERSION, protection: 'gnome_libsecret', keys: {
      conversation: wrapField(randomBytes(32).toString('base64')),
      brain: wrapField(randomBytes(32).toString('base64')),
      mission: wrapField(mission.toString('base64')),
    } }))
    const before = await readFile(path, 'utf8')
    secure.throwingEncrypt = true
    const result = await loadKeyring(dataPath())
    expect(result.context?.key).toBeNull()
    expect(Buffer.from(result.mission.key!)).toEqual(mission)
    expect(await readFile(path, 'utf8')).toBe(before)
  })
  it('writes no secret in the clear', async () => {
    const keyring = await loadKeyring(dataPath())
    const raw = await readFile(`${dataPath()}.keyring.json`, 'utf8')
    const secrets = [keyring.brain.key!, keyring.conversation.key!]
    for (const secret of secrets) {
      const base64 = Buffer.from(secret).toString('base64')
      expect(raw).not.toContain(base64)
      expect(raw).not.toContain(Buffer.from(secret).toString('hex'))
      // A digest would be nearly as bad: it is brute-forceable for a known seed.
      expect(raw).not.toContain(createHash('sha256').update(Buffer.from(secret)).digest('hex'))
    }
  })

  it('exposes no way to read a secret back out of the keyring', async () => {
    await loadKeyring(dataPath())
    // Only the fields Core needs. There is no "list all secrets" surface,
    // so a caller cannot enumerate what is protected.
    const raw = JSON.parse(await readFile(`${dataPath()}.keyring.json`, 'utf8')) as Record<string, unknown>
    expect(Object.keys(raw).sort()).toEqual(['keys', 'protection', 'version'])
  })
})
