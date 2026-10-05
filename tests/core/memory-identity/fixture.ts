// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Brain, buildIdentityRoot, buildSelfDefinition } from '../../../core/brain/brain'
import { EncryptedBrainStore } from '../../../core/brain/encrypted-store'
import { MemoryBrainStore } from '../../../core/brain/memory-store'
import { EventFabric } from '../../../core/events/fabric'
import { JsonlEventStore } from '../../../core/events/jsonl-store'
import { StaticVaultKeyProvider } from '../../../core/vault/key-provider'
import {
  MEMORY_BUNDLE_KIND,
  MEMORY_BUNDLE_VERSION,
  deriveBundleKey,
} from '../../../core/memory-identity/portability'
import { MemoryIdentity } from '../../../core/memory-identity/subsystem'
import type { MemoryIdentityDomainPorts } from '../../../core/memory-identity/types'
import { testBrainKey } from '../testKey'

/**
 * Fixtures for the unified Memory/Identity suite.
 *
 * Four rules, and each of them exists to stop a test from proving something that
 * production does not do:
 *
 *  1. **Real Brain, real encrypted store.** The subsystem's whole claim is that it
 *     does not keep its own copy, so a test that ran it against a stub would prove
 *     nothing about the store it is supposed to be a façade for. These open a genuine
 *     `EncryptedBrainStore` under a temp directory with an injected 32-byte key.
 *  2. **No model call, ever.** There is no provider in this directory and no way to
 *     add one. A test that needed inference to pass would be testing something this
 *     subsystem must never do.
 *  3. **Identity is seeded the way Core seeds it**, through `buildIdentityRoot` and
 *     `buildSelfDefinition`, so the identity assertions are about the real kernel
 *     rather than a convenient stub.
 *  4. **The Vault key is injected, not generated.** `StaticVaultKeyProvider` with a
 *     published test key is the seam the production host fills from the OS keyring;
 *     it is the only Vault access this suite performs, and a missing key is exercised
 *     as a *state* rather than avoided.
 */

/** A private secret that must never reach a model, a bundle, or the journal. */
export const MEMORY_IDENTITY_SENTINEL = 'FREYA_RED_TEAM_MEMORY_SECRET_D41F offshore account'

let dir = ''
let sequence = 0

export async function beginScratch(): Promise<void> {
  dir = await mkdtemp(join(tmpdir(), 'freya-memory-identity-'))
  sequence = 0
}

export async function endScratch(): Promise<void> {
  const doomed = dir
  dir = ''
  await rm(doomed, { recursive: true, force: true })
}

/** A path no other test in this file has used. */
export function pathFor(name = 'brain.enc'): string {
  sequence += 1
  return join(dir, `store-${sequence}`, name)
}

export interface Harness {
  readonly brain: Brain
  readonly memoryIdentity: MemoryIdentity
  readonly fabric: EventFabric
  readonly brainPath: string
  /** The journal this harness writes to, so a test can read what was recorded. */
  readonly eventsPath: string
  dispose(): Promise<void>
}

export interface HarnessOptions {
  /** Open the Brain on disk. Default true; false gives the ephemeral store. */
  readonly encrypted?: boolean
  /** The bundle key, or null to model a machine with no secure key. */
  readonly bundleKey?: Uint8Array | null
  readonly domains?: MemoryIdentityDomainPorts
  readonly seedIdentity?: boolean
}

/**
 * Build a Brain, seed it as Core would, and wrap it in the subsystem.
 *
 * `bundleKey: null` is a supported and tested state: it must produce refusals for
 * export and import rather than an unencrypted bundle.
 */
export async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const brainPath = pathFor()
  const eventsPath = pathFor('events.jsonl')
  const fabric = await EventFabric.open({ store: await JsonlEventStore.open(eventsPath) })
  const store = options.encrypted === false
    ? new MemoryBrainStore({ mode: 'ephemeral' })
    : await EncryptedBrainStore.open({ path: brainPath, key: testBrainKey() })

  const brain = new Brain({ store, fabric })
  if (options.seedIdentity !== false) {
    await brain.seed({ identity: buildIdentityRoot(), self: buildSelfDefinition() })
  }

  const memoryIdentity = new MemoryIdentity({
    brain,
    domains: options.domains ?? {},
    bundleKey: options.bundleKey === undefined ? testBrainKey('freya-test-memory-bundle-key') : options.bundleKey,
  })

  return {
    brain,
    memoryIdentity,
    fabric,
    brainPath,
    eventsPath,
    dispose: async () => {
      await brain.close()
      await fabric.close()
    },
  }
}

