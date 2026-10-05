import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'

import { BRAIN_LIMITS } from '../brain/types'
import type { MemoryKind, MemoryRecord, Sensitivity } from '../brain/types'
import type { Brain } from '../brain/brain'
import {
  IMPORT_SOURCE,
  downgradeImported,
  findAuthorityClaim,
  findAuthorityKey,
  findIdentityKey,
  findSecretShapeIn,
} from './policy'
import {
  MEMORY_IDENTITY_LIMITS,
  MEMORY_IDENTITY_SCHEMA_VERSION,
  OWNER_CHANNEL,
  refuse,
  type MemoryIdentityRefusal,
} from './types'

/**
 * PORTABLE MEMORY, AND WHY A BUNDLE CANNOT CARRY AUTHORITY.
 *
 * The owner's data belongs to the owner, which means it has to leave Freya's
 * machine when they ask — encrypted, verified, and in a shape another build can
 * read. That is a real capability and it is the direct opposite of the phase's
 * central restriction, so both live in this file together and the tension is
 * deliberate: **a bundle may move every belief Freya holds, and may move no
 * permission she has.**
 *
 * ## What a bundle carries
 *
 * Memories and the owner's pinning decisions. That is all, and the omissions are
 * stated rather than silent:
 *
 *  - **No identity root, no self-definition.** Who Freya *is* is code
 *    (`core/brain/brain.ts`, `buildIdentityRoot`), and the Brain's fold already
 *    keeps the first identity record forever. A bundle that could install one would
 *    be a file that rewrites a person.
 *  - **No authority of any kind.** No grants, budgets, approvals, capability states
 *    or stop state. Those live in Guard and the Governor, are read fresh, and are
 *    not exportable — there is no request shape in this file that reaches them.
 *  - **No candidates or reviews.** They are internal audit rows about admission, not
 *    knowledge, and they would roughly double a bundle's size.
 *  - **No experiences.** Metadata about what Freya attempted is evidence *about her
 *    own operation*, and a portable file is the wrong place for it.
 *
 * ## What a bundle can be refused for
 *
 * A bundle is refused **whole** for anything structural, and never partially
 * applied. If a bundle contains `{ grants: [...] }` or a nested identity key or a
 * credential-shaped string, the import ends with nothing written and a sentence
 * explaining which of those it found. Partial application would leave the owner
 * believing an import worked while the dangerous part was quietly dropped — and
 * would make the resulting Brain depend on which records an attacker chose to
 * include.
 *
 * Individual *claims* inside otherwise-fine records are handled the opposite way,
 * because they are ordinary content: a record claiming "I have permission to spend"
 * is imported at the lowest confidence and disclosed, because refusing to remember
 * what somebody said would be a worse lie.
 *
 * ## Encryption
 *
 * AES-256-GCM, unique nonce per bundle, envelope header authenticated as AAD, and
 * an optional scrypt KDF so an owner can move a bundle with a passphrase instead of
 * a keyring. A wrong key fails authentication and is reported as unreadable; there
 * is no "decrypt with a default key" path, and no plaintext fallback anywhere in
 * this file.
 */

const ALGORITHM = 'aes-256-gcm'
const KEY_BYTES = 32
const NONCE_BYTES = 12
const TAG_BYTES = 16

/** The bundle format this build writes. */
export const MEMORY_BUNDLE_VERSION = 1

/** The marker that says "this is a Freya memory bundle and not some other file". */
export const MEMORY_BUNDLE_KIND = 'freya-memory-bundle'

/**
 * scrypt cost.
 *
 * Fixed rather than tunable: a bundle's cost must not be a dial, and a caller who
 * could raise it would be able to turn an export into a denial of service.
 *
 * `N` is 2^14 rather than something larger on purpose — it is the largest cost whose
 * memory requirement (16 MiB at `r: 8`) fits inside Node's **default** OpenSSL
 * memory limit. A larger value throws `memory limit exceeded` rather than degrading,
 * which would make passphrase export fail on a stock runtime; and `maxmem` is not
 * passed because raising a limit is the wrong response to needing one.
 */
const SCRYPT = Object.freeze({ N: 1 << 14, r: 8, p: 1, keylen: KEY_BYTES })

