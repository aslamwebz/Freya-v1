// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CapabilitySettingsStore } from '../../electron/capabilitySettings'
import { buildConfiguredModelProviders, readRuntimeCapabilityRegistry } from '../../core/model/capability-runtime'
import { ModelGateway } from '../../core/model/gateway'
import { FakeModelProvider } from '../../core/model/fake-provider'

describe('persisted capability routes', () => {
  it('persists only bounded capability preferences and rejects secrets and unknown IDs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'freya-capabilities-'))
    try {
      const path = join(dir, 'capabilities.json')
      const store = new CapabilitySettingsStore(path)
      await store.write({ chat: ['local', 'minimax'], vision: ['nanogpt'] })
      expect((await new CapabilitySettingsStore(path).read()).chat).toEqual(['local', 'minimax'])
      await expect(store.write({ apiKey: 'secret' })).rejects.toThrow()
      await expect(store.write({ chat: ['unknown'] })).rejects.toThrow()
      expect(await readFile(path, 'utf8')).not.toContain('secret')
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
  it('does not claim voice, image creation or vision merely because a chat key exists', () => {
    const registry = readRuntimeCapabilityRegistry({ MINIMAX_API_KEY: 'secret', MINIMAX_MODEL: 'MiniMax-M2.5', FREYA_ALLOW_LIVE_MODEL: '1' })
    expect(registry.chat.available).toBe('minimax')
    expect(registry.vision.available).toBeNull()
    expect(registry.tts.available).toBeNull()
    expect(registry.stt.available).toBeNull()
    expect(registry.imageGen.available).toBeNull()
  })
  it('creates MiniMax first and only approves each credential recipient for its own provider', async () => {
    const providers = buildConfiguredModelProviders({ MINIMAX_API_KEY: 'secret', MINIMAX_BASE_URL: '', FREYA_ALLOW_LIVE_MODEL: '1' })
    expect(providers[0]?.id).toBe('minimax')
    expect(providers[0]?.status().status).toBe('configured')
    const invalid = buildConfiguredModelProviders({ MINIMAX_API_KEY: 'secret', MINIMAX_BASE_URL: 'https://nano-gpt.com/api/v1', FREYA_ALLOW_LIVE_MODEL: '1' })
    expect(invalid[0]?.status().status).toBe('unconfigured')
  })
  it('dispatches chat and image turns through independent selections, updated live', async () => {
    const mini = new FakeModelProvider(); Object.defineProperty(mini, 'id', { value: 'minimax' })
    const nano = new FakeModelProvider(); Object.defineProperty(nano, 'id', { value: 'nanogpt' })
    let selected = ['nanogpt']
    const gateway = new ModelGateway({ providers: [mini, nano], providerPreference: (capability) => capability === 'vision' ? ['minimax'] : capability === 'browser' ? ['nanogpt'] : selected, recorder: { started: vi.fn(), completed: vi.fn(), failed: vi.fn(), cancelled: vi.fn() } })
    const permit = { requestId: 'test', correlationId: 'test', grantId: null, providerId: 'unused', maxOutputTokens: 50, model: null }
    await gateway.execute(permit, 'hello')
    expect(nano.calls).toBe(1); expect(mini.calls).toBe(0)
    selected = ['minimax']
    await gateway.execute(permit, 'hello')
    expect(mini.calls).toBe(1)
    await gateway.execute({ ...permit, modelCapability: 'browser' }, 'browse')
    expect(nano.calls).toBe(2)
    selected = ['nanogpt']
    await gateway.execute({ ...permit, messages: [{ role: 'user', content: 'image', attachments: [{ type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }] }] }, 'image')
    expect(mini.calls).toBe(2)
    selected = ['local']
    await expect(gateway.execute(permit, 'hello')).rejects.toThrow('no configured provider')
    expect(nano.calls).toBe(2)
  })
})
import { CompatibleModelProvider } from '../../core/model/compatible-provider'
import { compatibleConfig } from '../../core/model/capability-runtime'

describe('configured adapter transport boundaries', () => {
  const request = { requestId: 'transport', messages: [{ role: 'user' as const, content: 'hello' }], prompt: 'hello', model: null, maxOutputTokens: 40 }
  const options = { signal: new AbortController().signal }
  const response = () => new Response(JSON.stringify({ choices: [{ message: { content: 'answer' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } }), { status: 200 })
  it('sends MiniMax completions to the documented endpoint with the secret only in headers', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(response())
    const provider = new CompatibleModelProvider('minimax', compatibleConfig('minimax', { MINIMAX_API_KEY: 'secret', MINIMAX_MODEL: 'MiniMax-M2.5', FREYA_ALLOW_LIVE_MODEL: '1' }), transport)
    const result = await provider.complete(request, options)
    expect(await provider.listModels({ signal: options.signal })).toEqual([{ id: 'MiniMax-M2.5', ownedBy: 'minimax' }])
    expect(result.providerId).toBe('minimax')
    expect(result.finishReason).toBe('stop')
    expect(result.inputTokens).toBe(3)
    const [url, init] = transport.mock.calls[0]!
    expect(url).toBe('https://api.minimax.io/v1/chat/completions')
    expect(init?.redirect).toBe('manual')
    expect(init?.headers).toMatchObject({ authorization: 'Bearer secret' })
    expect(init?.body).not.toContain('secret')
    expect(JSON.stringify(provider.status())).not.toContain('secret')
  })
  it('refuses redirects without following them, including another approved provider', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 302, headers: { location: 'https://api.openai.com/v1/chat/completions' } }))
    const provider = new CompatibleModelProvider('minimax', compatibleConfig('minimax', { MINIMAX_API_KEY: 'secret', MINIMAX_MODEL: 'MiniMax-M2.5', FREYA_ALLOW_LIVE_MODEL: '1' }), transport)
    await expect(provider.complete(request, options)).rejects.toThrow('redirect refused')
    expect(transport).toHaveBeenCalledTimes(1)
  })
  it('local inference is literal loopback only and never receives a credential', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(response())
    const provider = new CompatibleModelProvider('local', { apiKey: 'must-never-send', baseUrl: 'http://127.0.0.1:11434/v1', model: 'small', liveEnabled: true, vision: false }, transport)
    await provider.complete(request, options)
    expect(transport.mock.calls[0]?.[1]?.headers).not.toHaveProperty('authorization')
    expect(compatibleConfig('local', { LOCAL_MODEL_BASE_URL: 'http://192.168.1.1/v1', LOCAL_MODEL_MODEL: 'small' })).toBeNull()
  })
  it('refuses file and undeclared image support before any network contact', async () => {
    const transport = vi.fn<typeof fetch>()
    const provider = new CompatibleModelProvider('minimax', compatibleConfig('minimax', { MINIMAX_API_KEY: 'secret', MINIMAX_MODEL: 'MiniMax-M2.5', FREYA_ALLOW_LIVE_MODEL: '1' }), transport)
    await expect(provider.complete({ ...request, messages: [{ role: 'user', content: 'image', attachments: [{ type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }] }] }, options)).rejects.toThrow('image support')
    expect(transport).not.toHaveBeenCalled()
  })
  it('recognizes documented MiniMax M3 vision and only explicit other provider declarations', () => {
    expect(readRuntimeCapabilityRegistry({ MINIMAX_API_KEY: 'secret', MINIMAX_MODEL: 'MiniMax-M3', FREYA_ALLOW_LIVE_MODEL: '1' }).vision.available).toBe('minimax')
    const env = { NANOGPT_API_KEY: 'secret', NANOGPT_BASE_URL: 'https://nano-gpt.com/api/v1', NANOGPT_MODEL: 'vision-model', FREYA_ALLOW_LIVE_MODEL: '1' }
    expect(readRuntimeCapabilityRegistry(env).vision.available).toBeNull()
    expect(readRuntimeCapabilityRegistry({ ...env, FREYA_VISION_PROVIDERS: 'nanogpt' }).vision.available).toBe('nanogpt')
  })
})