/**
 * A Brain key provider wired the way the production host will wire it.
 *
 * Present so the encrypted path is exercised through the real Vault seam rather than
 * by handing raw bytes to a constructor. `null` is the machine-with-no-key case.
 */
export function keyProvider(key: Uint8Array | null = testBrainKey()): StaticVaultKeyProvider {
  return new StaticVaultKeyProvider(key, key === null ? 'this machine has no secure Freya key' : null)
}

/** Admit one ordinary memory through the real pathway. */
export async function admit(
  harnessRef: Harness,
  overrides: Partial<Parameters<Brain['writeMemory']>[0]> = {},
): Promise<string> {
  const outcome = await harnessRef.brain.writeMemory({
    kind: 'semantic',
    subject: 'the offshore account',
    content: 'the offshore account is held at a bank in Lisbon',
    source: 'owner-assertion',
    sourceRef: null,
    confidence: 'high',
    sensitivity: 'personal',
    ...overrides,
  })
  if (outcome.memory === null) throw new Error(`fixture could not admit a memory: ${outcome.reason}`)
  return outcome.memory.memoryId
}

/** Admit several memories whose subjects and contents are all distinct. */
export async function admitMany(
  harnessRef: Harness,
  specs: readonly { subject: string; content: string }[],
): Promise<string[]> {
  const ids: string[] = []
  for (const spec of specs) {
    ids.push(await admit(harnessRef, { subject: spec.subject, content: spec.content }))
  }
  return ids
}

/**
 * Seal an **arbitrary** body into a structurally valid bundle.
 *
 * This is the attacker's tool, and it exists so the import path can be tested against
 * a bundle no honest export could ever produce. Without it, the only bundles available
 * to a test are ones `exportBundle` made — which would mean testing the import against
 * its own idea of what a bundle is, and proving nothing about a hostile one.
 *
 * It uses the same envelope, the same AAD and the same passphrase KDF as production,
 * so the file this produces decrypts normally and is rejected (or accepted) on its
 * *contents* alone.
 */
export async function sealArbitraryBundle(
  body: unknown,
  passphrase = 'attacker passphrase',
): Promise<Record<string, unknown>> {
  const { createCipheriv, randomBytes } = await import('node:crypto')
  const key = deriveBundleKey(passphrase)
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key), nonce)
  const header = {
    v: MEMORY_BUNDLE_VERSION,
    kind: MEMORY_BUNDLE_KIND,
    exportedAt: '2026-01-01T00:00:00.000Z',
    algorithm: 'aes-256-gcm',
    kdf: { name: 'scrypt', N: 1 << 14, r: 8, p: 1 },
  }
  cipher.setAAD(
    Buffer.from(
      `freya.memory-bundle.v${header.v}|${header.kind}|${header.exportedAt}|${header.algorithm}`,
      'utf8',
    ),
  )
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(body), 'utf8')), cipher.final()])
  return {
    ...header,
    nonce: nonce.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  }
}

/** The passphrase `sealArbitraryBundle` seals with unless told otherwise. */
export const HOSTILE_PASSPHRASE = 'attacker passphrase'

/**
 * A minimal bundle body holding exactly these memories.
 *
 * Deliberately able to assert anything: a caller can pass `verified` confidence, an
 * `owner-assertion` source, or a `structuredData` full of permissions, because those
 * are the shapes the import policy has to survive.
 */
export function bundleBody(
  memories: readonly Record<string, unknown>[],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    v: MEMORY_BUNDLE_VERSION,
    exportedAt: '2026-01-01T00:00:00.000Z',
    origin: { schemaVersion: 1, sequence: 0, memoryCount: memories.length },
    memories,
    ownership: [],
    omitted: [],
    ...overrides,
  }
}

/** One bundle memory, with every field a caller might want to attack with. */
export function bundleMemory(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    memoryId: 'bundle-1',
    kind: 'semantic',
    subject: 'the standing order',
    content: 'the standing order is paid on the first of the month',
    status: 'admitted',
    sensitivity: 'normal',
    tags: [],
    entityRefs: [],
    confidence: 'high',
    source: 'owner-assertion',
    verificationStatus: 'verified',
    provenance: {
      sourceType: 'owner-assertion',
      sourceRef: null,
      observedAt: '2026-01-01T00:00:00.000Z',
      recordedAt: '2026-01-01T00:00:00.000Z',
      actor: 'owner',
      verificationStatus: 'verified',
      confidence: 'verified',
      evidenceSummary: null,
    },
    admittedAt: '2026-01-01T00:00:00.000Z',
    admissionReason: 'the owner said so',
    supersedes: null,
    conflictsWith: [],
    structuredData: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: null,
    ...overrides,
  }
}
