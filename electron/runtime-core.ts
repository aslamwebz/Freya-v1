import { app, safeStorage } from 'electron'
import { join, resolve } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'
import { ElectronCoreHost, type HostEnv } from './coreHost'
import { loadKeyring, KEY_DOMAINS } from './keyring'
import { loadLocalEnv } from './localEnv'
import { ProviderConfigStore } from './providerConfig'
import { createFreyaVaultBinding } from './vaultBinding'
import { e2eKeys } from './runtime-fixtures'
import { RuntimePlatform } from './runtime-platform'
import { buildRuntimeDeviceHands } from './runtime-devicehands'
import { VoiceConfigStore, VOICE_FOLLOW_UP_WINDOW_MS } from './voiceConfig'
import { CapabilitySettingsStore } from './capabilitySettings'
import { createSystemWindowProvider } from './context/windowProviders'
import { createConnectorRuntime } from './connectors/runtime'

const profile = resolve(required('FREYA_RUNTIME_PROFILE'))
const root = resolve(__dirname, '..')
const dataPath = join(profile, 'core-events.jsonl')
mkdirSync(join(profile, '.runtime', 'core-electron'), { recursive: true })
app.setPath('userData', join(profile, '.runtime', 'core-electron'))
app.setName('Freya Core')
loadLocalEnv(join(root, '.env'))
let host: ElectronCoreHost | null = null

app.whenReady().then(async () => {
  const config = new ProviderConfigStore(join(profile, 'provider.json'))
  await config.applyToEnv(process.env, {})
  const testProfile = process.env.FREYA_RUNTIME_TEST_PROFILE === '1' && process.env.FREYA_E2E === '1'
  if (testProfile) process.env.FREYA_ALLOW_LIVE_MODEL = '0'
  if (testProfile && existsSync(`${dataPath}.keyring.json`)) throw new Error('test keys cannot replace an existing keyring')
  const keys = testProfile
    ? KEY_DOMAINS.reduce((keys, domain, index) => { keys[domain] = { key: e2eKeys()?.[domain] ?? new Uint8Array(32).fill(index + 1), reason: null }; return keys }, {} as Pick<Awaited<ReturnType<typeof loadKeyring>>, typeof KEY_DOMAINS[number]>)
    : await loadKeyring(dataPath)
  for (const domain of KEY_DOMAINS) if (!keys[domain].key) console.error(`[core] ${domain} encryption unavailable: ${keys[domain].reason}`)
  const binding = process.platform === 'win32' ? createFreyaVaultBinding(join(root, 'native', 'sqlcipher', 'win32-x64', 'better_sqlite3-electron44.node')) : undefined
  const developer = process.env.FREYA_DEV_PROVIDER
  const platform = new RuntimePlatform()
  const hands = buildRuntimeDeviceHands(profile, platform.hands, (principal, scope) => host?.ownerBrowserGrant(principal, scope) ?? null)
  const voice = new VoiceConfigStore(join(profile, 'voice.json')); await voice.load()
  const capabilityStore = new CapabilitySettingsStore(join(profile, 'capabilities.json'))
  let preferences = await capabilityStore.read()
  host = new ElectronCoreHost(dataPath, { ...process.env } as HostEnv, {
    ...(hands ? { deviceHands: hands } : {}),
    ...(['own-app', 'system'].includes(process.env.FREYA_CONTEXT_WINDOW_OBSERVATION ?? '') ? {
      windowObservation: { enabled: true, provider: process.env.FREYA_CONTEXT_WINDOW_OBSERVATION === 'own-app' ? platform.window : createSystemWindowProvider(), scope: { scopeKind: 'surface' as const, scopeId: 'desktop-window' } },
    } : {}),
    capabilityPreferences: () => preferences,
    voiceStt: platform.stt, voiceTts: platform.tts,
    voiceAttentionTimeoutMs: () => voice.current.attentionTimeoutMs,
    voiceAutoSpeak: voice.legacyCurrent.autoSpeak, voiceProactiveAlerts: voice.legacyCurrent.proactiveAlerts,
    voiceMuted: voice.legacyCurrent.ttsProvider === 'off', voiceFollowUpWindowMs: VOICE_FOLLOW_UP_WINDOW_MS,
    connectorRuntime: async () => {
      const runtime = await createConnectorRuntime({ safeStorage, tokenFilePath: `${dataPath}.connectors.tokens`, configs: {},
        oauthClient: { async exchange() { throw new Error('no connector OAuth client is configured') }, async refresh() { throw new Error('no connector OAuth client is configured') } }, fetchImpl: fetch as never })
      return { auth: runtime.auth }
    },

    conversationKey: keys.conversation.key, brainKey: keys.brain.key, missionKey: keys.mission.key,
    contextKey: keys.context.key, attentionKey: keys.attention.key, personalityKey: keys.personality.key, skillKey: keys.skill.key, forgeKey: keys.forge.key,
    vault: { path: join(profile, 'vault', 'freya.db'), keyProvider: { load: async () => keys.vault }, ...(binding ? { binding } : {}) },
    ...(developer === 'echo' || developer === 'slow-echo' ? { developerProvider: developer } : {}),
    processRuntime: {
      owner: {
      connect: (peer, descriptors) => platform.connect(peer, descriptors),
      configure: async env => { preferences = await capabilityStore.read(); await voice.load(); await host!.restartWithEnv(env as HostEnv) },
      refreshPreferences: async () => { preferences = await capabilityStore.read(); await voice.load() },
      capabilities: () => host!.capabilityReadiness(),
      deviceHands: request => host!.performDeviceHandsAction(request as Parameters<ElectronCoreHost['performDeviceHandsAction']>[0]),
      ownerBrowser: request => host!.performOwnerBrowserAction(request as Parameters<ElectronCoreHost['performOwnerBrowserAction']>[0]),
      browserJournal: (operation, value) => {
        if (!hands) throw new Error('Device Hands journal is unavailable')
        if (operation === 'status') return { trustworthy: hands.journal.trustworthy(), path: hands.journal.path() }
        if (operation === 'replay') return hands.journal.replay()
        const record = value as { type: string; payload: Parameters<NonNullable<ReturnType<ElectronCoreHost['deviceHandsJournal']>>['append']>[1] }
        if (!record.type.startsWith('browser.')) throw new Error('Superapp can append only existing browser events')
        return hands.journal.append(record.type as never, record.payload)
      },
    },
      ownerEndpoint: required('FREYA_CORE_OWNER_ENDPOINT'), intelligenceEndpoint: required('FREYA_CORE_INTELLIGENCE_ENDPOINT'),
      ownerToken: required('FREYA_OWNER_TOKEN'), intelligenceToken: required('FREYA_INTELLIGENCE_TOKEN'), supervisorToken: required('FREYA_SUPERVISOR_TOKEN'),
    },
  })
  host.attachDualBrowser(platform.browser); host.attachBrowserTabs(platform.tabs)
  await host.start()
  console.log(`[core] protected stores, journal and admission ready; pid=${process.pid}`)
}).catch(error => { console.error('[core] startup failed', error instanceof Error ? error.message : 'unknown failure'); app.exit(1) })

app.on('window-all-closed', () => {})
process.on('SIGTERM', () => { void host?.stop('supervisor restart').finally(() => app.exit(0)) })
function required(name: string): string { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value }
