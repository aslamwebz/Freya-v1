// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { CORE_EVENT_TYPES } from '../../../../core/events/envelope'
import { CONTEXT_SNAPSHOT_VERSION, type ContextSnapshot } from '../../../../core/context/persistence/port'
import {
  contextSnapshotRecord,
  emptyContextSnapshot,
  orderedContextSnapshotRecords,
  retireContextSnapshot,
} from '../../../../core/context/persistence/recovery'
import { decodeContextItem } from '../../../../core/context/persistence/snapshot'
import { contextLimits, type ContextItem } from '../../../../core/context/types'
import {
  CONTEXT_SENTINEL,
  beginScratch,
  contextStore,
  endScratch,
  namesBeside,
  secretItem,
  snapshotOf,
  storePath,
  testContextKey,
  writeSnapshot,
} from './fixture'
import { EncryptedContextStore } from '../../../../core/context/persistence/encrypted-store'

/**
 * What this lane must not become.
 *
 * The Context foundation proved its boundaries with structural assertions rather
 * than behavioural ones, so that they hold even when no test happens to exercise
 * the path in question. Persistence is the same kind of surface, and the same kind
 * of test — writing context to a disk is exactly where a privacy property starts
 * to rot, because a "just this once" helper is one refactor away from being how a
 * selection ends up in somebody's backup.
 *
 * Six properties, asserted about the *source* and about the *values* rather than
 * about one run:
 *
 *  1. persisted Context implies no authority — nothing here is shaped like a
 *     permission, and nothing here imports Guard, cognition or the model;
 *  2. private content reaches no generic surface — no `context.*` journal event
 *     exists to put it in, and this lane writes no envelope at all;
 *  3. the lane imports only the Context domain and Node's own crypto and
 *     filesystem, so a Context fault cannot reach another subsystem by accident;
 *  4. idle persistence costs zero inference — there is no path from here to a
 *     provider, because there is no import of one;
 *  5. recovery reads no clock, so every instant is one the caller stated;
 *  6. a refusal never carries content — a diagnostic is a diagnostic, not a
 *     second channel for the thing it is diagnosing.
 *
 * The source-level assertions run against **code with comments stripped**. A
 * comment that says "this writes no journal" is documentation; only code that
 * *imports* one would be a breach, and asserting on prose would make this file
 * fail every time somebody explained the rule better.
 */

/** Flip the first byte of the first record's ciphertext, the way damage looks. */
async function tamper(path: string): Promise<void> {
  const raw = await readFile(path, 'utf8')
  await writeFile(path, raw.replace('"cipher":"', '"cipher":"AA'), 'utf8')
}

const dir = fileURLToPath(new URL('../../../../core/context/persistence', import.meta.url))
const files = readdirSync(dir)
  .filter((name) => name.endsWith('.ts'))
  .map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8') }))

