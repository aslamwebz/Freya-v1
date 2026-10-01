// @vitest-environment node
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { EncryptedContextStore } from '../../../../core/context/persistence/encrypted-store'
import { EphemeralContextStore } from '../../../../core/context/persistence/ephemeral-store'
import {
  NO_CONTEXT_KEY_REASON,
  contextPersistenceFaultReason,
  openContextPersistence,
} from '../../../../core/context/persistence/open'
import { ContextPersistenceError } from '../../../../core/context/persistence/errors'
import { emptyContextSnapshot } from '../../../../core/context/persistence/recovery'
import type { ContextPersistencePort } from '../../../../core/context/persistence/port'
import {
  BRAIN_KEY_SEED,
  MISSION_KEY_SEED,
  beginScratch,
  contextStore,
  emptyDirectory,
  endScratch,
  foreignKey,
  secretItem,
  snapshotOf,
  storePath,
  testContextKey,
  writeSnapshot,
} from './fixture'

/**
 * When persistence cannot happen.
 *
 * The requirement is one sentence with two halves, and the halves pull in
 * opposite directions:
 *
 * > **If secure storage is unavailable, remain explicitly ephemeral or
 * > degraded — never write a plaintext fallback — and do not take down unrelated
 * > Core systems.**
 *
 * So: no key, an unreadable path, a wrong key, a damaged file and a closed store
 * must each end in a *stated* state; the encryption store must refuse to serve
 * and refuse to write rather than serve half a history; and nothing here may
 * throw at a caller who only wanted Freya to start.
 */

let path = ''

beforeAll(async () => {
  await beginScratch()
})

beforeEach(() => {
  path = storePath()
})

afterAll(async () => {
  await endScratch()
})

describe('no secure key means explicitly ephemeral, and nothing on disk', () => {
  it('says so in three fields a caller can read without parsing a string', async () => {
    const port = await openContextPersistence({ path, key: null })
    expect(port.mode).toBe('ephemeral')
    expect(port.durable).toBe(false)
    expect(port.durabilityReason).toBe(NO_CONTEXT_KEY_REASON)
    // Not a fault: nothing is broken, this is the mechanism working as designed.
    expect(port.faultReason).toBeNull()
    await port.close()
  })

  it('recovers an empty snapshot rather than claiming a fault', async () => {
    const port = await openContextPersistence({ path, key: null })
    // `ok: true` and empty, because nothing was ever written — so there is
    // nothing to distrust. Reporting `degraded` here would invent a failure.
    expect(await port.load()).toEqual({ ok: true, snapshot: emptyContextSnapshot() })
    await port.close()
  })

  it('writes absolutely nothing, under any name', async () => {
    const dir = await emptyDirectory()
    const port = await openContextPersistence({ path: join(dir, 'context.enc'), key: null })
    await port.commit(snapshotOf(secretItem(contextStore()))).catch(() => undefined)
    await port.close()
    // The whole point. A "fallback" file of somebody's selection is the outcome
    // this lane exists to prevent, so the directory stays empty — not even an
    // empty placeholder.
    expect(await readdir(dir)).toEqual([])
  })

  it('refuses a write rather than resolving quietly', async () => {
    // `commit` returns `Promise<void>`; resolving would be a lie told to a caller
    // that has no way to tell the difference.
    const port = await openContextPersistence({ path, key: null })
    await expect(port.commit(emptyContextSnapshot())).rejects.toThrow(/not being written/i)
    await port.close()
  })

  it('never returns to writing after close', async () => {
    const port = new EphemeralContextStore({ durabilityReason: 'no secure key on this machine' })
    await port.close()
    await expect(port.commit(emptyContextSnapshot())).rejects.toMatchObject({ code: 'unavailable' })
    expect(await port.load()).toMatchObject({ ok: false, code: 'closed' })
  })

  it('states a reason even if it is handed an empty one', () => {
    const port = new EphemeralContextStore({ durabilityReason: '   ' })
    expect(port.durabilityReason).toMatch(/nothing is written to disk/)
  })
})

