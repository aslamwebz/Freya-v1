// @vitest-environment node
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  PERSONALITY_SNAPSHOT_VERSION,
  type PersonalitySnapshot,
  type PersonalitySnapshotLoad,
} from '../../../../core/personality/persistence/port'
import { EncryptedPersonalityStore } from '../../../../core/personality/persistence/encrypted-store'
import {
  admitRelationshipItem,
  createRelationshipCandidate,
} from '../../../../core/personality/relationship'
import { emptyCueLedger } from '../../../../core/personality/repetition'
import type { RelationshipItem } from '../../../../core/personality/types'

/**
 * Fixtures for the Personality persistence suite.
 *
 * Two rules, and both exist to keep a test honest:
 *
 *  1. **Items are made by the domain, never by hand.** Every record here is
 *     admitted through the real relationship admission pathway, so a test
 *     cannot accidentally persist something the domain would never have
 *     accepted and then call the recovery gate a failure.
 *  2. **The keys are separate derivations, not one key reused.** Personality
 *     gets its own seed, and the foreign keys are the ones the rest of Core
 *     uses.
 */

/**
 * The Red Team sentinel: a synthetic private secret that must never reach an
 * untrusted sink.
 */
export const PERSONALITY_SENTINEL = 'FREYA_RED_TEAM_PERSONALITY_SECRET_A7C3 they know about the offshore account'
export const PERSONALITY_SENTINEL_KEY = 'offshore-account'

/**
 * A deterministic **Personality** key.
 */
export function testPersonalityKey(seed = 'freya-test-personality-key'): Uint8Array {
  return new Uint8Array(createHash('sha256').update(seed, 'utf8').digest())
}

/** Another domain's key, by the seed that domain already uses. */
export function foreignKey(seed: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(seed, 'utf8').digest())
}

/** The seeds the rest of Core uses. None of them may open a Personality store. */
export const CONTEXT_KEY_SEED = 'freya-test-context-key'
export const BRAIN_KEY_SEED = 'freya-test-brain-key'
export const CONVERSATION_KEY_SEED = 'freya-test-conversation-key'
export const MISSION_KEY_SEED = 'freya-test-mission-key'

let root = ''
let sequence = 0

/** Call in `beforeAll`: make the one temp root this file's tests live under. */
export async function beginScratch(prefix = 'freya-personality-store-'): Promise<void> {
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
 */
export function storePath(name = 'personality.enc'): string {
  sequence += 1
  return join(root, `store-${sequence}`, name)
}

/** Every file name in the directory holding `path`, sorted. */
export function namesBeside(path: string): Promise<string[]> {
  return readdir(dirname(path)).then((names) => names.sort())
}

/**
 * Create one private relationship item through the domain.
 */
export function secretItem(
  overrides: Partial<Parameters<typeof createRelationshipCandidate>[0]> = {},
  admittedAt = '2026-06-01T09:00:00.000Z',
): RelationshipItem {
  const result = createRelationshipCandidate({
    itemId: `item-${sequence}`,
    kind: 'fact',
    key: PERSONALITY_SENTINEL_KEY,
    text: PERSONALITY_SENTINEL,
    tags: ['finance', 'private'],
    cueKind: null,
    source: 'owner-assertion',
    sourceRef: null,
    observedAt: '2026-06-01T09:00:00.000Z',
    recordedAt: '2026-06-01T09:00:00.000Z',
    proposedConfidence: 'high',
    actor: 'owner',
    ...overrides,
  })
  if (!result.ok) throw new Error(`failed to create item: ${result.reason}`)
  const admitted = admitRelationshipItem(result.item, {
    now: admittedAt,
    reason: 'owner shared this in conversation',
  })
  if (!admitted.ok) throw new Error(`failed to admit item: ${admitted.reason}`)
  return admitted.item
}

/** A snapshot holding exactly these records, in the order given. */
export function snapshotOf(...records: readonly RelationshipItem[]): PersonalitySnapshot {
  return { v: PERSONALITY_SNAPSHOT_VERSION, items: [...records], ledger: emptyCueLedger() }
}

/** Write a snapshot through a real encrypted store, then close it. */
export async function writeSnapshot(
  path: string,
  snapshot: PersonalitySnapshot,
  key: Uint8Array = testPersonalityKey(),
): Promise<void> {
  const store = await EncryptedPersonalityStore.open({ path, key })
  await store.commit(snapshot)
  await store.close()
}

/** Recover through a real encrypted store, the way a restart would. */
export async function readSnapshot(
  path: string,
  key: Uint8Array = testPersonalityKey(),
): Promise<PersonalitySnapshotLoad> {
  const store = await EncryptedPersonalityStore.open({ path, key })
  const loaded = await store.load()
  await store.close()
  return loaded
}

/** Open, write, and leave the store open. */
export async function openWith(
  path: string,
  snapshot: PersonalitySnapshot,
  key: Uint8Array = testPersonalityKey(),
): Promise<EncryptedPersonalityStore> {
  const store = await EncryptedPersonalityStore.open({ path, key })
  await store.commit(snapshot)
  return store
}
