// @vitest-environment node
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { expectNoSentinels, RED_TEAM_SENTINELS } from '../harness'
import { NOW_ISO, OBSERVED, relationshipFixture, statement } from './harness'

/**
 * PRIVACY AND FORGERY.
 *
 * Two separate claims, tested separately.
 *
 * **Privacy**: a person's own words exist in the encrypted ledger and nowhere else. No
 * broad projection, no broad list, no core status, no activity feed, no error string and
 * no lifecycle label may carry them, and the two reads that are allowed to — the explicit
 * single-entry read and the owner's export — are the only ones, and both are Core-internal.
 *
 * **Forgery**: a renderer, an untrusted page or a hand-edited file cannot manufacture a
 * relationship record. There is no write verb on the protocol surface, no relationship
 * command on the Core surface, and no module a renderer may import.
 */

const SENTINEL = RED_TEAM_SENTINELS[0]
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))

async function sourceFiles(dir: string, extensions = ['.ts', '.tsx']): Promise<string[]> {
  const output: string[] = []
  async function walk(current: string): Promise<void> {
    for (const item of await readdir(current, { withFileTypes: true })) {
      const path = join(current, item.name)
      if (item.isDirectory()) await walk(path)
      else if (item.isFile() && extensions.some((end) => item.name.endsWith(end))) output.push(path)
    }
  }
  await walk(dir)
  return output
}

describe('a record body never reaches a broad sink', () => {
  it('keeps the text out of the projection, the list and every derived read', async () => {
    const { engine } = relationshipFixture()
    await engine.recordOwnerStatement(
      statement({ text: `the owner said ${SENTINEL} and would rather forget it` }),
    )

    expectNoSentinels('relationship projection', engine.project(NOW_ISO))
    expectNoSentinels('relationship derivation', engine.derive(NOW_ISO))
    const listed = engine.listEntries()
    if (!listed.ok) throw new Error('the broad read refused')
    expectNoSentinels('relationship entries list', listed)
    // The only trace of the words is their measured length.
    expect(listed.entries.items[0]?.textLength).toBe(
      `the owner said ${SENTINEL} and would rather forget it`.length,
    )
  })

  it('keeps the text out of everything a renderer can be handed', async () => {
    const { engine } = relationshipFixture()
    await engine.recordExternalObservation(statement({ text: `a page claimed ${SENTINEL}` }))
    // The complete renderer-facing surface: the projection and the broad list. The
    // single-entry read is deliberately *not* here — it is owner-only, reachable only
    // from inside Core, and no relationship command exists for a renderer to call, which
    // the forgery tests below prove structurally. Putting it in this sweep would test the
    // wrong claim.
    const surface = {
      projection: engine.project(NOW_ISO),
      entries: engine.listEntries(),
    }
    expectNoSentinels('the whole renderer-facing surface', surface)
  })

  it('keeps a withdrawal reason out of the journal-facing lifecycle labels', async () => {
    const { engine } = relationshipFixture()
    const recorded = await engine.recordOwnerStatement(
      statement({ text: `private: ${SENTINEL}` }),
    )
    if (recorded.outcome !== 'recorded' || recorded.entry === null) throw new Error('setup failed')
    await engine.withdraw(recorded.entry.entryId)
    const read = engine.readEntry(recorded.entry.entryId)
    if (!read.ok) throw new Error('the single read refused')
    // A withdrawn record reports a closed label, never the owner's words or a sentence.
    expect(read.entry.lifecycleReason).toBe('owner-withdrew-this-record')
    expectNoSentinels('a withdrawn single read', read.entry)
  })

  it('does not leak the text through a refusal reason', async () => {
    const { engine } = relationshipFixture()
    await engine.recordOwnerStatement(statement({ text: `private: ${SENTINEL}` }))
    const missing = engine.readEntry('rel-does-not-exist')
    expect(missing.ok).toBe(false)
    if (missing.ok) return
    expect(missing.reason).not.toContain(SENTINEL)
    expectNoSentinels('a refusal reason', missing)
  })

  it('carries the text only in the two reads that are allowed to', async () => {
    const { engine } = relationshipFixture()
    const text = `the owner said ${SENTINEL}`
    await engine.recordOwnerStatement(statement({ text }))

    const single = engine.readEntry('rel-1')
    expect(single.ok).toBe(true)
    if (single.ok) expect(single.entry.text).toBe(text)

    const exported = engine.export()
    expect(exported.ok).toBe(true)
    if (exported.ok) expect(exported.export.items[0]?.text).toBe(text)
  })
})

