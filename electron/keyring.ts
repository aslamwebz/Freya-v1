import { safeStorage } from 'electron'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * The Freya keyring.
 *
 * One place that handles secrets, in the main process on purpose. The renderer is
 * disposable and possibly compromised, and nothing in `core/` imports Electron at
 * all. Core receives key **bytes** by dependency injection and cannot generate,
 * derive, persist, log or forward them.
 *
 * ## One key per domain, not one key for everything
 *
 * Conversation history and the Brain are separate stores holding separate classes
 * of data, so they get separate keys:
 *
 *   ```
 *     conversation  256-bit random  ─┐
 *                                    ├─→ each wrapped separately by the OS
 *     brain         256-bit random  ─┘      (DPAPI / Keychain / libsecret)
 *   ```
 *
 * Each domain's secret is 32 bytes straight from the CSPRNG. Not one root plus
 * derived subkeys, and that is a deliberate trade. Deriving is tidier to manage,
 * but recovering a root yields *every* domain at once, so "the conversation key
 * leaked" stops being a bounded problem and becomes "Freya's entire memory
 * leaked". Two independent keys mean the blast radius of one is exactly one.
 *
 * The cost is real and is paid honestly: two secrets to protect rather than one,
 * and a keyring format to migrate. The Brain is the longest-lived, most valuable
 * state Freya will hold — expected to outlive the machine it was written on — so
 * it is the last thing that should be one key-compromise away from the
 * conversation log.
 *
 * ## The keyring file is worthless alone
 *
 * ```
 *   keyring file  →  each secret individually wrapped by the OS
 *   OS wrapper    →  tied to the user account (DPAPI / Keychain / libsecret)
 * ```
 *
 * Copy `freya.keyring.json` and `freya.brain.enc` to another machine, or another
 * account, and there is nothing readable. Each domain's wrapped blob is
 * independently decryptable, so recovering one domain never unwraps another.
 *
 * ## Legacy adoption
 *
 * Phase 3 kept a single `<data>.key` file holding one base64 secret. On first run
 * the keyring **adopts those exact bytes** as the conversation secret, so history
 * written by an earlier version stays readable, and then writes itself. The file is
 * left in place, unread, rather than deleted: if adoption fails, the next run still
 * finds the key it already had rather than a keyring that cannot open anything.
 * A migration that can lose access to existing history on the failure path is not
 * a migration worth shipping.
 *
 * ## When the OS says no
 *
 * `safeStorage.isEncryptionAvailable()` is false on some Linux configurations with
 * no keyring, and Electron reports `basic_text` on others — a backend whose
 * wrapping key comes from a hard-coded plaintext password rather than an OS secret
 * store. Neither is a boundary Freya will describe as encrypted persistence.
 *
 * The honest response is to return **no key**, which makes Core fall back to an
 * ephemeral in-memory store that labels itself as such. There is deliberately no
 * fallback that writes a key beside the data it protects, or writes either store in
 * plaintext: a weaker store silently standing in for an encrypted one is a worse
 * bug than forgetting a conversation, and it is the failure a person can never
 * detect.
 *
 * Nothing here logs, returns or formats a secret. The bytes go straight into Core.
 */

const KEY_BYTES = 32

/** Only fixed format diagnostics may cross the main-process boundary. */
class KeyringFormatError extends Error {}

/** Bumped only when the wrapping scheme changes incompatibly. */
export const KEYRING_VERSION = 1

/**
 * The domains that have separate keys.
 *
 * Closed, and the union is the point: adding a domain that quietly reused an
 * existing key would be a much worse mistake than not having the domain.
 */
export const KEY_DOMAINS = ['conversation', 'brain', 'mission', 'context', 'personality'] as const

export type KeyDomain = (typeof KEY_DOMAINS)[number]