describe('selected provider model discovery', () => {
  it('discovers every configured provider while preserving the preferred default, without spend', async () => {
    const mini = new CompatibleModelProvider('minimax', compatibleConfig('minimax', { MINIMAX_API_KEY: 'secret', FREYA_ALLOW_LIVE_MODEL: '1' }))
    const openai = new CompatibleModelProvider('openai', compatibleConfig('openai', { OPENAI_API_KEY: 'different-secret', OPENAI_MODEL: 'configured-model', FREYA_ALLOW_LIVE_MODEL: '1' }))
    const gateway = new ModelGateway({ providers: [mini, openai], providerPreference: () => ['openai'], recorder: { started: vi.fn(), completed: vi.fn(), failed: vi.fn(), cancelled: vi.fn() } })
    expect(await gateway.readModelCatalog()).toEqual({ ok: true, providerId: 'openai', defaultModel: 'configured-model', models: [{ id: 'MiniMax-M3', ownedBy: 'minimax', providerId: 'minimax' }, { id: 'configured-model', ownedBy: 'openai', providerId: 'openai' }] })
    expect(gateway.canServeModel('configured-model')).toBe(true)
    expect(gateway.canServeModel('MiniMax-M3', 'minimax')).toBe(true)
    expect(gateway.canServeModel('MiniMax-M3', 'openai')).toBe(false)
  })
})