describe('withdrawal and forgetting actually remove the words', () => {
  it('destroys the text on withdrawal and keeps only the fact that it was taken back', async () => {
    const { engine } = relationshipFixture()
    await engine.recordOwnerStatement(statement({ text: `private: ${SENTINEL}` }))
    const recorded = await engine.withdraw('rel-1')
    expect(recorded.ok).toBe(true)

    const read = engine.readEntry('rel-1')
    if (!read.ok) throw new Error('the single read refused')
    expect(read.entry.text).toBe('')
    expect(read.entry.textDestroyed).toBe(true)
    // Still present as history: "there was something and it was taken back" is a
    // different answer from "there was nothing", and it is the honest one.
    expect(engine.derive(NOW_ISO).counts.retracted).toBe(1)
    expect(engine.derive(NOW_ISO).counts.admitted).toBe(0)
  })

  it('removes a forgotten record from every read, not only from the store', async () => {
    const { engine } = relationshipFixture()
    await engine.recordOwnerStatement(statement({ text: `private: ${SENTINEL}` }))
    await engine.withdraw('rel-1')
    expect((await engine.forget('rel-1')).ok).toBe(true)

    expect(engine.readEntry('rel-1').ok).toBe(false)
    const exported = engine.export()
    if (!exported.ok) throw new Error('export refused')
    expect(exported.export.items).toHaveLength(0)
    expect(exported.export.total).toBe(0)
    const derivation = engine.derive(NOW_ISO)
    expect(derivation.counts.retracted).toBe(0)
    expectNoSentinels('every read after forgetting', { projection: engine.project(NOW_ISO), exported })
  })
})

describe('a renderer cannot manufacture a record', () => {
  it('exposes no write verb on the relationship protocol surface', async () => {
    const protocol = await readFile(join(REPO_ROOT, 'core', 'protocol', 'relationship.ts'), 'utf8')
    for (const verb of [
      'recordOwnerStatement',
      'recordSystemObservation',
      'recordModelObservation',
      'recordExternalObservation',
      'correct',
      'withdraw',
      'forget',
      'write',
      'admit',
    ]) {
      // The protocol is a view. A method-shaped member on it would be a write verb a
      // renderer could call.
      expect(protocol, `${verb} appears as a member of the protocol`).not.toMatch(
        new RegExp(`(readonly\\s+)?${verb}\\s*\\(`),
      )
    }
  })

  it('registers no relationship command on the Core surface', async () => {
    const commands = await readFile(join(REPO_ROOT, 'core', 'protocol', 'core-protocol.ts'), 'utf8')
    expect(commands).not.toMatch(/'relationship\./)
  })

  it('is not imported by any renderer source', async () => {
    for (const path of await sourceFiles(join(REPO_ROOT, 'src'))) {
      const source = await readFile(path, 'utf8')
      expect(source, path).not.toMatch(/from\s+['"][^'"]*core\/relationship/)
      expect(source, path).not.toMatch(/from\s+['"][^'"]*vault\/repositories\/relationship-store/)
    }
  })

  it('keeps the Vault out of the relationship engine, so no renderer path reaches a database', async () => {
    for (const path of await sourceFiles(join(REPO_ROOT, 'core', 'relationship'))) {
      const source = await readFile(path, 'utf8')
      expect(source, path).not.toMatch(/from\s+['"][^'"]*core\/vault/)
      expect(source, path).not.toMatch(/better-sqlite3|sqlcipher/i)
    }
  })
})

describe('a degraded store is reported, never quietly substituted', () => {
  it('says ephemeral, with the reason, rather than presenting memory as durability', () => {
    const { engine } = relationshipFixture()
    const projection = engine.project(NOW_ISO)
    expect(projection.persistence.mode).toBe('memory')
    expect(projection.persistence.durable).toBe(false)
  })

  it('never claims a durability it does not have, whatever a store claims about itself', async () => {
    const { engine } = relationshipFixture()
    await engine.recordOwnerStatement(statement({ text: `private: ${SENTINEL}`, observedAt: OBSERVED }))
    const projection = engine.project(NOW_ISO)
    // `durable` is derived from the store's own mode and nothing else, so a store cannot
    // assert durability it is not providing.
    expect(projection.persistence.durable).toBe(projection.persistence.mode === 'encrypted')
  })
})