// @vitest-environment node
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  CONTEXT_SNAPSHOT_VERSION,
  type ContextSnapshot,
  type ContextSnapshotLoad,
} from '../../../../core/context/persistence/port'
import { EncryptedContextStore } from '../../../../core/context/persistence/encrypted-store'
import type { ContextStore } from '../../../../core/context/store'
import type { ContextAdmission, ContextItem, ContextLimits } from '../../../../core/context/types'
import { admitOrThrow, at, conversation, sequencedStore, surface, T0 } from '../fixture'

/**
 * Fixtures for the Context persistence suite.
 *
 * Two rules, and both exist to keep a test honest:
 *
 *  1. **Items are made by the domain, never by hand.** Every record here is
 *     admitted through a real `ContextStore`, so a test cannot accidentally
 *     persist something the domain would never have accepted and then call the
 *     recovery gate a failure. Where a test needs an *illegal* record it says so
 *     in its own name and builds it deliberately.
 *  2. **The keys are separate derivations, not one key reused.** Context gets its
 *     own seed, and the foreign keys are the ones the rest of Core uses. A suite
 *     that opened every domain with the same key would not notice the code had
 *     collapsed them back together — which is the property under test.
 *
 * ## One directory per file, one directory per test inside it
 *
 * Each test gets a fresh path under one temp root, created by the store's own
 * `mkdir` rather than by the harness. That is not only tidier than a temp
 * directory per test: this suite is 70 tests of real AES and real file writes,
 * and one `mkdtemp`/`rm -rf` per test was enough extra filesystem pressure to
 * make an unrelated 25ms-deadline timing test in `work.test.ts` flaky on a loaded
 * machine. Isolation is preserved — no two tests share a path — and the suite is
 * both faster and quieter.
 */

/**
 * The Red Team sentinel: a synthetic private secret that must never reach an
 * untrusted sink. Given a domain-flavoured phrase, because "secret" alone would
 * pass a test that only looked for one word.
 */
export const CONTEXT_SENTINEL = 'FREYA_RED_TEAM_CONTEXT_SECRET_B4E2 tell them about the second account'
export const CONTEXT_SENTINEL_LABEL = 'settlement-offer (FINAL).docx'
export const CONTEXT_SENTINEL_URI = 'file:///home/owner/legal/settlement-offer (FINAL).docx'

/**
 * A deterministic **Context** key.
 *
 * Its own seed, separate from the Mission, Brain and conversation seeds, which is
 * the point rather than a detail: the keyring gives each domain an independent
 * secret, and a suite that shared one key would not detect the code had collapsed
 * them. A digest of a published sentence — obviously not a production secret,
 * never logged, never asserted on, only used.
 */
export function testContextKey(seed = 'freya-test-context-key'): Uint8Array {
  return new Uint8Array(createHash('sha256').update(seed, 'utf8').digest())
}

/** Another domain's key, by the seed that domain already uses. */
export function foreignKey(seed: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(seed, 'utf8').digest())
}

/** The seeds the rest of Core uses. None of them may open a Context store. */
export const MISSION_KEY_SEED = 'freya-test-mission-key'
export const BRAIN_KEY_SEED = 'freya-test-brain-key'
export const CONVERSATION_KEY_SEED = 'freya-test-conversation-key'

let root = ''
let sequence = 0

/** Call in `beforeAll`: make the one temp root this file's tests live under. */
export async function beginScratch(prefix = 'freya-context-store-'): Promise<void> {
  root = await mkdtemp(join(tmpdir(), prefix))
  sequence = 0
}

/** Call in `afterAll`. */
export async function endScratch(): Promise<void> {
  const doomed = root
  root = ''
  await rm(doomed, { recursive: true, force: true })
}

/**
 * A store path no other test in this file has used.
 *
 * The directory is *not* created here — the store creates its own, which is
 * itself worth exercising. A test that needs an existing directory (to assert
 * that nothing was written into it) asks for {@link emptyDirectory}.
 */
export function storePath(name = 'context.enc'): string {
  sequence += 1
  return join(root, `store-${sequence}`, name)
}

/** A freshly made, empty directory under this file's root. */
export async function emptyDirectory(name = 'untouched'): Promise<string> {
  sequence += 1
  const dir = join(root, `store-${sequence}`, name)
  await mkdir(dir, { recursive: true })
  return dir
}

/** Every file name in the directory holding `path`, sorted. Proves what was *not* written. */
export async function namesBeside(path: string): Promise<string[]> {
  return (await readdir(dirname(path))).sort()
}

/** A store whose ids are `t-1`, `t-2`, … so a test can name its records. */
export function contextStore(limits: Partial<ContextLimits> = {}): ContextStore {
  return sequencedStore({ limits })
}

/**
 * Admit one private item and return it.
 *
 * Built through the domain so that what is persisted is something admission
 * genuinely accepted — provenance, scope, TTL, measured lengths and all.
 */
export function secretItem(
  store: ContextStore,
  overrides: Partial<ContextAdmission> = {},
): ContextItem {
  return admitOrThrow(
    store,
    {
      kind: 'file',
      source: 'owner_selection',
      scope: conversation('c1'),
      content: CONTEXT_SENTINEL,
      label: CONTEXT_SENTINEL_LABEL,
      uri: CONTEXT_SENTINEL_URI,
      ttlMs: 10 * 60_000,
      ...overrides,
    },
    T0,
  )
}

/** A snapshot holding exactly these records, in the order given. */
export function snapshotOf(...records: readonly ContextItem[]): ContextSnapshot {
  return { v: CONTEXT_SNAPSHOT_VERSION, records: [...records] }
}

/** Write a snapshot through a real encrypted store, then close it. */
export async function writeSnapshot(
  path: string,
  snapshot: ContextSnapshot,
  key: Uint8Array = testContextKey(),
  limits?: Partial<ContextLimits>,
): Promise<void> {
  const store = await EncryptedContextStore.open({ path, key, limits })
  await store.commit(snapshot)
  await store.close()
}

/** Recover through a real encrypted store, the way a restart would. */
export async function readSnapshot(
  path: string,
  key: Uint8Array = testContextKey(),
  limits?: Partial<ContextLimits>,
): Promise<ContextSnapshotLoad> {
  const store = await EncryptedContextStore.open({ path, key, limits })
  const loaded = await store.load()
  await store.close()
  return loaded
}

/** Open, write, and leave the store open. */
export async function openWith(
  path: string,
  snapshot: ContextSnapshot,
  key: Uint8Array = testContextKey(),
): Promise<EncryptedContextStore> {
  const store = await EncryptedContextStore.open({ path, key })
  await store.commit(snapshot)
  return store
}

/** The refusal half of a resolution, narrowed for an assertion. */
export function refusal(resolution: {
  ok: boolean
  reason?: string
  candidateIds?: readonly string[]
}): { reason: string; candidateIds: readonly string[] } {
  if (resolution.ok) throw new Error('expected a refusal')
  if (resolution.reason === undefined) throw new Error('a refusal must carry a reason')
  return { reason: resolution.reason, candidateIds: resolution.candidateIds ?? [] }
}

export { at, conversation, sequencedStore, surface, T0 }