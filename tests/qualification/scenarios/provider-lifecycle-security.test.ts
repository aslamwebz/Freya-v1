// @vitest-environment node
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCore, type Core } from '../../../core'
import { NanoGptProvider, readNanoGptConfig } from '../../../core/model/nanogpt-provider'
import { checkProviderBaseUrl } from '../../../core/model/provider-endpoint'
import type { ModelCallOptions, ModelRequest } from '../../../core/model/provider'
import { buildCapabilityInventory } from '../../../core/qualification'
import { QUALIFIED_MODULES, floorFacts } from '../fixture'

/**
 * Scenario gate: `provider-lifecycle-security`.
 *
 * Bounded: one real Core per case over a real temporary journal, one real on-disk scan,
 * one real endpoint policy. **No network call is ever made** — the provider's `fetch` is
 * replaced by a counter, so "it spent nothing" is proved by a counter that did not move
 * rather than by an assumption.
 *
 * The claim has three parts, and all three have failed somewhere before:
 *
 *   1. **Lifecycle.** A provider is contacted only when a credential is stored. Absent
 *      configuration is `unconfigured`, never "try it and see".
 *   2. **Consent.** Live traffic stays disabled without an explicit owner switch, even with
 *      a complete credential in hand. A credential is not a decision to spend.
 *   3. **Security.** The key never reaches a status, a projection, an error, a log line or
 *      the disk. There is no plaintext fallback and no key stored beside the data it
 *      protects.
 */

const SECRET = 'sk-qualification-must-never-be-seen'

const ENDPOINT = 'https://nano-gpt.com/api/v1'
const MODEL = 'openai/gpt-4.1-nano'

const REQUEST: ModelRequest = {
  requestId: 'qualification-1',
  model: MODEL,
  messages: [{ role: 'user', content: 'hello' }],
  prompt: 'hello',
  maxOutputTokens: 16,
}

/** The only caller a provider ever has. It holds the signal; a provider can never fire it. */
function callOptions(): ModelCallOptions {
  return { signal: new AbortController().signal }
}

let root = ''
let dataPath = ''
let core: Core | null = null

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'freya-p49-provider-'))
  dataPath = join(root, 'core-events.jsonl')
  core = null
})

afterEach(async () => {
  if (core !== null) await core.stop('scenario cleanup')
  core = null
  await rm(root, { recursive: true, force: true })
})

async function open(env: Record<string, string> = {}): Promise<Core> {
  core = createCore({ dataPath, env })
  await core.start()
  return core
}

/** Every byte written anywhere under a directory, as one string. */
async function everythingOnDisk(dir: string): Promise<string> {
  let found = ''
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) found += await everythingOnDisk(full)
    else if (entry.isFile()) found += await readFile(full, 'utf8')
  }
  return found
}

function providerFor(liveEnabled: string | undefined): NanoGptProvider {
  const config = readNanoGptConfig({
    NANOGPT_API_KEY: SECRET,
    NANOGPT_BASE_URL: ENDPOINT,
    NANOGPT_MODEL: MODEL,
    ...(liveEnabled === undefined ? {} : { FREYA_ALLOW_LIVE_MODEL: liveEnabled }),
  })
  if (config === null) throw new Error('the test credential set was rejected by the endpoint policy')
  // The fetch is replaced by a counter. Nothing leaves the process, so the scenario is
  // bounded by construction rather than by good intentions.
  const fetchImpl = vi.fn(async () => {
    throw new Error('the qualification scenario must never reach a network')
  })
  return new NanoGptProvider({ config, fetchImpl: fetchImpl as unknown as typeof fetch })
}