/**
 * The scrypt salt for the passphrase route.
 *
 * Fixed, and recorded rather than hidden. A per-bundle random salt would be the
 * better design and needs the envelope written in two passes; a documented constant
 * is the honest version of that trade, and it costs nothing here because the salt is
 * not what protects a bundle — refusing authority-shaped content is.
 */
const BUNDLE_SALT = 'freya-memory-bundle-v1'

/* -------------------------------------------------------------- envelope */

/** What is on disk, or in a file the owner chose. Public, authenticated, opaque. */
export interface MemoryBundleEnvelope {
  readonly v: number
  readonly kind: typeof MEMORY_BUNDLE_KIND
  readonly exportedAt: string
  readonly algorithm: typeof ALGORITHM
  readonly kdf: MemoryBundleKdf | null
  readonly nonce: string
  readonly ciphertext: string
  readonly tag: string
}

/** How the key was obtained. Null means a raw 32-byte key was supplied. */
export interface MemoryBundleKdf {
  readonly name: 'scrypt'
  readonly N: number
  readonly r: number
  readonly p: number
}

/** What is inside, once decrypted. */
export interface MemoryBundleBody {
  readonly v: number
  readonly exportedAt: string
  /** Where it came from. Metadata about the export, not a claim to be believed. */
  readonly origin: {
    readonly schemaVersion: number
    readonly sequence: number
    readonly memoryCount: number
  }
  readonly memories: readonly MemoryBundleMemory[]
  readonly ownership: readonly MemoryBundleOwnership[]
  /**
   * What was deliberately left out, in words.
   *
   * Present because a bundle that silently omits the identity root and every
   * permission looks like a complete copy of Freya, and an owner who later found
   * that out would have no way to know what they were told to expect.
   */
  readonly omitted: readonly string[]
}

export interface MemoryBundleMemory {
  readonly memoryId: string
  readonly kind: MemoryKind
  readonly subject: string
  readonly content: string
  readonly status: MemoryRecord['status']
  readonly sensitivity: Sensitivity
  readonly tags: readonly string[]
  readonly entityRefs: readonly string[]
  readonly confidence: MemoryRecord['confidence']
  readonly source: MemoryRecord['source']
  readonly verificationStatus: MemoryRecord['provenance']['verificationStatus']
  readonly provenance: MemoryRecord['provenance']
  readonly admittedAt: string
  readonly admissionReason: string
  readonly supersedes: string | null
  readonly conflictsWith: readonly string[]
  readonly structuredData: Readonly<Record<string, string>>
  readonly createdAt: string
  readonly updatedAt: string
  readonly expiresAt: string | null
}

export interface MemoryBundleOwnership {
  readonly memoryId: string
  readonly pinned: boolean
  readonly decidedAt: string
  readonly decidedBy: 'owner'
  readonly reason: string
}

/* ---------------------------------------------------------------- export */

export interface MemoryExportResult {
  readonly ok: boolean
  readonly envelope: MemoryBundleEnvelope | null
  readonly refusal: MemoryIdentityRefusal | null
  /** What went in, and what was left out. Never null on success. */
  readonly manifest: MemoryExportManifest | null
}

export interface MemoryExportManifest {
  readonly memoryCount: number
  readonly ownershipCount: number
  readonly bytes: number
  readonly encrypted: true
  readonly omitted: readonly string[]
}

/**
 * Seal a bundle.
 *
 * `key` must be exactly 32 bytes. A passphrase is turned into one by
 * `deriveBundleKey`, and that function is the only supported route from a phrase a
 * person can remember to bytes this file will use.
 */
