// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ElectronCoreHost } from '../../electron/coreHost'

/**
 * The model lane across the bridge, from both provable ends.
 *
 * The preload file is a capability boundary whose most important claims are
 * *absences* — no payload field that is not named, no environment read, no way
 * to attach an ignored blob — and an absence over a module that calls
 * `contextBridge` at import time is only checkable against the source, the same
 * way the Context lane is checked. The round trip here is then run through the
 * *real* host and Core with no credentials, which is the one configuration that
 * can be asserted end to end without a network: the refusal must be a sentence,
 * the provider must never be asked, and an unusable selection must be stopped by
 * Core rather than reaching the Gateway as a turn.
 */

let dir = ''
let host: ElectronCoreHost | null = null

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'freya-model-bridge-'))
})

afterEach(async () => {
  await host?.stop('test-teardown')
  host = null
  await rm(dir, { recursive: true, force: true })
})

async function preloadSource(): Promise<string> {
  return readFile(join(import.meta.dirname, '..', '..', 'electron', 'preload.ts'), 'utf8')
}

describe('the preload bridge arms', () => {
  it('whitelists exactly the two model commands', async () => {
    const source = await preloadSource()
    expect(source).toMatch(/'model\.catalog\.read',/)
    expect(source).toMatch(/'model\.select',/)
    // And no third spelling: there is no provider control, no key read, and no
    // model event channel hiding in the command list.
    const modelCommands = (source.match(/'model\.[a-z.]+'|'model\.[a-z.]+`/g) ?? []).map((name) =>
      name.replace(/['`]/g, ''),
    )
    expect([...new Set(modelCommands)].sort()).toEqual(['model.catalog.read', 'model.select'])
  })

  it('gives the catalogue read no payload and the selection one bounded string', async () => {
    const source = await preloadSource()
    const catalog = source.match(/case 'model\.catalog\.read':[\s\S]*?\n\s{4}(?=case|\/\/)/)
    expect(catalog?.[0]).toMatch(/return \{ ok: true \}/)
    const select = source.match(/case 'model\.select': \{[\s\S]*?\n {4}\}/)
    expect(select?.[0]).toMatch(/string\('model', MAX_MODEL_ID_CHARS, false\)/)
    expect(select?.[0]).toMatch(/model id is invalid/)
    // Rebuilt from the named field only — an ignored blob is never forwarded.
    expect(select?.[0]).toMatch(/payload: model === undefined \? \{\} : \{ model \}/)
  })

  it('never forwards environment content in any direction', async () => {
    const source = await preloadSource()
    expect(source).not.toMatch(/process\.env|NANOGPT_API_KEY|BRAVE_SEARCH_API_KEY/)
  })
})

describe('the model commands through the real host with no credentials', () => {
  it('refuses the catalogue in words, touching no network and spending nothing', async () => {
    host = new ElectronCoreHost(join(dir, 'core-events.jsonl'), {})
    await host.start()

    const catalog = await host.submit({ command: 'model.catalog.read', requestId: 'r1' })
    expect(catalog.ok).toBe(false)
    expect(catalog.model?.operation).toBe('refused')
    expect(catalog.model?.reason).toMatch(/no configured provider/i)
    expect(catalog.model?.reason).toMatch(/credential/i)
    expect(catalog.model?.reason).toMatch(/model/i)

    const selected = await host.submit({ command: 'model.select', requestId: 'r2', payload: { model: 'openai/gpt-4.1-nano' } })
    expect(selected.ok).toBe(false)
    expect(selected.refusal?.reason).toMatch(/can serve model/)

    expect(host.status().providers.every((provider) => provider.status === 'unconfigured')).toBe(true)
    expect(host.status().activeProviderCalls).toBe(0)
    expect(host.status().sessionUsage.calls).toBe(0)
  })

  it('reads and refuses model commands after the Core is up, proving the envelope plumbing', async () => {
    host = new ElectronCoreHost(join(dir, 'core-events.jsonl'), {})
    await host.start()
    // A malformed payload is refused with a reason, not a stack: the shape
    // checks live in Core as well as at the bridge.
    const malformed = await host.submit({ command: 'model.select', requestId: 'r3', payload: { model: 7 } })
    expect(malformed.ok).toBe(false)
    expect(typeof malformed.refusal?.reason).toBe('string')
  })
})
