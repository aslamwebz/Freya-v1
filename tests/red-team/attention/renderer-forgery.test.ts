// @vitest-environment node
import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { ingest, startAttentionCore, stopAttentionCore, submit, type AttentionFixture } from './harness'

/**
 * RENDERER FORGERY.
 *
 * The attack: a compromised window names a command that decides, ticks the clock,
 * sets a budget or claims a source. None of those commands exists; the bridge
 * whitelist carries no such name, and the ingest contract rebuilds the payload from
 * named fields so a forged `source` never even reaches Core.
 */

const fixtures: AttentionFixture[] = []
async function start(): Promise<AttentionFixture> {
  const fixture = await startAttentionCore()
  fixtures.push(fixture)
  return fixture
}
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await stopAttentionCore(fixture)
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

describe('a window cannot decide, tick or set a budget', () => {
  it('has no attention.tick, decide, budget or cooldown command', async () => {
    const source = await preloadCode()
    const listed = source.slice(source.indexOf('const CORE_COMMANDS'), source.indexOf('function readString'))
    expect(listed).not.toMatch(/attention\.(tick|decide|budget|cooldown|escalate)/)
    expect(source).not.toMatch(/attentionTick|attentionDecide/)
  })

  it('refuses a tick command as unknown', async () => {
    const fixture = await start()
    const result = await submit(fixture, 'attention.tick', {})
    expect(result.ok).toBe(false)
    expect(result.refusal?.reason).toMatch(/unknown command/)
  })

  it('refuses a decide command as unknown', async () => {
    const fixture = await start()
    const result = await submit(fixture, 'attention.decide', { outcome: 'interrupt' })
    expect(result.ok).toBe(false)
  })

  it('refuses a status read that carries anything', async () => {
    const fixture = await start()
    const result = await submit(fixture, 'attention.status.read', { importance: 'critical' })
    expect(result.ok).toBe(false)
  })

  it('does not let a forged outcome reach the directive', async () => {
    const fixture = await start()
    await ingest(fixture, {
      kind: 'context-change',
      text: 'quiet',
      outcome: 'interrupt',
      cueCode: 'needs-attention',
    })
    const projection = fixture.core.attention()
    expect(projection.directive).toBeNull()
    expect(projection.lastDecision?.outcome).toBe('do-nothing')
  })
})
