// @vitest-environment node
import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { entryDraft, startLifeCore, stopLifeCore, type LifeFixture } from './harness'

/**
 * RENDERER FORGERY.
 *
 * The attack: a compromised window names a command that records, consolidates,
 * revises, withdraws, raises a confidence or promotes an entry. None of those
 * commands exists; the bridge whitelist carries no such name, and the payload
 * contracts rebuild only a bounded limit, known kinds and one id — so a forged
 * confidence, derivation class or source never even reaches Core.
 */

const fixtures: LifeFixture[] = []
async function start(): Promise<LifeFixture> {
  const fixture = await startLifeCore()
  fixtures.push(fixture)
  return fixture
}
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await stopLifeCore(fixture)
})

async function preloadCode(): Promise<string> {
  const source = await readFile(new URL('../../../electron/preload.ts', import.meta.url), 'utf8')
  return source
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trimStart()
      return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*')
    })
    .join('\n')
}

describe('a window cannot write, revise or widen truth', () => {
  it('has no life write, revise, withdraw, consolidate or confidence command', async () => {
    const source = await preloadCode()
    const listed = source.slice(source.indexOf('const CORE_COMMANDS'), source.indexOf('function readString'))
    expect(listed).not.toMatch(/life\.(record|revise|withdraw|consolidate|confidence|promote|admit)/)
    expect(source).not.toMatch(/freya:core:life:write/)
    expect(source).not.toMatch(/recordLife|withdrawLife|consolidateLife/)
  })

  it('refuses every life command name outside the three reads', async () => {
    const fixture = await start()
    for (const command of [
      'life.record',
      'life.revise',
      'life.withdraw',
      'life.consolidate',
      'life.confidence.set',
      'life.promote',
      'life.admit',
    ]) {
      const result = await fixture.submit(command, {})
      expect(result.ok).toBe(false)
      expect(result.refusal?.reason).toMatch(/unknown command/)
    }
  })

  it('refuses a payload on the payloadless read', async () => {
    const fixture = await start()
    const result = await fixture.submit('life.status.read', { confidence: 'verified', derivation: 'observed' })
    expect(result.ok).toBe(false)
    expect(result.life?.code).toBe('malformed-payload')
  })

  it('refuses a forged field on the timeline and entry reads', async () => {
    const fixture = await start()
    const outcome = await fixture.scope().record(entryDraft())
    const timeline = await fixture.submit('life.timeline.read', { status: 'live', confidence: 'verified' })
    expect(timeline.ok).toBe(false)
    const entry = await fixture.submit('life.entry.read', {
      entryId: outcome.entry!.entryId,
      confidence: 'verified',
    })
    expect(entry.ok).toBe(true)
    expect(entry.life?.entry?.confidence).toBe('high')
  })
})
