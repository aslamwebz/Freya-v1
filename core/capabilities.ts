/** Closed provider/capability vocabulary and non-secret, host-validated preferences.
 * Runtime adapters report readiness per capability; a key alone never establishes support.
 */

export const PROVIDER_IDS = [
  'minimax',
  'nanogpt',
  'local',
  'loopback',
  'openai',
  'searxng',
  'brave',
  'native',
] as const

export type ProviderId = (typeof PROVIDER_IDS)[number]

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value)
}

/**
 * The closed list of things Freya can do.
 *
 * `chat` is the conversational brain. `search` is web/image/video/document
 * retrieval. `browser` is the in-app web surface. `eye` is Freya's persistent
 * media discovery sessions. `vision` is image understanding for attachments.
 * `tts` and `stt` are voice. `imageGen` is for image creation.
 */
export const CAPABILITY_IDS = [
  'chat',
  'search',
  'browser',
  'eye',
  'vision',
  'tts',
  'stt',
  'imageGen',
] as const

export type CapabilityId = (typeof CAPABILITY_IDS)[number]

export function isCapabilityId(value: unknown): value is CapabilityId {
  return typeof value === 'string' && (CAPABILITY_IDS as readonly string[]).includes(value)
}

/**
 * One row in the settings list.
 *
 * `providers` is the **ordered preference list** the owner has chosen. The first
 * entry is what Freya tries first; the second is the fallback; and so on.
 * `available` is what each provider actually answered at the last readiness
 * check, and is rendered to the owner without inventing one.
 */
export interface CapabilitySelection {
  readonly capability: CapabilityId
  readonly providers: readonly ProviderId[]
  /**
   * The provider that last answered a readiness call as ready, or `null` when
   * none did. Distinct from `providers[0]` because a configured provider may
   * also be unreachable.
   */
  readonly available: ProviderId | null
  /**
   * Why the capability is in the state it is in. Same shape as
   * `ProviderCredentialState` — a fixed sentence, never a value.
   */
  readonly status: 'ready' | 'unconfigured' | 'disabled' | 'unknown'
  readonly reason: string | null
}

export interface CapabilityRegistry {
  chat: CapabilitySelection
  search: CapabilitySelection
  browser: CapabilitySelection
  eye: CapabilitySelection
  vision: CapabilitySelection
  tts: CapabilitySelection
  stt: CapabilitySelection
  imageGen: CapabilitySelection
}

/** Capability defaults, followed by real adapter alternatives.
 * Search/Eye select retrieval backends; browser selects the assistance model.
 * Voice and image readiness requires its own installed adapter.
 */
export const DEFAULT_CAPABILITY_SELECTION: Readonly<Record<CapabilityId, readonly ProviderId[]>> = Object.freeze({
  chat: ['minimax', 'nanogpt', 'local'],
  // MiniMax first, matching `eye` below.
  //
  // This was `['searxng', 'brave', 'minimax']`, on the reasoning that a locally
  // running metasearch daemon needs no credential and so should be tried first.
  // That reasoning holds for a daemon you control and fails for one you merely
  // expect to be up: the search runs, returns nothing, and because the failure is
  // not retried across backends — deliberately, so a result's provenance always
  // names the backend that served it — a turn that looked things up got zero
  // sources and no fallback.
  //
  // So the order now puts a provider that answers first. Verified against the
  // live endpoint while fixing this: the same query returned HTTP 200 with real
  // results from MiniMax and nothing usable from the SearXNG instance. An owner
  // who prefers their own daemon can still select it, and the others remain
  // fallbacks.
  search: ['minimax', 'searxng', 'brave'],
  browser: ['minimax'],
  eye: ['minimax', 'searxng', 'brave'],
  vision: ['minimax', 'nanogpt'],
  tts: ['minimax', 'nanogpt', 'native'],
  stt: ['minimax', 'nanogpt', 'local'],
  imageGen: ['minimax', 'nanogpt'],
})

/**
 * Build a registry from a partial selection.
 *
 * Missing entries fall back to {@link DEFAULT_CAPABILITY_SELECTION}. This is
 * the only place the defaults are applied: anything that reads the registry
 * receives a fully populated one, so a caller never has to default again.
 */
export function buildCapabilityRegistry(
  selection: Partial<Record<CapabilityId, readonly ProviderId[]>> = {},
): CapabilityRegistry {
  const base = DEFAULT_CAPABILITY_SELECTION
  const at = <T extends CapabilityId>(capability: T, fallback: readonly ProviderId[]): readonly ProviderId[] => {
    const override = selection[capability]
    if (override === undefined || override.length === 0) return fallback
    return override
  }
  const fill = (capability: CapabilityId): CapabilitySelection => ({
    capability,
    providers: at(capability, base[capability]),
    available: null,
    status: 'unknown',
    reason: null,
  })
  return {
    chat: fill('chat'),
    search: fill('search'),
    browser: fill('browser'),
    eye: fill('eye'),
    vision: fill('vision'),
    tts: fill('tts'),
    stt: fill('stt'),
    imageGen: fill('imageGen'),
  }
}