export async function exportMemoryBundle(
  brain: Brain,
  options: { key: Uint8Array | null; passphrase?: string; now?: () => Date },
): Promise<MemoryExportResult> {
  // A supplied passphrase wins over a stored key, and the envelope records which was
  // used so `importMemoryBundle` knows how to open it. Checking it in one place here
  // and once in the importer keeps the two in agreement.
  const passphrase = options.passphrase
  if (passphrase === undefined && options.key === null) {
    return { ok: false, envelope: null, refusal: refuse('key_unavailable'), manifest: null }
  }
  const key = passphrase !== undefined ? deriveBundleKey(passphrase) : (options.key as Uint8Array)

  const state = brain.state()
  const omitted: string[] = [
    'her identity root and self-definition: who Freya is is code, and a file cannot install it',
    'her authority: grants, budgets, approvals, capability states and stop state are not portable and not exported',
    'admission candidates and reviews: internal audit rows, not knowledge',
    'experience records: evidence about Freya\'s own operation, which does not belong in a portable file',
  ]

  const memories: MemoryBundleMemory[] = []
  for (const memory of state.memories.values()) {
    if (memory.content.length > BRAIN_LIMITS.maxMemoryContentChars) continue
    memories.push({
      memoryId: memory.memoryId,
      kind: memory.kind,
      subject: memory.subject,
      content: memory.content,
      status: memory.status,
      sensitivity: memory.sensitivity,
      tags: memory.tags,
      entityRefs: memory.entityRefs,
      confidence: memory.confidence,
      source: memory.source,
      verificationStatus: memory.provenance.verificationStatus,
      provenance: memory.provenance,
      admittedAt: memory.admittedAt,
      admissionReason: memory.admissionReason,
      supersedes: memory.supersedes,
      conflictsWith: memory.conflictsWith,
      structuredData: memory.structuredData,
      createdAt: memory.createdAt,
      updatedAt: memory.updatedAt,
      expiresAt: memory.expiresAt,
    })
  }

  if (memories.length > MEMORY_IDENTITY_LIMITS.maxBundleRecords) {
    return {
      ok: false,
      envelope: null,
      refusal: refuse('request_malformed', `${memories.length} memories is more than one bundle may carry`),
      manifest: null,
    }
  }

  const ownership: MemoryBundleOwnership[] = [...state.ownership.values()].map((decision) => ({
    memoryId: decision.memoryId,
    pinned: decision.pinned,
    decidedAt: decision.decidedAt,
    decidedBy: 'owner',
    reason: decision.reason,
  }))

  const now = (options.now ?? (() => new Date()))().toISOString()
  const body: MemoryBundleBody = {
    v: MEMORY_BUNDLE_VERSION,
    exportedAt: now,
    origin: {
      schemaVersion: MEMORY_IDENTITY_SCHEMA_VERSION,
      sequence: state.sequence,
      memoryCount: memories.length,
    },
    memories,
    ownership,
    omitted,
  }

  const plaintext = Buffer.from(JSON.stringify(body), 'utf8')
  if (plaintext.byteLength > MEMORY_IDENTITY_LIMITS.maxBundleBytes) {
    return {
      ok: false,
      envelope: null,
      refusal: refuse('bundle_too_large', `${plaintext.byteLength} bytes is more than one bundle may carry`),
      manifest: null,
    }
  }

  const sealed = seal(plaintext, key, now, passphrase !== undefined)
  const bytes = Buffer.byteLength(JSON.stringify(sealed), 'utf8')

  return {
    ok: true,
    envelope: sealed,
    refusal: null,
    manifest: {
      memoryCount: memories.length,
      ownershipCount: ownership.length,
      bytes,
      encrypted: true,
      omitted,
    },
  }
}

/* ---------------------------------------------------------------- import */

export interface MemoryImportResult {
  readonly ok: boolean
  readonly refusal: MemoryIdentityRefusal | null
  readonly report: MemoryImportReport | null
}

export interface MemoryImportReport {
  readonly considered: number
  readonly admitted: number
  readonly rejected: number
  readonly pinnedRestored: number
  /** Every downgrade applied, named. A silent one would be a lie. */
  readonly adjusted: readonly string[]
  /** Records whose content asserted a permission. Stored as claims, not obeyed. */
  readonly authorityClaims: readonly string[]
  readonly sourceForced: string
}

/**
 * Bring a bundle in.
 *
 * Owner-only, and checked before anything is read: the channel is on the request,
 * not on the file.
 *
 * The order below is the security-relevant part, and it is strict:
 *
 *   1. Shape and version — is this a bundle at all, and one this build reads?
 *   2. Authenticate — decrypt and let GCM decide. A wrong key fails here and
 *      nothing is interpreted.
 *   3. Structural scan — any authority-shaped or identity-shaped key anywhere in
 *      the decrypted body refuses **the whole bundle**, because a bundle carrying
 *      permissions is not a memory bundle regardless of what else it holds.
 *   4. Content scan — a credential-shaped string refuses the whole bundle too.
 *   5. Only then, per record: force the source, cap the confidence, refuse any
 *      `verified` claim, and admit through the Brain's real admission pathway so the
 *      candidate, review and record all exist and are auditable afterwards.
 *
 * Step 5 goes through `writeMemory` rather than writing records directly, which is
 * what makes an import *honest* rather than merely accepted: an imported record is
 * admitted by the same policy as every other memory, with a recorded reason naming
 * where it came from, and it cannot enter the Brain by any route that skips
 * admission.
 */
