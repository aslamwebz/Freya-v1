// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The provider config store.
 *
 * `safeStorage` is mocked for the same reason `keyring.test.ts` mocks it: the
 * behaviour Freya owns is what the store writes, what it reports and what it
 * refuses. The OS wrapping itself is DPAPI/Keychain territory and is not Freya's
 * to re-test. The mock is mutable so a test can make the OS say "no" and assert
 * that the store never falls back to plaintext.
 */
const secure = {
  available: true,
  backend: 'gnome_libsecret' as string,
}

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => secure.available,
    getSelectedStorageBackend: () => secure.backend,
    encryptString: (plaintext: string) => Buffer.from(`wrapped:${plaintext}`, 'utf8'),
    decryptString: (wrapped: Buffer) => {
      const text = Buffer.from(wrapped).toString('utf8')
      return text.startsWith('wrapped:') ? text.slice('wrapped:'.length) : ''
    },
  },
}))

const { ProviderConfigStore, resolveProviderEnv } = await import('../../../electron/providerConfig')

let dir = ''

const realPlatform = process.platform

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'freya-provider-'))
  secure.available = true
  secure.backend = 'gnome_libsecret'
  setPlatform('linux')
})

afterEach(async () => {
  setPlatform(realPlatform)
  await rm(dir, { recursive: true, force: true })
})

function store(): InstanceType<typeof ProviderConfigStore> {
  return new ProviderConfigStore(join(dir, 'provider.json'))
}

describe('provider config', () => {
  it('round-trips non-secret fields and never reports the key value', async () => {
    const saved = await store().write({
      baseUrl: 'https://nano-gpt.com/api/v1',
      model: 'openai/gpt-4.1-nano',
      liveEnabled: true,
      apiKey: 'sk-test',
    })
    expect(saved.baseUrl).toBe('https://nano-gpt.com/api/v1')
    expect(saved.model).toBe('openai/gpt-4.1-nano')
    expect(JSON.stringify(saved)).not.toContain('sk-test')
  })

  it('never writes the raw key to disk and reads it back only as hasKey', async () => {
    const saved = await store().write({
      baseUrl: 'https://x/v1',
      model: 'm',
      liveEnabled: false,
      apiKey: 'sk-test',
    })
    expect(saved.hasKey).toBe(true)
    const read = await store().read()
    expect(read.hasKey).toBe(true)
    expect(JSON.stringify(read)).not.toContain('sk-test')
  })

  it('never writes the raw key bytes to the settings file', async () => {
    await store().write({
      baseUrl: 'https://x/v1',
      model: 'm',
      liveEnabled: true,
      apiKey: 'sk-secret-value',
    })
    const onDisk = await readFile(join(dir, 'provider.json'), 'utf8')
    expect(onDisk).not.toContain('sk-secret-value')
  })

  it('clears the stored key when an empty string is written', async () => {
    const subject = store()
    await subject.write({ apiKey: 'sk-test' })
    const cleared = await subject.write({ apiKey: '' })
    expect(cleared.hasKey).toBe(false)
    expect((await subject.read()).hasKey).toBe(false)
  })

  it('assembles the exact env Core reads', () => {
    const env = resolveProviderEnv(
      {},
      { apiKey: 'k', baseUrl: 'https://x/v1', model: 'm', liveEnabled: true },
    )
    expect(env.NANOGPT_API_KEY).toBe('k')
    expect(env.NANOGPT_BASE_URL).toBe('https://x/v1')
    expect(env.NANOGPT_MODEL).toBe('m')
    expect(env.FREYA_ALLOW_LIVE_MODEL).toBe('1')
  })

  it('degrades to hasKey false with no key when the OS has no secure storage', async () => {
    secure.available = false
    const saved = await store().write({
      baseUrl: 'https://x/v1',
      model: 'm',
      liveEnabled: true,
      apiKey: 'sk-test',
    })
    expect(saved.hasKey).toBe(false)
    const env: NodeJS.ProcessEnv = {}
    await store().applyToEnv(env)
    expect(env.NANOGPT_API_KEY).toBeUndefined()
    expect(env.NANOGPT_BASE_URL).toBe('https://x/v1')
    expect(env.FREYA_ALLOW_LIVE_MODEL).toBe('1')
  })

  it('refuses the key on the insecure basic_text backend', async () => {
    secure.backend = 'basic_text'
    const saved = await store().write({
      baseUrl: 'https://x/v1',
      model: 'm',
      liveEnabled: true,
      apiKey: 'sk-test',
    })
    expect(saved.hasKey).toBe(false)
    const onDisk = await readFile(join(dir, 'provider.json'), 'utf8')
    expect(onDisk).not.toContain('sk-test')
    expect((await store().read()).hasKey).toBe(false)
    const env: NodeJS.ProcessEnv = {}
    await store().applyToEnv(env)
    expect(env.NANOGPT_API_KEY).toBeUndefined()
  })

  it('writes the decrypted key into an env only when one exists', async () => {
    const env: NodeJS.ProcessEnv = {}
    await store().write({ baseUrl: 'https://x/v1', model: 'm', liveEnabled: true, apiKey: 'sk-test' })
    await store().applyToEnv(env)
    expect(env.NANOGPT_API_KEY).toBe('sk-test')
    expect(env.NANOGPT_BASE_URL).toBe('https://x/v1')
    expect(env.FREYA_ALLOW_LIVE_MODEL).toBe('1')
  })

  it('lets an explicit launch environment win over the stored config', async () => {
    await store().write({
      baseUrl: 'https://stored/v1',
      model: 'stored-model',
      liveEnabled: true,
      apiKey: 'sk-stored',
    })
    const env: NodeJS.ProcessEnv = {
      NANOGPT_API_KEY: 'sk-explicit',
      NANOGPT_BASE_URL: 'https://explicit/v1',
      FREYA_ALLOW_LIVE_MODEL: '0',
    }
    await store().applyToEnv(env, {
      NANOGPT_API_KEY: 'sk-explicit',
      NANOGPT_BASE_URL: 'https://explicit/v1',
      FREYA_ALLOW_LIVE_MODEL: '0',
    })
    expect(env.NANOGPT_API_KEY).toBe('sk-explicit')
    expect(env.NANOGPT_BASE_URL).toBe('https://explicit/v1')
    expect(env.FREYA_ALLOW_LIVE_MODEL).toBe('0')
  })

  it('does nothing when no config has been stored', async () => {
    const env: NodeJS.ProcessEnv = { NANOGPT_API_KEY: 'sk-env', NANOGPT_MODEL: 'env-model' }
    await store().applyToEnv(env, { NANOGPT_API_KEY: 'sk-env', NANOGPT_MODEL: 'env-model' })
    expect(env.NANOGPT_API_KEY).toBe('sk-env')
    expect(env.NANOGPT_MODEL).toBe('env-model')
  })
})
