import { applyCapabilityReadiness, buildCapabilityRegistry, DEFAULT_CAPABILITY_SELECTION, PROVIDER_IDS, type CapabilityPreferences, type CapabilityReadiness, type CapabilityRegistry, type ProviderId } from '../capabilities'
import { NanoGptProvider, readNanoGptConfig, type NanoGptEnv } from './nanogpt-provider'
import { approveCompatibleEndpoint, CompatibleModelProvider, type CompatibleConfig, type CompatibleProviderId } from './compatible-provider'
import type { ModelProvider } from './provider'

export interface CapabilityEnv extends NanoGptEnv {
  MINIMAX_API_KEY?: string
  MINIMAX_BASE_URL?: string
  MINIMAX_MODEL?: string
  LOCAL_MODEL_BASE_URL?: string
  LOCAL_MODEL_MODEL?: string
  OPENAI_API_KEY?: string
  OPENAI_BASE_URL?: string
  OPENAI_MODEL?: string
  /** Explicit host declaration for non-MiniMax vision models, never inferred from a key. */
  FREYA_VISION_PROVIDERS?: string
}
export function compatibleConfig(id: CompatibleProviderId, env: CapabilityEnv): CompatibleConfig | null {
  const baseUrl = id === 'minimax' ? (env.MINIMAX_BASE_URL?.trim() || 'https://api.minimax.io/v1') : id === 'openai' ? (env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1') : env.LOCAL_MODEL_BASE_URL
  const model = id === 'minimax' ? env.MINIMAX_MODEL ?? 'MiniMax-M3' : id === 'openai' ? env.OPENAI_MODEL : env.LOCAL_MODEL_MODEL
  const apiKey = id === 'minimax' ? env.MINIMAX_API_KEY : id === 'openai' ? env.OPENAI_API_KEY : ''
  if (!baseUrl || !model || !/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,255}$/.test(model) || (id !== 'local' && !apiKey?.trim())) return null
  try { approveCompatibleEndpoint(id, baseUrl) } catch { return null }
  const vision = id === 'minimax' ? ['MiniMax-M3', 'MiniMax-M3.1-Flash-Preview'].includes(model) : (env.FREYA_VISION_PROVIDERS ?? '').split(',').includes(id)
  return { baseUrl, model, apiKey: apiKey?.trim() ?? '', liveEnabled: env.FREYA_ALLOW_LIVE_MODEL === '1', vision }
}
export function buildConfiguredModelProviders(env: CapabilityEnv): ModelProvider[] {
  return [new CompatibleModelProvider('minimax', compatibleConfig('minimax', env)), new NanoGptProvider({ config: readNanoGptConfig(env) }), new CompatibleModelProvider('local', compatibleConfig('local', env)), new CompatibleModelProvider('openai', compatibleConfig('openai', env))]
}
export function modelCapabilityPreference(env: CapabilityEnv, preferences: CapabilityPreferences, capability: 'chat' | 'vision' | 'browser'): readonly ProviderId[] {
  const order = preferences[capability] ?? DEFAULT_CAPABILITY_SELECTION[capability]
  return capability !== 'vision' ? order : order.filter((id) => id === 'nanogpt' ? (env.FREYA_VISION_PROVIDERS ?? '').split(',').includes(id) : ['minimax', 'local', 'openai'].includes(id) && compatibleConfig(id as CompatibleProviderId, env)?.vision === true)
}
export function readRuntimeCapabilityRegistry(env: CapabilityEnv, preferences: CapabilityPreferences = {}, extra: CapabilityReadiness = {}): CapabilityRegistry {
  const readiness: CapabilityReadiness = {}
  const providers = buildConfiguredModelProviders(env)
  for (const capability of ['chat', 'browser', 'vision'] as const) {
    const supported = modelCapabilityPreference(env, Object.fromEntries([[capability, ['minimax', 'nanogpt', 'local', 'openai']]]), capability)
    readiness[capability] = { ...Object.fromEntries(PROVIDER_IDS.map((id) => [id, { ready: false, reason: id === 'loopback' ? 'Development echo is not a production capability adapter.' : 'No inference adapter is installed for this provider.' }])), ...Object.fromEntries(providers.map((provider) => [provider.id, { ready: provider.status().status === 'configured' && supported.includes(provider.id as ProviderId), reason: supported.includes(provider.id as ProviderId) ? provider.status().detail : 'This model has no declared image support.' }])) }
  }
  for (const capability of ['tts', 'stt', 'imageGen', 'search', 'eye'] as const) readiness[capability] = Object.fromEntries(PROVIDER_IDS.map((id) => [id, { ready: false, reason: 'No adapter for this capability is installed and configured.' }]))
  for (const [capability, states] of Object.entries(extra)) readiness[capability as keyof CapabilityReadiness] = { ...readiness[capability as keyof CapabilityReadiness], ...states }
  return applyCapabilityReadiness(buildCapabilityRegistry(preferences), readiness)
}