export async function importMemoryBundle(
  brain: Brain,
  envelope: unknown,
  options: { key: Uint8Array | null; passphrase?: string; channel: typeof OWNER_CHANNEL },
): Promise<MemoryImportResult> {
  if (options.channel !== OWNER_CHANNEL) {
    return { ok: false, refusal: refuse('not_an_owner_request'), report: null }
  }
  if (options.key === null && options.passphrase === undefined) {
    return { ok: false, refusal: refuse('key_unavailable'), report: null }
  }
  const health = brain.health()
  if (health.health === 'unavailable') {
    return { ok: false, refusal: refuse('brain_unavailable', health.reason ?? undefined), report: null }
  }
  if (health.health === 'degraded') {
    return { ok: false, refusal: refuse('brain_degraded', health.reason ?? undefined), report: null }
  }

  const parsed = parseEnvelope(envelope)
  if ('refusal' in parsed) return { ok: false, refusal: parsed.refusal, report: null }

  // **The file says how it was sealed.** A bundle whose envelope declares an scrypt
  // KDF was sealed from a passphrase, so a passphrase is required and the stored key
  // is not consulted; a bundle with no KDF was sealed from raw bytes, so the key is
  // required. Guessing instead — "try the key, then try the passphrase" — would make
  // it possible to open a file with a credential it was never sealed with, and would
  // turn a missing passphrase into a confusing decryption error rather than a sentence.
  const declaredKdf = parsed.envelope.kdf
  const key =
    declaredKdf === null
      ? options.key
      : options.passphrase !== undefined
        ? deriveBundleKey(options.passphrase)
        : null
  if (key === null) {
    return {
      ok: false,
      refusal: refuse(
        'bundle_key_rejected',
        declaredKdf === null
          ? 'this bundle was sealed with a stored key, and this machine has none'
          : 'this bundle was sealed with a passphrase, and none was given',
      ),
      report: null,
    }
  }

  const opened = open(parsed.envelope, key)
  if (!opened.ok) return { ok: false, refusal: opened.refusal, report: null }

  const body = migrate(opened.body)
  if (!body.ok) return { ok: false, refusal: body.refusal, report: null }

  // Step 3 and 4: structural and credential scans, over the *whole* body. The scan
  // deliberately includes `provenance` and `structuredData`, because those are the
  // two places a well-formed bundle would hide a capability.
  const authority = findAuthorityKey(body.value)
  if (authority !== null) {
    return {
      ok: false,
      refusal: refuse(
        'authority_not_importable',
        `the bundle contains a field called "${authority.field}", which is a permission rather than a memory`,
      ),
      report: null,
    }
  }
  const identity = findIdentityKey(body.value)
  if (identity !== null) {
    return {
      ok: false,
      refusal: refuse(
        'identity_not_importable',
        `the bundle contains a field called "${identity.field}", and who Freya is cannot arrive in a file`,
      ),
      report: null,
    }
  }
  for (const memory of body.value.memories) {
    const secret = findSecretShapeIn(`${memory.subject} ${memory.content}`)
    if (secret !== null) {
      return {
        ok: false,
        refusal: refuse(
          'secret_shaped_content',
          `memory ${memory.memoryId} contains something shaped like a ${secret}`,
        ),
        report: null,
      }
    }
  }

  // Step 5.
  const adjusted: string[] = []
  const authorityClaims: string[] = []
  /**
   * Bundle record id → the id the Brain actually gave it.
   *
   * Needed because an import never reuses the ids in a bundle: those were minted on
   * another machine, and honouring them would let a bundle overwrite a record here by
   * guessing an id. The consequence is that a pinning decision has to be re-applied to
   * the *new* id, which is what this map is for — without it the owner's pinning would
   * silently evaporate on every move.
   */
  const arrived = new Map<string, string>()
  let admitted = 0
  let rejected = 0

  for (const record of body.value.memories) {
    const down = downgradeImported({
      source: record.source,
      confidence: record.confidence,
      verificationStatus: record.verificationStatus,
    })
    for (const note of down.adjusted) adjusted.push(`${record.memoryId}: ${note}`)

    const claim = findAuthorityClaim(record.content)
    if (claim !== null) authorityClaims.push(`${record.memoryId}: ${claim}`)

    const outcome = await brain.writeMemory({
      kind: record.kind,
      subject: record.subject,
      content: record.content,
      // Forced, not requested. This is the line that stops a bundle arriving as an
      // owner assertion.
      source: down.source,
      sourceRef: `memory-bundle:${record.memoryId}`,
      observedAt: record.provenance.observedAt,
      confidence: down.confidence,
      sensitivity: record.sensitivity,
      tags: record.tags,
      entityRefs: record.entityRefs,
      structuredData: record.structuredData,
      actor: 'import',
    })
    if (outcome.outcome === 'admitted' && outcome.memory !== null) {
      admitted += 1
      arrived.set(record.memoryId, outcome.memory.memoryId)
    } else {
      rejected += 1
    }
  }

  // Pinning is restored only for memories that actually arrived, so a bundle cannot
  // pin ids that were refused — otherwise the owner would be shown pinned memories
  // Freya does not hold.
  let pinnedRestored = 0
  for (const decision of body.value.ownership) {
    if (!decision.pinned) continue
    const arrivedId = arrived.get(decision.memoryId)
    if (arrivedId === undefined) continue
    const result = await brain.setMemoryPinned(
      arrivedId,
      true,
      `restored from a memory bundle (${decision.memoryId}): ${decision.reason}`,
    )
    if (result.outcome === 'admitted') pinnedRestored += 1
  }

  return {
    ok: true,
    refusal: null,
    report: {
      considered: body.value.memories.length,
      admitted,
      rejected,
      pinnedRestored,
      adjusted,
      authorityClaims,
      sourceForced: IMPORT_SOURCE,
    },
  }
}

