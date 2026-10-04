// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadLocalEnv } from '../../../electron/localEnv'

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
      baseUrl: 'https://nano-gpt.com/api/v1',
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
      baseUrl: 'https://nano-gpt.com/api/v1',
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
      { apiKey: 'k', baseUrl: 'https://nano-gpt.com/api/v1', model: 'm', liveEnabled: true },
    )
    expect(env.NANOGPT_API_KEY).toBe('k')
    expect(env.NANOGPT_BASE_URL).toBe('https://nano-gpt.com/api/v1')
    expect(env.NANOGPT_MODEL).toBe('m')
    expect(env.FREYA_ALLOW_LIVE_MODEL).toBe('1')
  })

  it('omits the live flag but keeps base values when no key is stored', () => {
    const env = resolveProviderEnv(
      { FREYA_ALLOW_LIVE_MODEL: '1' },
      { apiKey: null, baseUrl: 'https://nano-gpt.com/api/v1', model: 'm', liveEnabled: true },
    )
    expect(env.NANOGPT_API_KEY).toBeUndefined()
    expect(env.NANOGPT_BASE_URL).toBe('https://nano-gpt.com/api/v1')
    expect(env.NANOGPT_MODEL).toBe('m')
    expect(env.FREYA_ALLOW_LIVE_MODEL).toBe('1')
  })

  it('degrades to hasKey false with no key when the OS has no secure storage', async () => {
    secure.available = false
    const saved = await store().write({
      baseUrl: 'https://nano-gpt.com/api/v1',
      model: 'm',
      liveEnabled: true,
      apiKey: 'sk-test',
    })
    expect(saved.hasKey).toBe(false)
    const env: NodeJS.ProcessEnv = {}
    await store().applyToEnv(env)
    expect(env.NANOGPT_API_KEY).toBeUndefined()
    expect(env.NANOGPT_BASE_URL).toBe('https://nano-gpt.com/api/v1')
    // No openable key means the store does not own the live decision.
    expect(env.FREYA_ALLOW_LIVE_MODEL).toBeUndefined()
  })

  it('refuses the key on the insecure basic_text backend', async () => {
    secure.backend = 'basic_text'
    const saved = await store().write({
      baseUrl: 'https://nano-gpt.com/api/v1',
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
    await store().write({ baseUrl: 'https://nano-gpt.com/api/v1', model: 'm', liveEnabled: true, apiKey: 'sk-test' })
    await store().applyToEnv(env)
    expect(env.NANOGPT_API_KEY).toBe('sk-test')
    expect(env.NANOGPT_BASE_URL).toBe('https://nano-gpt.com/api/v1')
    expect(env.FREYA_ALLOW_LIVE_MODEL).toBe('1')
  })

  it('lets an explicit launch environment win over the stored config', async () => {
    await store().write({
      baseUrl: 'https://nano-gpt.com/api/v1',
      model: 'stored-model',
      liveEnabled: true,
      apiKey: 'sk-stored',
    })
    const env: NodeJS.ProcessEnv = {
      NANOGPT_API_KEY: 'sk-explicit',
      NANOGPT_BASE_URL: 'https://www.nano-gpt.com/api/v1',
      FREYA_ALLOW_LIVE_MODEL: '0',
    }
    await store().applyToEnv(env, {
      NANOGPT_API_KEY: 'sk-explicit',
      NANOGPT_BASE_URL: 'https://www.nano-gpt.com/api/v1',
      FREYA_ALLOW_LIVE_MODEL: '0',
    })
    expect(env.NANOGPT_API_KEY).toBe('sk-explicit')
    expect(env.NANOGPT_BASE_URL).toBe('https://www.nano-gpt.com/api/v1')
    expect(env.FREYA_ALLOW_LIVE_MODEL).toBe('0')
  })

  it('preserves a base environment credential and live flag when the store has no key', async () => {
    await store().write({ baseUrl: 'https://nano-gpt.com/api/v1', model: 'stored-model', liveEnabled: true })
    const env: NodeJS.ProcessEnv = {
      NANOGPT_API_KEY: 'sk-env',
      FREYA_ALLOW_LIVE_MODEL: '1',
    }
    await store().applyToEnv(env)
    expect(env.NANOGPT_API_KEY).toBe('sk-env')
    expect(env.FREYA_ALLOW_LIVE_MODEL).toBe('1')
    // The non-secret names the store does provide are still overlaid.
    expect(env.NANOGPT_BASE_URL).toBe('https://nano-gpt.com/api/v1')
    expect(env.NANOGPT_MODEL).toBe('stored-model')
  })

  it('overlays the stored key and live flag when the store has a key', async () => {
    await store().write({
      baseUrl: 'https://nano-gpt.com/api/v1',
      model: 'stored-model',
      liveEnabled: false,
      apiKey: 'sk-stored',
    })
    const env: NodeJS.ProcessEnv = { NANOGPT_API_KEY: 'sk-env', FREYA_ALLOW_LIVE_MODEL: '1' }
    await store().applyToEnv(env)
    expect(env.NANOGPT_API_KEY).toBe('sk-stored')
    expect(env.FREYA_ALLOW_LIVE_MODEL).toBe('0')
  })

  it('leaves the environment untouched when no config has been stored', async () => {
    const env: NodeJS.ProcessEnv = {
      NANOGPT_API_KEY: 'sk-env',
      NANOGPT_BASE_URL: 'https://nano-gpt.com/api/v1',
      NANOGPT_MODEL: 'env-model',
      FREYA_ALLOW_LIVE_MODEL: '1',
    }
    await store().applyToEnv(env)
    expect(env.NANOGPT_API_KEY).toBe('sk-env')
    expect(env.NANOGPT_BASE_URL).toBe('https://nano-gpt.com/api/v1')
    expect(env.NANOGPT_MODEL).toBe('env-model')
    expect(env.FREYA_ALLOW_LIVE_MODEL).toBe('1')
  })
})

