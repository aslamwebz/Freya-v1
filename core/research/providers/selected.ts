import { DEFAULT_CAPABILITY_SELECTION, type CapabilityPreferences, type ProviderId } from '../../capabilities'
import { ResearchError } from '../errors'
import type { SearchProvider, SearchQueryOptions, SearchResult, SearchVertical } from '../types'

/** Resolve a saved preference per request. Failure is never retried through another backend. */
export class SelectedSearchProvider implements SearchProvider {
  readonly id: string
  constructor(private readonly capability: 'search' | 'eye', private readonly providers: readonly SearchProvider[], private readonly preferences: () => CapabilityPreferences) { this.id = `selected-${capability}` }
  private ordered(): SearchProvider[] {
    const order = this.preferences()[this.capability] ?? DEFAULT_CAPABILITY_SELECTION[this.capability]
    return order.flatMap((id: ProviderId) => this.providers.filter((provider) => provider.id === id))
  }
  status(): { ready: boolean; reason: string } {
    const available = this.ordered().find((provider) => provider.status().ready)
    return available?.status() ?? { ready: false, reason: 'No configured search adapter matches the saved provider order.' }
  }
  supports(vertical: SearchVertical): boolean { return this.ordered().some((provider) => provider.status().ready && (provider.supports?.(vertical) ?? vertical === 'web')) }
  async search(query: string, options: SearchQueryOptions): Promise<SearchResult[]> {
    const vertical = options.vertical ?? 'web'
    const provider = this.ordered().find((candidate) => candidate.status().ready && (candidate.supports?.(vertical) ?? vertical === 'web'))
    if (!provider) throw new ResearchError('unconfigured')
    return (await provider.search(query, options)).map((row) => ({ ...row, providerId: provider.id }))
  }
}