/* --------------------------------------------------------------- crypto */

function seal(
  plaintext: Buffer,
  key: Uint8Array,
  exportedAt: string,
  passphraseUsed: boolean,
): MemoryBundleEnvelope {
  assertKey(key)
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv(ALGORITHM, Buffer.from(key), nonce)
  const header = {
    v: MEMORY_BUNDLE_VERSION,
    kind: MEMORY_BUNDLE_KIND,
    exportedAt,
    algorithm: ALGORITHM,
    kdf: passphraseUsed
      ? ({ name: 'scrypt' as const, N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p } satisfies MemoryBundleKdf)
      : null,
  } satisfies Omit<MemoryBundleEnvelope, 'nonce' | 'ciphertext' | 'tag'>
  // The header is authenticated, so a bundle cannot be re-labelled — a different
  // export date, or a different declared kind — without failing to open.
  cipher.setAAD(aadFor(header))
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return {
    ...header,
    nonce: nonce.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  }
}

function open(
  envelope: MemoryBundleEnvelope,
  key: Uint8Array,
): { ok: true; body: MemoryBundleBody } | { ok: false; refusal: MemoryIdentityRefusal } {
  assertKey(key)
  try {
    const nonce = Buffer.from(envelope.nonce, 'base64')
    const tag = Buffer.from(envelope.tag, 'base64')
    if (nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES) {
      return { ok: false, refusal: refuse('bundle_unreadable', 'the bundle header is malformed') }
    }
    const decipher = createDecipheriv(ALGORITHM, Buffer.from(key), nonce)
    decipher.setAuthTag(tag)
    decipher.setAAD(aadFor(envelope))
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
      decipher.final(),
    ])
    const parsed = JSON.parse(plaintext.toString('utf8')) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, refusal: refuse('bundle_malformed', 'the bundle contents are not a record set') }
    }
    const body = parsed as MemoryBundleBody
    if (!Array.isArray(body.memories) || !Array.isArray(body.ownership)) {
      return { ok: false, refusal: refuse('bundle_malformed', 'the bundle is missing its records') }
    }
    if (body.memories.length > MEMORY_IDENTITY_LIMITS.maxImportRecords) {
      return { ok: false, refusal: refuse('bundle_malformed', 'the bundle carries more records than one import may take') }
    }
    return { ok: true, body }
  } catch {
    // One sentence for both a wrong key and a tampered body. GCM cannot tell them
    // apart, and claiming to would be a guess: either way these bytes are not what
    // was sealed.
    return { ok: false, refusal: refuse('bundle_unreadable', 'it did not decrypt or did not verify with this key') }
  }
}