describe('an unusable path degrades rather than refusing to start', () => {
  it('reports unavailable storage as ephemeral, in words', async () => {
    // A path whose parent is a *file*: no directory can be created there, and no
    // amount of retrying will change that.
    const dir = await emptyDirectory()
    await writeFile(join(dir, 'a-file'), 'not a directory', 'utf8')
    const port = await openContextPersistence({
      path: join(dir, 'a-file', 'context.enc'),
      key: testContextKey(),
    })
    expect(port.mode).toBe('ephemeral')
    expect(port.durable).toBe(false)
    expect(port.durabilityReason).toMatch(/could not be created|could not be read/i)
    // And nothing was written into the place that was supposed to hold it.
    expect(await readFile(join(dir, 'a-file'), 'utf8')).toBe('not a directory')
    await port.close()
  })

  it('throws from the strict entry point, so a host may choose to refuse', async () => {
    const dir = await emptyDirectory()
    await writeFile(join(dir, 'a-file'), 'not a directory', 'utf8')
    await expect(
      EncryptedContextStore.open({ path: join(dir, 'a-file', 'context.enc'), key: testContextKey() }),
    ).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('reads nothing as healthy when the store could not be opened', async () => {
    const port = await openContextPersistence({ path: '/this/does/not/exist/anywhere.enc', key: null })
    expect(port.mode).toBe('ephemeral')
    expect((await port.load()).ok).toBe(true)
    await port.close()
  })
})

describe('a damaged store serves nothing and writes nothing', () => {
  /** A store with two real records, then the file replaced with nonsense. */
  async function damaged(withGarbage: string): Promise<string> {
    const store = contextStore()
    await writeSnapshot(
      path,
      snapshotOf(
        secretItem(store, { content: 'the first selection' }),
        secretItem(store, { content: 'the second selection' }),
      ),
    )
    await writeFile(path, withGarbage, 'utf8')
    return path
  }

  it('refuses to load a file that is not JSON', async () => {
    await damaged('not json at all\n')
    const store = await EncryptedContextStore.open({ path, key: testContextKey() })
    expect(store.faultReason).toMatch(/not valid JSON/i)
    const loaded = await store.load()
    expect(loaded).toMatchObject({ ok: false, code: 'degraded' })
    await store.close()
  })

  it('refuses to load a file whose records belong to another store', async () => {
    const domain = contextStore()
    await writeSnapshot(path, snapshotOf(secretItem(domain, { content: 'a selection' })))
    // Same key, different file: the per-store binding in the AAD is what catches
    // this, so a file lifted from one store into another authenticates nowhere.
    const other = storePath('other.enc')
    await writeSnapshot(other, snapshotOf(secretItem(contextStore(), { content: 'a selection' })))
    await writeFile(path, await readFile(other, 'utf8'))
    const store = await EncryptedContextStore.open({ path, key: testContextKey() })
    expect(store.faultReason).not.toBeNull()
    expect((await store.load()).ok).toBe(false)
    await store.close()
  })

  it('refuses to load with a key that is not this domain\'s', async () => {
    const domain = contextStore()
    await writeSnapshot(path, snapshotOf(secretItem(domain, { content: 'a selection' })))
    for (const seed of [MISSION_KEY_SEED, BRAIN_KEY_SEED]) {
      const wrong = await EncryptedContextStore.open({ path, key: foreignKey(seed) })
      expect(wrong.faultReason).not.toBeNull()
      expect((await wrong.load()).ok).toBe(false)
      await wrong.close()
    }
  })

  it('refuses to write, so a damaged file cannot lose the records after the break', async () => {
    // The severe one. A commit rewrites the file from what the store holds, and
    // what it holds stops at the first record that could not be believed — so
    // writing here would drop everything after the break, permanently and
    // invisibly, and the next open would report the store *healthy* because the
    // evidence is the thing just deleted.
    const domain = contextStore()
    await writeSnapshot(
      path,
      snapshotOf(
        secretItem(domain, { content: 'record one' }),
        secretItem(domain, { content: 'record two' }),
        secretItem(domain, { content: 'record three' }),
      ),
    )
    const lines = (await readFile(path, 'utf8')).split('\n').filter(Boolean)
    const middle = JSON.parse(lines[1] as string) as { cipher: string }
    lines[1] = JSON.stringify({ ...middle, cipher: `${middle.cipher.slice(0, -4)}AAAA` })
    await writeFile(path, `${lines.join('\n')}\n`)

    const store = await EncryptedContextStore.open({ path, key: testContextKey() })
    expect(store.faultReason).toMatch(/failed authentication/i)
    await expect(store.commit(snapshotOf(secretItem(domain, { content: 'record four' })))).rejects.toMatchObject({
      code: 'degraded',
    })

    // Nothing on disk changed: still three lines, and the first still opens.
    const after = (await readFile(path, 'utf8')).split('\n').filter(Boolean)
    expect(after).toHaveLength(3)
    await store.close()
    const reopened = await EncryptedContextStore.open({ path, key: testContextKey() })
    expect(reopened.faultReason).toMatch(/failed authentication/i)
    await reopened.close()
  })

  it('keeps reporting the fault, and never forgets it on its own', async () => {
    await damaged('garbage\n')
    const store = await EncryptedContextStore.open({ path, key: testContextKey() })
    const first = store.faultReason
    await store.commit(emptyContextSnapshot()).catch(() => undefined)
    await store.load().catch(() => undefined)
    expect(store.faultReason).toBe(first)
    expect(store.durable).toBe(true)
    await store.close()
  })

  it('reports the fault in a sentence a surface can show', async () => {
    await damaged('garbage\n')
    const store = await EncryptedContextStore.open({ path, key: testContextKey() })
    expect(contextPersistenceFaultReason(new ContextPersistenceError('degraded', 'a record failed authentication'))).
      toMatch(/^context is not being kept: /)
    await store.close()
  })
})

describe('the port itself is small enough to be safe', () => {
  it('carries no path, no key and no cipher on the object a caller holds', () => {
    // #27 consumes this port and nothing else. If a store handed back an object
    // with a path or a key on it, the integration would be holding the storage
    // mechanism rather than the vocabulary — and the vocabulary is the only part
    // it is allowed to know.
    const port: ContextPersistencePort = new EphemeralContextStore({ durabilityReason: 'for this test' })
    for (const field of Object.keys(port)) {
      expect(field, field).not.toMatch(/path|key|cipher|secret|password|raw/i)
    }
    expect(port.mode).toBe('ephemeral')
    expect(port.durable).toBe(false)
    expect(port.durabilityReason).toBe('for this test')
    expect(port.faultReason).toBeNull()
  })

  it('has exactly three operations on it, and none grants, widens or exports', () => {
    const port = new EphemeralContextStore({ durabilityReason: 'for this test' })
    const prototype = Object.getPrototypeOf(port) as object
    const methods = Object.getOwnPropertyNames(prototype).filter((name) => {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, name)
      return name !== 'constructor' && typeof descriptor?.value === 'function'
    })
    expect(methods.sort()).toEqual(['close', 'commit', 'load'])
    for (const name of methods) {
      expect(name).not.toMatch(/grant|authorit|capabilit|allow|export|escalat|decrypt|plaintext/i)
    }
  })
})