export interface KeyringFile {
  version: number
  /** How each secret is protected on this machine. Recorded so a file written on
   *  one platform is never read as if it had been written the same way on another. */
  protection: string
  /**
   * One independently wrapped secret per domain.
   *
   * Partial on disk by design: a file written before Phase 7 has no `mission` key,
   * and refusing to read it would turn a routine upgrade into lost history. Reading
   * is tolerant; writing is not — `writeKeyring` only ever emits a complete set.
   */
  keys: Partial<Record<KeyDomain, string>>
}

export interface DomainKeyResult {
  /** Null when no secure key is available. Never a plaintext substitute. */
  key: Uint8Array | null
  /** Why there is no key, in words a person can act on. Null when there is one. */
  reason: string | null
}

export interface Keyring {
  keyringPath: string
  conversation: DomainKeyResult
  brain: DomainKeyResult
  mission: DomainKeyResult
  context: DomainKeyResult
  /**
   * A **fifth** independent secret.
   *
   * What Freya has recorded about a person is the most intimate thing this system
   * holds — preferences, habits, the shorthands they share — so it is the last
   * thing that should be one key-compromise away from the conversation log, and the
   * first that should not be readable by anything holding another domain's key. It
   * is also the only domain whose *absence* changes behaviour rather than only
   * durability: with no Personality key the anti-repetition ledger is refused rather
   * than trusted, so Freya stops offering gestures instead of quietly forgetting
   * which ones she already used.
   */
  personality: DomainKeyResult
}

/**
 * Load or create the keyring.
 *
 * Returns a result **per domain** rather than one for the whole keyring, because
 * the two failures are genuinely independent: a machine might open an existing
 * conversation key and be unable to create a Brain one. Collapsing them into a
 * single ok/fail would either lose readable history or silently present an
 * ephemeral Brain as if it were durable.
 */
export async function loadKeyring(dataPath: string): Promise<Keyring> {
  const keyringPath = `${dataPath}.keyring.json`
  const legacyPath = `${dataPath}.key`

  const unavailable = await unavailableReason()
  if (unavailable !== null) {
    const reason = unavailable
    return {
      keyringPath,
      conversation: { key: null, reason },
      brain: { key: null, reason },
      mission: { key: null, reason },
      context: { key: null, reason },
      personality: { key: null, reason },
    }
  }

  try {
    const existing = await readKeyring(keyringPath)
    if (existing !== null) {
      return await withMissingDomains(keyringPath, existing)
    }

    // First run on this machine, or the migration from Phase 3. The legacy secret is
    // adopted verbatim so existing history stays readable, and the file is left in
    // place — see the module note on why deletion would be the wrong call.
    const legacy = await readLegacyConversationKey(legacyPath)
    const generated = new Map<KeyDomain, Buffer>([
      ['conversation', legacy ?? randomBytes(KEY_BYTES)],
      ['brain', randomBytes(KEY_BYTES)],
      ['mission', randomBytes(KEY_BYTES)],
      ['context', randomBytes(KEY_BYTES)],
      ['personality', randomBytes(KEY_BYTES)],
    ])
    await writeKeyring(keyringPath, generated)

    return {
      keyringPath,
      conversation: resultFor(generated.get('conversation')!),
      brain: resultFor(generated.get('brain')!),
      mission: resultFor(generated.get('mission')!),
      context: resultFor(generated.get('context')!),
      personality: resultFor(generated.get('personality')!),
    }
  } catch (error) {
    const reason = error instanceof KeyringFormatError
      ? `the keyring could not be prepared: ${error.message}`
      : 'the keyring could not be prepared by OS secure storage or the filesystem'
    return {
      keyringPath,
      conversation: { key: null, reason },
      brain: { key: null, reason },
      mission: { key: null, reason },
      context: { key: null, reason },
      personality: { key: null, reason },
    }
  }
}