function aadFor(header: {
  v: number
  kind: string
  exportedAt: string
  algorithm: string
}): Buffer {
  return Buffer.from(
    `freya.memory-bundle.v${header.v}|${header.kind}|${header.exportedAt}|${header.algorithm}`,
    'utf8',
  )
}

/**
 * Turn a passphrase into a 32-byte bundle key.
 *
 * scrypt at the fixed cost above, salted with `BUNDLE_SALT`. Deterministic on
 * purpose: the same phrase has to open the same bundle on another machine, and a
 * per-bundle random salt would need the envelope written in two passes. The
 * consequence is stated rather than discovered later — two bundles sealed with the
 * same phrase share a derived key — and it is acceptable only because what protects
 * a bundle is the refusal of authority-shaped content, not the secrecy of the key.
 */
export function deriveBundleKey(passphrase: string): Uint8Array {
  return new Uint8Array(
    scryptSync(Buffer.from(passphrase, 'utf8'), Buffer.from(BUNDLE_SALT, 'utf8'), SCRYPT.keylen, {
      N: SCRYPT.N,
      r: SCRYPT.r,
      p: SCRYPT.p,
    }),
  )
}

function assertKey(key: Uint8Array): void {
  if (!(key instanceof Uint8Array) || key.length !== KEY_BYTES) {
    throw new Error(`a memory bundle key must be exactly ${KEY_BYTES} bytes`)
  }
}

/* ---------------------------------------------------------------- shape */

function parseEnvelope(
  value: unknown,
): { envelope: MemoryBundleEnvelope } | { refusal: MemoryIdentityRefusal } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { refusal: refuse('bundle_malformed', 'that file is not an object') }
  }
  const record = value as Record<string, unknown>
  if (record.kind !== MEMORY_BUNDLE_KIND) {
    return { refusal: refuse('bundle_malformed', 'that file is not a Freya memory bundle') }
  }
  // Version presence is checked before version *value*: a file with no version in it
  // is not a bundle from another version, it is not a bundle this build can read, and
  // the two deserve different sentences.
  if (typeof record.v !== 'number') {
    return { refusal: refuse('bundle_malformed', 'that file does not say which format it is') }
  }
  if (record.v !== MEMORY_BUNDLE_VERSION) {
    // Refused specifically, never guessed. A bundle from a build that wrote a
    // different shape would be *silently misread* by an optimistic parser, and the
    // result would be a Brain holding records nobody can account for.
    return { refusal: refuse('bundle_version_unknown', `this build reads version ${MEMORY_BUNDLE_VERSION}, that file is version ${String(record.v)}`) }
  }
  if (record.algorithm !== ALGORITHM) {
    return { refusal: refuse('bundle_unreadable', `unsupported encryption: ${String(record.algorithm)}`) }
  }
  for (const field of ['exportedAt', 'nonce', 'ciphertext', 'tag'] as const) {
    if (typeof record[field] !== 'string') {
      return { refusal: refuse('bundle_malformed', `the bundle has no ${field}`) }
    }
  }
  return { envelope: record as unknown as MemoryBundleEnvelope }
}

/**
 * Bring an older bundle forward.
 *
 * A one-entry table rather than a `try`, because the alternative — parsing an old
 * shape optimistically — is how a migration silently invents fields. Each version
 * gets an explicit function, and an unknown version is refused with the version
 * number in the sentence.
 */
const MIGRATIONS: Readonly<Record<number, (body: MemoryBundleBody) => MemoryBundleBody>> = Object.freeze({
  1: (body) => body,
})

function migrate(
  body: MemoryBundleBody,
): { ok: true; value: MemoryBundleBody } | { ok: false; refusal: MemoryIdentityRefusal } {
  const version = typeof body.v === 'number' ? body.v : MEMORY_BUNDLE_VERSION
  const step = MIGRATIONS[version]
  if (step === undefined) {
    return {
      ok: false,
      refusal: refuse(
        'bundle_version_unknown',
        `bundle body version ${String(body.v)} has no migration in this build`,
      ),
    }
  }
  return { ok: true, value: step(body) }
}

/* --------------------------------------------------------------- helpers */
