import { safeResearchError, ResearchError } from '../errors'
import type { SearchProvider, SearchQueryOptions, SearchResult, SearchVertical } from '../types'

/**
 * Pick whichever configured provider can actually answer.
 *
 * Freya can be configured with more than one search backend, and the order is a
 * preference rather than a requirement: a locally-running metasearch daemon needs
 * no credential and so is preferred, while a keyed provider is a fine fallback for
 * an install that has one.
 *
 * ## No cross-provider retry
 *
 * If the chosen provider fails, that failure is reported. Silently trying the
 * next one would mean the answer came from somewhere the caller never chose, and
 * the provenance attached to the result would name a backend that is not the one
 * that produced it. A provider that cannot answer says so.
 *
 * The choice is made per call rather than cached, because readiness is genuinely
 * volatile here: a daemon may not be running yet, and a provider can be turned off
 * by an environment change without this process restarting.
 */
export class PreferredSearchProvider implements SearchProvider {
  readonly id: string
  readonly #providers: readonly SearchProvider[]

  constructor(providers: readonly SearchProvider[]) {
    this.#providers = providers.filter((provider) => provider !== null && provider !== undefined)
    if (this.#providers.length === 0) throw new Error('a search provider stack needs at least one provider')
    this.id = this.#providers.map((provider) => provider.id).join('+')
  }

  status(): { ready: boolean; reason: string } {
    for (const provider of this.#providers) {
      const status = provider.status()
      if (status.ready) return status
    }
    // Every provider's own reason is worth keeping, because "not configured" and
    // "disabled" call for different corrections and collapsing them would leave the
    // owner guessing which one they have.
    const reasons = [...new Set(this.#providers.map((provider) => provider.status().reason))]
    return { ready: false, reason: reasons.join('; ') }
  }

  supports(vertical: SearchVertical): boolean {
    return this.#providers.some((provider) => provider.supports?.(vertical) ?? false)
  }

  async search(query: string, options: SearchQueryOptions): Promise<SearchResult[]> {
    const vertical = options.vertical ?? 'web'
    for (const provider of this.#providers) {
      if (provider.status().ready && (provider.supports?.(vertical) ?? false)) {
        return provider.search(query, { ...options, vertical })
      }
    }
    // Nothing configured can serve this. Distinguish "no backend at all" from
    // "backends exist but none of them does images", because the second is a
    // capability gap and the first is a setup gap.
    const anyReady = this.#providers.some((provider) => provider.status().ready)
    throw safeResearchError(
      anyReady ? new ResearchError('unconfigured') : null,
      anyReady ? 'unconfigured' : 'disabled',
    )
  }
}