/**
 * Read an existing keyring, adding any domain it predates.
 *
 * Phase 7 introduced a third domain, so keyrings written by Phase 1–6 are missing
 * one. Adding it means rewriting the file, and rewriting means re-wrapping the
 * secrets already in it — which is only possible if this process can read them.
 *
 * So the rule is narrow and deliberate: **a keyring is only rewritten when every
 * secret already in it has been successfully unwrapped.** A keyring copied to
 * another OS account, or damaged in one domain, is left exactly as it was found.
 * The cost of that is a Mission that forgets itself; the cost of the alternative is
 * somebody's conversation history, which has no second copy and no way to be
 * regenerated.
 */
function keyringResult(path: string, read: (domain: KeyDomain) => DomainKeyResult): Keyring {
  return { keyringPath: path, conversation: read('conversation'), brain: read('brain'),
    mission: read('mission'), context: read('context'), personality: read('personality') }
}

async function withMissingDomains(path: string, file: KeyringFile): Promise<Keyring> {
  const missing = KEY_DOMAINS.filter((domain) => typeof file.keys[domain] !== 'string')
  if (missing.length === 0) return keyringResult(path, (domain) => unwrapDomain(file, domain))

  const readable = new Map<KeyDomain, Buffer>()
  const degraded = (reason: string): Keyring => keyringResult(path, (domain) =>
    missing.includes(domain) ? { key: null, reason } : unwrapDomain(file, domain))
  for (const domain of KEY_DOMAINS) {
    if (missing.includes(domain)) continue
    const unwrapped = unwrapDomain(file, domain)
    if (unwrapped.key === null) {
      return degraded('this machine cannot read the secrets already in the keyring, so it was left untouched; missing domains remain in memory only')
    }
    readable.set(domain, Buffer.from(unwrapped.key))
  }
  const upgraded = new Map<KeyDomain, Buffer>(readable)
  for (const domain of missing) upgraded.set(domain, randomBytes(KEY_BYTES))
  try {
    await writeKeyring(path, upgraded)
  } catch {
    return degraded('the new domain keys could not be written by OS secure storage; existing keys remain available and missing domains stay in memory only')
  }
  return keyringResult(path, (domain) => resultFor(upgraded.get(domain)!))
}

function resultFor(bytes: Buffer): DomainKeyResult {
  return { key: new Uint8Array(bytes), reason: null }
}


/**
 * Why no secure storage is available, or null when it is.
 *
 * `basic_text` is checked explicitly because Electron reports encryption as
 * available on Linux while having selected a backend that derives its wrapping
 * key from a hard-coded plaintext password. That is not a security boundary, and
 * a Brain protected by it would be a secret anyone with the file could read.
 */
async function unavailableReason(): Promise<string | null> {
  if (!safeStorage.isEncryptionAvailable()) {
    return (
      'this machine has no OS secure storage available, so Freya cannot encrypt its ' +
      'memory or conversation history and will keep both in memory only'
    )
  }
  if (
    process.platform === 'linux' &&
    typeof safeStorage.getSelectedStorageBackend === 'function' &&
    safeStorage.getSelectedStorageBackend() === 'basic_text'
  ) {
    return (
      'Electron selected the insecure basic_text storage backend, so Freya will keep ' +
      'its memory and conversation history in memory only rather than persist keys'
    )
  }
  return null
}

async function readKeyring(path: string): Promise<KeyringFile | null> {
  if (!existsSync(path)) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'))
  } catch {
    // A malformed keyring is not an empty one. Falling back to generating fresh
    // keys would produce a Brain that silently cannot read its own history, which
    // is far harder to notice than an outright failure.
    throw new KeyringFormatError('the keyring file is not valid JSON and was not overwritten')
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new KeyringFormatError('the keyring file is not an object and was not overwritten')
  }
  const file = parsed as Partial<KeyringFile>
  if (file.version !== KEYRING_VERSION) {
    // Reported, not upgraded. A future version must be opened by code that knows
    // how, and guessing would risk reusing one domain's secret for another.
    const version = Number.isSafeInteger(file.version) ? String(file.version) : 'unrecognised'
    throw new KeyringFormatError(`the keyring is version ${version} and this version reads ${KEYRING_VERSION}`)
  }
  return file as KeyringFile
}