describe('catalogue provider isolation', () => {
  const response = () => new Response(JSON.stringify({ choices: [{ message: { content: 'answer' }, finish_reason: 'stop' }] }), { status: 200 })
  it('keeps healthy catalogues when another provider fails and never runs inference', async () => {
    const mini = new CompatibleModelProvider('minimax', compatibleConfig('minimax', { MINIMAX_API_KEY: 'secret', FREYA_ALLOW_LIVE_MODEL: '1' }))
    const broken = new CompatibleModelProvider('openai', compatibleConfig('openai', { OPENAI_API_KEY: 'secret', OPENAI_MODEL: 'configured-model', FREYA_ALLOW_LIVE_MODEL: '1' }))
    vi.spyOn(broken, 'listModels').mockRejectedValue(new Error('discovery unavailable'))
    const complete = vi.spyOn(mini, 'complete')
    const recorder = { started: vi.fn(), completed: vi.fn(), failed: vi.fn(), cancelled: vi.fn() }
    const gateway = new ModelGateway({ providers: [broken, mini], providerPreference: () => ['minimax'], recorder })
    const catalog = await gateway.readModelCatalog()
    expect(catalog.ok).toBe(true)
    if (catalog.ok) { expect(catalog.models).toHaveLength(1); expect(catalog.reason).toContain('openai') }
    expect(complete).not.toHaveBeenCalled()
    expect(recorder.started).not.toHaveBeenCalled()
    expect(gateway.activeCallCount()).toBe(0)
  })
  it('does not let either an explicit provider or a model-only choice bypass vision admission', async () => {
    const transport = vi.fn<typeof fetch>()
    const env = { OPENAI_API_KEY: 'secret', OPENAI_MODEL: 'text-only', FREYA_ALLOW_LIVE_MODEL: '1' }
    const openai = new CompatibleModelProvider('openai', compatibleConfig('openai', env), transport)
    const recorder = { started: vi.fn(), completed: vi.fn(), failed: vi.fn(), cancelled: vi.fn() }
    const gateway = new ModelGateway({ providers: [openai], providerPreference: capability => capability === 'vision' ? [] : ['openai'], recorder })
    const permit = { requestId: 'vision', correlationId: 'vision', grantId: null, providerId: 'auto', model: 'text-only', maxOutputTokens: 32, messages: [{ role: 'user' as const, content: 'image', attachments: [{ type: 'image' as const, mimeType: 'image/png' as const, data: 'aGVsbG8=' }] }] }
    await expect(gateway.execute(permit, 'image')).rejects.toThrow('no configured provider')
    await expect(gateway.execute({ ...permit, requestedProviderId: 'openai' }, 'image')).rejects.toThrow('no configured provider')
    expect(transport).not.toHaveBeenCalled()
    expect(recorder.started).not.toHaveBeenCalled()
  })
  it('routes an explicit provider choice without replacing it with the preferred provider sharing its model ID', async () => {
    const env = { MINIMAX_API_KEY: 'secret', MINIMAX_MODEL: 'shared', OPENAI_API_KEY: 'secret', OPENAI_MODEL: 'shared', FREYA_ALLOW_LIVE_MODEL: '1' }
    const miniFetch = vi.fn<typeof fetch>().mockResolvedValue(response())
    const openFetch = vi.fn<typeof fetch>().mockResolvedValue(response())
    const mini = new CompatibleModelProvider('minimax', compatibleConfig('minimax', env), miniFetch)
    const openai = new CompatibleModelProvider('openai', compatibleConfig('openai', env), openFetch)
    const gateway = new ModelGateway({ providers: [mini, openai], providerPreference: () => ['minimax'], recorder: { started: vi.fn(), completed: vi.fn(), failed: vi.fn(), cancelled: vi.fn() } })
    const result = await gateway.execute({ requestId: 'choice', correlationId: 'choice', grantId: null, providerId: 'auto', requestedProviderId: 'openai', model: 'shared', maxOutputTokens: 32 }, 'exact owner text')
    expect(result.providerId).toBe('openai')
    expect(openFetch).toHaveBeenCalledTimes(1)
    expect(miniFetch).not.toHaveBeenCalled()
    expect(JSON.parse(String(openFetch.mock.calls[0]?.[1]?.body)).model).toBe('shared')
  })
})