/**
 * Apply a partial readiness map to a registry.
 *
 * `readiness` is what each provider answered when it was asked whether it
 * could run, keyed by `ProviderId`. The output reports the first provider in
 * the preference list that answered ready — and reports `unconfigured` only
 * when none of the preference list answered ready AND none of them are even
 * known to this build.
 */
export function applyReadiness(
  registry: CapabilityRegistry,
  readiness: Readonly<Partial<Record<ProviderId, { readonly ready: boolean; readonly reason: string }>>>,
): CapabilityRegistry {
  const next: CapabilityRegistry = { ...registry }
  for (const capability of CAPABILITY_IDS) {
    const selection = registry[capability]
    let resolved: ProviderId | null = null
    let reason: string | null = null
    for (const provider of selection.providers) {
      const status = readiness[provider]
      if (status?.ready === true) {
        resolved = provider
        reason = null
        break
      }
      if (status !== undefined && reason === null) reason = status.reason
    }
    const knownAny = selection.providers.some((provider) => readiness[provider] !== undefined)
    const status: CapabilitySelection['status'] = resolved !== null
      ? 'ready'
      : !knownAny
        ? 'unconfigured'
        : 'disabled'
    next[capability] = { ...selection, available: resolved, status, reason }
  }
  return next
}

/**
 * Re-order a capability's preference list, validating ids and preserving at
 * least one entry. Used by Settings writes so the renderer cannot smuggle in a
 * non-existent provider or empty the list.
 */
export function withCapabilityPreference(
  registry: CapabilityRegistry,
  capability: CapabilityId,
  providers: readonly ProviderId[],
): CapabilityRegistry {
  if (providers.length === 0) return registry
  const filtered = providers.filter((id): id is ProviderId => isProviderId(id))
  if (filtered.length === 0) return registry
  return { ...registry, [capability]: { ...registry[capability], providers: filtered } }
}

export function describeProvider(id: ProviderId): string {
  switch (id) {
    case 'native': return 'Device voice'
    case 'searxng': return 'SearXNG'
    case 'brave': return 'Brave Search'
    case 'openai': return 'OpenAI'
    case 'minimax':
      return 'MiniMax'
    case 'nanogpt':
      return 'NanoGPT'
    case 'local':
      return 'Local small model'
    case 'loopback':
      return 'Loopback (development only)'
  }
}

export function describeCapability(capability: CapabilityId): { readonly name: string; readonly blurb: string } {
  switch (capability) {
    case 'chat':
      return { name: 'Conversation brain', blurb: 'The model that answers ordinary Chat turns.' }
    case 'search':
      return { name: 'Web search', blurb: 'The configured backend that retrieves web and media results.' }
    case 'browser':
      return { name: 'Browser assistance', blurb: 'Freya\u2019s own embedded web surface — always on, always isolated.' }
    case 'eye':
      return { name: "Freya's Eye", blurb: 'Persistent media-discovery sessions.' }
    case 'vision':
      return { name: 'Vision', blurb: 'Image understanding for attachments and screenshots.' }
    case 'tts':
      return { name: 'Speech synthesis', blurb: 'Text-to-speech for voice output.' }
    case 'stt':
      return { name: 'Speech recognition', blurb: 'Speech-to-text for voice input.' }
    case 'imageGen':
      return { name: 'Image generation', blurb: 'Creating images from a prompt.' }
  }
}
/** Non-secret settings accepted across the host boundary. */
export type CapabilityPreferences = Partial<Record<CapabilityId, readonly ProviderId[]>>
export function validateCapabilityPreferences(value: unknown): CapabilityPreferences {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid capability preferences.')
  const result: CapabilityPreferences = {}
  for (const [capability, providers] of Object.entries(value)) {
    if (!isCapabilityId(capability) || !Array.isArray(providers) || providers.length === 0 || providers.length > PROVIDER_IDS.length || providers.some((id) => !isProviderId(id)) || new Set(providers).size !== providers.length) throw new Error('Invalid capability preference IDs or order.')
    result[capability] = [...providers]
  }
  return result
}
export type CapabilityReadiness = Partial<Record<CapabilityId, Partial<Record<ProviderId, { ready: boolean; reason: string }>>>>
export function applyCapabilityReadiness(registry: CapabilityRegistry, readiness: CapabilityReadiness): CapabilityRegistry {
  const result = { ...registry }
  for (const capability of CAPABILITY_IDS) result[capability] = applyReadiness(registry, readiness[capability] ?? {})[capability]
  return result
}