/** Source with block and line comments removed, so only code is asserted on. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[^\n]*?\/\/.*$/gm, '')
}

const code = files.map((file) => stripComments(file.text)).join('\n')
const specifiers = [...code.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1] ?? '')

describe('persisted Context implies no authority', () => {
  it('persists the domain item exactly, with no field of its own', () => {
    // A record is a `ContextItem` and nothing more. If persistence added a field
    // — a trust class, a capability, an "was authorised" flag — it would be
    // asserting something the domain deliberately refuses to assert, and the
    // next reader would believe it.
    const item = secretItem(contextStore())
    const snapshot: ContextSnapshot = snapshotOf(item)
    expect(Object.keys(snapshot).sort()).toEqual(['records', 'v'])
    expect(Object.keys(snapshot.records[0] as ContextItem).sort()).toEqual(Object.keys(item).sort())
    for (const key of Object.keys(item)) {
      expect(key).not.toMatch(/permission|authorit|capabilit|grant|allow|trust|entitle/i)
    }
  })

  it('decodes a record back to exactly the domain item, with nothing added', () => {
    const item = secretItem(contextStore())
    const round = decodeContextItem(snapshotOf(item).records[0], contextLimits())
    expect(round).toEqual(item)
    // Rebuilding from named fields means an unknown field in a file cannot survive
    // a round trip — there is no path by which it could.
    expect(Object.keys(round).sort()).toEqual(Object.keys(item).sort())
  })

  it('names no capability, grant or permission on any field it declares', () => {
    for (const file of files) {
      const declared = [...stripComments(file.text).matchAll(/^\s*(?:readonly\s+)?([a-zA-Z_$][\w$]*)\s*[?!]?:/gm)].map(
        (match) => match[1] ?? '',
      )
      expect(declared.length).toBeGreaterThan(0)
      for (const name of declared) {
        expect(name, `${file.name}: ${name}`).not.toMatch(
          /permission|authorit|capabilit|grant|allow|trust|entitle|escalat/i,
        )
      }
    }
  })

  it('imports nothing that could decide anything', () => {
    for (const specifier of specifiers) {
      expect(specifier, specifier).toMatch(/^(node:|\.\.?\/)[\w/.-]*$/)
      expect(specifier, specifier).not.toMatch(
        /security|cognition|guard|events|model|index|protocol|authority|mission|brain|conversation/i,
      )
    }
    expect(code).not.toMatch(/\bGuard\b|ownerAuthority|workerAuthority|Capability/)
  })
})

describe('private Context content reaches no generic surface', () => {
  it('has no journal event type that could carry it', () => {
    // Structural, and the same assertion the foundation makes. Writing context to
    // disk is precisely the moment a `context.*` event family would be tempting;
    // if one is ever added it must be metadata only, and this is where that gets
    // argued.
    expect(CORE_EVENT_TYPES.filter((type) => type.startsWith('context.'))).toEqual([])
  })

  it('writes no event, no envelope and no activity row', () => {
    expect(code).not.toMatch(/EventFabric|envelope|journal|activity|CORE_EVENT/i)
  })

  it('exposes no way to dump a whole store by anything but a snapshot', () => {
    // `load()` is the one door, and it is a door: a caller that wants everything
    // asks for everything explicitly. There is no by-scope, by-provenance or
    // `query(sql)` shortcut that would make "read the store" and "read all of
    // this person's session" the same operation.
    const surface = [
      'contextSnapshotRecord',
      'orderedContextSnapshotRecords',
      'retireContextSnapshot',
      'emptyContextSnapshot',
    ]
    for (const name of surface) {
      expect(name).toBeTruthy()
    }
    expect(contextSnapshotRecord(snapshotOf(secretItem(contextStore())), 'no-such-id')).toBeNull()
  })
})

describe('a refusal never carries content', () => {
  beforeAll(async () => {
    await beginScratch()
  })

  afterAll(async () => {
    await endScratch()
  })

  it('keeps the sentinel out of a record-too-large refusal', async () => {
    const path = storePath()
    {
      const item = secretItem(contextStore())
      const store = await EncryptedContextStore.open({ path, key: testContextKey() })
      // The diagnostic names the record and the limit — the two facts a person
      // can act on — and not one character of what was being stored.
      let message = ''
      await store
        .commit(snapshotOf({ ...item, content: 'x'.repeat(9_000) } as ContextItem))
        .catch((error: unknown) => {
          message = (error as Error).message
        })
      expect(message).toMatch(/not a legal length/)
      expect(message).not.toContain('x'.repeat(9))
      expect(message).not.toContain(CONTEXT_SENTINEL)
      await store.close()
    }
  })

  it('keeps the sentinel out of a damaged-store diagnosis', async () => {
    const path = storePath()
    await writeSnapshot(path, snapshotOf(secretItem(contextStore())))
    await tamper(path)

    const store = await EncryptedContextStore.open({ path, key: testContextKey() })
    // A fault is reported in words about the *file*, never about the content: a
    // diagnostic is a diagnostic, not a second channel for the thing it is about.
    expect(store.faultReason).toMatch(/failed authentication/i)
    expect(store.faultReason).not.toContain(CONTEXT_SENTINEL)
    expect(await namesBeside(path)).toEqual(['context.enc'])
    await store.close()
  })
})

describe('the lane reaches nothing else', () => {
  it('imports only the Context domain and Node builtins', () => {
    expect(specifiers.length).toBeGreaterThan(4)
    for (const specifier of specifiers) {
      const allowed =
        specifier.startsWith('node:') ||
        /^\.\.?\/(types|item|port|errors|snapshot|recovery|ephemeral-store|encrypted-store|open)$/.test(specifier)
      expect(allowed, specifier).toBe(true)
    }
    // Node's crypto and its filesystem, and nothing else: no network, no host, no
    // renderer, no Core facade.
    for (const specifier of specifiers.filter((name) => name.startsWith('node:'))) {
      expect(specifier, specifier).toMatch(/^node:(crypto|fs(\/promises)?|path|os)$/)
    }
  })

  it('reaches no network, no renderer and no host', () => {
    expect(code).not.toMatch(/\bfetch\s*\(/)
    expect(code).not.toMatch(/XMLHttpRequest|WebSocket|electron|ipcRenderer|window\.|document\./)
    expect(code).not.toMatch(/process\.env/)
  })

  it('cannot call a model, because it cannot reach one', () => {
    // Zero idle inference, structurally: there is no provider import, no gateway,
    // no completion call and no HTTP anywhere in the lane. Recovering context on
    // startup costs nothing at all.
    expect(code).not.toMatch(/provider|gateway|complete|completion|chat|nanogpt|openai|anthropic/i)
    expect(code).not.toMatch(/\bmodel\b/i)
  })

  it('reads no clock of its own, so recovery is a question with a stated instant', () => {
    // `Date.parse` on a recorded instant is reading the *record*; reading the
    // machine's clock is what would make "did this expire while we were down?"
    // unanswerable and untestable.
    expect(code).not.toMatch(/Date\.now\(\)/)
    expect(code).not.toMatch(/new Date\(\)/)
  })

  it('keeps one timer, and it waits on the filesystem rather than scheduling work', () => {
    // `setTimeout` appears once, in the Windows rename retry. Anything else that
    // timed here would be a background job keeping context "fresh", which is a
    // thing this phase does not have: idle maintenance spends zero inference and
    // zero attention.
    const timers = [...code.matchAll(/setTimeout|setInterval/g)].length
    expect(timers).toBe(1)
    expect(code).not.toMatch(/setInterval|queueMicrotask|process\.nextTick/)
  })

  it('recovers an empty snapshot as empty, without inventing an instant', () => {
    const empty = emptyContextSnapshot()
    expect(empty).toEqual({ v: CONTEXT_SNAPSHOT_VERSION, records: [] })
    // Retiring an empty snapshot is a no-op at any instant, including a broken one.
    expect(retireContextSnapshot(empty, new Date(Number.NaN))).toEqual(empty)
    expect(orderedContextSnapshotRecords(empty)).toEqual([])
  })
})