/**
 * The precedence exactly as `main.ts` applies it: the `.env` loader runs first,
 * then the stored setting is overlaid, then the explicit launch snapshot is
 * restored last. These tests exercise that order with the real loader rather than
 * a hand-seeded object, so a change to the sequencing in `main.ts` that breaks the
 * contract is caught here.
 */
describe('provider configuration precedence (explicit > stored > .env)', () => {
  const KEYS = ['NANOGPT_API_KEY', 'NANOGPT_BASE_URL', 'NANOGPT_MODEL', 'FREYA_ALLOW_LIVE_MODEL'] as const

  async function withCleanEnv(run: () => Promise<void>): Promise<void> {
    const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]))
    for (const key of KEYS) delete process.env[key]
    try {
      await run()
    } finally {
      for (const key of KEYS) {
        if (saved[key] === undefined) delete process.env[key]
        else process.env[key] = saved[key]
      }
    }
  }

  it('lets the stored setting override .env', async () => {
    await withCleanEnv(async () => {
      const envPath = join(dir, '.env')
      await writeFile(envPath, 'NANOGPT_API_KEY=sk-file\nNANOGPT_MODEL=file-model\n', 'utf8')
      loadLocalEnv(envPath)
      expect(process.env.NANOGPT_API_KEY).toBe('sk-file')

      await store().write({ model: 'stored-model', liveEnabled: true, apiKey: 'sk-stored' })
      await store().applyToEnv(process.env, {})

      expect(process.env.NANOGPT_API_KEY).toBe('sk-stored')
      expect(process.env.NANOGPT_MODEL).toBe('stored-model')
      expect(process.env.FREYA_ALLOW_LIVE_MODEL).toBe('1')
    })
  })

  it('lets an explicit launch value beat both the store and .env', async () => {
    await withCleanEnv(async () => {
      const envPath = join(dir, '.env')
      await writeFile(envPath, 'NANOGPT_API_KEY=sk-file\n', 'utf8')
      loadLocalEnv(envPath)

      await store().write({ model: 'stored-model', liveEnabled: true, apiKey: 'sk-stored' })
      await store().applyToEnv(process.env, { NANOGPT_API_KEY: 'sk-real' })

      expect(process.env.NANOGPT_API_KEY).toBe('sk-real')
      expect(process.env.NANOGPT_MODEL).toBe('stored-model')
    })
  })

  it('leaves a .env credential and live flag alone when the store owns neither', async () => {
    await withCleanEnv(async () => {
      const envPath = join(dir, '.env')
      await writeFile(envPath, 'NANOGPT_API_KEY=sk-file\nFREYA_ALLOW_LIVE_MODEL=1\n', 'utf8')
      loadLocalEnv(envPath)

      await store().write({ baseUrl: 'https://nano-gpt.com/api/v1' })
      await store().applyToEnv(process.env, {})

      expect(process.env.NANOGPT_API_KEY).toBe('sk-file')
      expect(process.env.NANOGPT_BASE_URL).toBe('https://nano-gpt.com/api/v1')
      expect(process.env.FREYA_ALLOW_LIVE_MODEL).toBe('1')
    })
  })
})