async function writeKeyring(path: string, keys: Map<KeyDomain, Buffer>): Promise<void> {
  const wrapped: Partial<Record<KeyDomain, string>> = {}
  for (const domain of KEY_DOMAINS) {
    const bytes = keys.get(domain)
    // Wrapped separately, so recovering one domain never unwraps another.
    if (bytes !== undefined) {
      wrapped[domain] = safeStorage.encryptString(bytes.toString('base64')).toString('base64')
    }
  }
  const file: KeyringFile = {
    version: KEYRING_VERSION,
    protection: describeProtection(),
    keys: wrapped,
  }
  await mkdir(dirname(path), { recursive: true })
  // Written beside the target and renamed into place, so a crash or a full disk
  // mid-write leaves the previous keyring intact rather than a truncated one. These
  // keys have no second copy, so a torn keyring is unrecoverable rather than merely
  // inconvenient.
  const temporary = `${path}.new`
  await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, path)
}

/** Unwrap one domain, with every failure mode reported as a refusal. */
function unwrapDomain(file: KeyringFile, domain: KeyDomain): DomainKeyResult {
  const wrapped = file.keys?.[domain]
  if (typeof wrapped !== 'string' || wrapped.length === 0) {
    return {
      key: null,
      reason: `the keyring has no ${domain} key, so ${describeDomain(domain)} cannot be persisted`,
    }
  }
  // `decryptString` returns '' for input it cannot open, so a truncated, tampered or
  // foreign keyring is treated as unusable rather than as an empty secret.
  let plaintext: string
  try {
    plaintext = safeStorage.decryptString(Buffer.from(wrapped, 'base64'))
  } catch {
    // OS errors can contain the value being decrypted. Report only this domain's
    // fixed failure; another domain may still be readable.
    return { key: null, reason: `the stored ${domain} key could not be decrypted` }
  }
  if (plaintext.length === 0) {
    return {
      key: null,
      reason: `the stored ${domain} key could not be decrypted, so ${describeDomain(domain)} cannot be read or safely written`,
    }
  }
  const bytes = Buffer.from(plaintext, 'base64')
  if (bytes.length !== KEY_BYTES) {
    return {
      key: null,
      reason: `the stored ${domain} key is the wrong length and will not be used`,
    }
  }
  return { key: new Uint8Array(bytes), reason: null }
}

/**
 * Read the Phase 3 single-key file, for adoption.
 *
 * Returns null when there is none. On a wrong length or an undecryptable file it
 * also returns null, which makes the caller generate a fresh conversation key — and
 * that is the safe direction, because a fresh key makes the *existing* history
 * unreadable and so is visible immediately, rather than quietly reusing bytes whose
 * origin cannot be established.
 */
async function readLegacyConversationKey(path: string): Promise<Buffer | null> {
  if (!existsSync(path)) return null
  try {
    const wrapped = await readFile(path)
    const plaintext = safeStorage.decryptString(wrapped)
    if (plaintext.length === 0) return null
    const bytes = Buffer.from(plaintext, 'base64')
    return bytes.length === KEY_BYTES ? bytes : null
  } catch {
    return null
  }
}

function describeProtection(): string {
  if (process.platform === 'linux' && typeof safeStorage.getSelectedStorageBackend === 'function') {
    return safeStorage.getSelectedStorageBackend()
  }
  return process.platform
}

function describeDomain(domain: KeyDomain): string {
  if (domain === 'brain') return 'the Brain'
  if (domain === 'mission') return 'Missions'
  if (domain === 'context') return 'Context'
  if (domain === 'personality') return 'what Freya has recorded about you'
  return 'conversation history'
}