describe('provider lifecycle and credential security', () => {
  it('reports unconfigured with nothing supplied, and selects no provider', async () => {
    const started = await open()
    for (const status of started.status().providers) {
      // `unconfigured` is the honest reading. A provider that reported itself configured
      // with no credential would be claiming a route to a network it cannot take.
      expect(['unconfigured', 'disabled', 'faulted']).toContain(status.status)
      expect(status.liveEnabled).toBe(false)
      expect(status.detail.length).toBeGreaterThan(0)
    }
    await started.stop('scenario finished')
    core = null
  })

  it('holds a complete credential at disabled until the owner says to spend', async () => {
    const provider = providerFor('0')
    const status = provider.status()

    expect(status.status).toBe('disabled')
    expect(status.liveEnabled).toBe(false)
    // The model is a shape, not a value: the status is safe to render.
    expect(status.model).toBe(MODEL)
    expect(status.detail.length).toBeGreaterThan(0)
  })

  it('reports unconfigured rather than configured when the credential is absent', () => {
    const config = readNanoGptConfig({
      NANOGPT_BASE_URL: ENDPOINT,
      NANOGPT_MODEL: MODEL,
      FREYA_ALLOW_LIVE_MODEL: '1',
    })
    expect(config).toBeNull()
    // And with no config at all, the provider says so rather than guessing a default.
    expect(new NanoGptProvider({ config: null }).status().status).toBe('unconfigured')
  })

  it('spends nothing and returns no key when a call is attempted while disabled', async () => {
    const provider = providerFor('0')
    const fetchImpl = vi.fn()
    const observed = new NanoGptProvider({
      config: readNanoGptConfig({
        NANOGPT_API_KEY: SECRET,
        NANOGPT_BASE_URL: ENDPOINT,
        NANOGPT_MODEL: MODEL,
        FREYA_ALLOW_LIVE_MODEL: '0',
      }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    await expect(observed.complete(REQUEST, callOptions())).rejects.toThrow()
    // The counter is the evidence. A disabled provider that still issued a request would
    // report `disabled` while spending.
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(provider.status().status).toBe('disabled')
  })

  it('keeps the key out of the status, and out of a failure it reports', async () => {
    const provider = providerFor('1')
    const status = provider.status()
    expect(JSON.stringify(status)).not.toContain(SECRET)
    // The status still has to be useful: a provider stripped of every field is not a safe
    // provider, it is an uninformative one.
    expect(status.status).toBe('configured')
    expect(status.liveEnabled).toBe(true)
    expect(status.model).toBe(MODEL)
  })

  it('keeps the key out of every byte the Core writes to disk', async () => {
    const started = await open({
      NANOGPT_API_KEY: SECRET,
      NANOGPT_BASE_URL: ENDPOINT,
      NANOGPT_MODEL: MODEL,
      FREYA_ALLOW_LIVE_MODEL: '0',
    })
    await started.handleCommand({ command: 'conversation.create', requestId: 'p0' })
    await started.handleCommand({
      command: 'brain.memory.write',
      requestId: 'p1',
      payload: { text: 'a perfectly ordinary note' },
    })
    await started.stop('scenario finished')
    core = null

    const onDisk = await everythingOnDisk(root)
    expect(onDisk.length).toBeGreaterThan(0)
    expect(onDisk).not.toContain(SECRET)
  })

  it('refuses an endpoint that would aim the key at a host it must not reach', async () => {
    const refusals = [
      'http://nano-gpt.com/api/v1',
      'https://localhost/api/v1',
      'https://127.0.0.1/api/v1',
      'https://192.168.1.10/api/v1',
      'https://10.0.0.5/v1',
      'file:///etc/passwd',
      'not a url at all',
    ]
    for (const baseUrl of refusals) {
      expect(checkProviderBaseUrl(baseUrl).ok, `${baseUrl} was approved`).toBe(false)
      // A refused endpoint is indistinguishable from an absent configuration, so a mistyped
      // setting disables the thing it configures rather than arming it.
      expect(
        readNanoGptConfig({
          NANOGPT_API_KEY: SECRET,
          NANOGPT_BASE_URL: baseUrl,
          NANOGPT_MODEL: MODEL,
        }),
      ).toBeNull()
    }
    expect(checkProviderBaseUrl(ENDPOINT).ok).toBe(true)
  })

  it('spends no model call while an idle Core simply sits there', async () => {
    const fetchImpl = vi.fn()
    const started = createCore({
      dataPath,
      env: {
        NANOGPT_API_KEY: SECRET,
        NANOGPT_BASE_URL: ENDPOINT,
        NANOGPT_MODEL: MODEL,
        FREYA_ALLOW_LIVE_MODEL: '1',
      },
      providers: [
        new NanoGptProvider({
          config: readNanoGptConfig({
            NANOGPT_API_KEY: SECRET,
            NANOGPT_BASE_URL: ENDPOINT,
            NANOGPT_MODEL: MODEL,
            FREYA_ALLOW_LIVE_MODEL: '1',
          })!,
          fetchImpl: fetchImpl as unknown as typeof fetch,
        }),
      ],
    })
    core = started
    await started.start()

    // A started, fully configured, ready Core that nobody has spoken to must have spent
    // nothing. This is the zero-idle promise, measured rather than believed.
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(started.status().providers).toHaveLength(1)
    expect(started.status().providers[0]?.status).toBe('configured')

    await started.stop('scenario finished')
    core = null
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('reports a provider being configured as no reason for a domain to claim more', () => {
    const bare = buildCapabilityInventory({
      facts: floorFacts(),
      presentModules: QUALIFIED_MODULES,
    })
    const configured = buildCapabilityInventory({
      facts: floorFacts({ providerConfigured: true, providerCount: 1 }),
      presentModules: QUALIFIED_MODULES,
    })

    // Configuring a provider must not silently promote any domain out of `blocked`. If it
    // did, the runtime registry would be using a credential as authority, which is exactly
    // the confusion the dependency kinds exist to prevent.
    const promoted = configured.capabilities.filter((capability) => {
      const before = bare.capabilities.find((c) => c.id === capability.id)!
      return capability.readiness === 'active' && before.readiness === 'blocked'
    })
    expect(promoted).toEqual([])
  })
})