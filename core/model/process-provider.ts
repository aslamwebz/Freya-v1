import type { RpcPeer } from '../../shared/runtime/rpc'
import type { ModelCatalogEntry, ProviderStatus } from '../../shared/contracts/model'
import { ModelRequestCancelled, type ModelProvider } from './provider'

/** Actual inference stays in Freya; Core's existing Gateway retains its contact gate. */
export class ProcessProviders {
  private peer: RpcPeer | null = null
  private statuses = new Map<string, ProviderStatus>()
  private catalogues = new Map<string, readonly ModelCatalogEntry[]>()
  constructor(private readonly developer?: 'echo' | 'slow-echo', private readonly researchFixture = false) {}
  connect(peer: RpcPeer, statuses: ProviderStatus[]): void { this.peer = peer; this.statuses = new Map(statuses.map(status => [status.id, status])); this.catalogues.clear() }
  all(): ModelProvider[] {
    const ids = this.researchFixture ? ['fixture-research'] : ['minimax', 'nanogpt', 'local', 'openai', ...(this.developer ? [this.developer === 'echo' ? 'fake' : 'slow-echo'] : [])]
    return ids.map(id => ({
      id, kind: ['slow-echo', 'fixture-research'].includes(id) ? 'fake' : id as ModelProvider['kind'], live: !['fake', 'slow-echo', 'fixture-research'].includes(id),
      status: () => this.peer?.connected && this.statuses.has(id) ? this.statuses.get(id)! : {
        id, kind: ['slow-echo', 'fixture-research'].includes(id) ? 'fake' : id as ModelProvider['kind'], status: 'unconfigured',
        model: null, detail: 'Freya intelligence process is disconnected.', liveEnabled: false,
      },
      servesModel: model => this.statuses.get(id)?.model === model || this.catalogues.get(id)?.some(entry => entry.id === model) === true,
      complete: async (request, options) => {
        if (!this.peer?.connected) throw new Error('Freya intelligence process is disconnected')
        const peer = this.peer
        const cancel = () => { if (peer.connected) void peer.call('provider.cancel', { requestId: request.requestId }).catch(() => {}) }
        if (options.signal.aborted) throw new ModelRequestCancelled('model request was stopped before dispatch')
        options.signal.addEventListener('abort', cancel, { once: true })
        try {
          const result = await peer.call<Awaited<ReturnType<ModelProvider['complete']>>>('provider.complete', { id, request })
          if (options.signal.aborted) throw new ModelRequestCancelled('model request was stopped')
          return result
        } catch (error) {
          if (options.signal.aborted) throw new ModelRequestCancelled('model request was stopped')
          throw error
        } finally { options.signal.removeEventListener('abort', cancel) }
      },
      listModels: async ({ signal }) => {
        if (!this.peer?.connected || signal.aborted) throw new Error('Freya intelligence process is disconnected or stopped')
        const entries = await this.peer.call<readonly ModelCatalogEntry[]>('provider.catalogue', { id })
        this.catalogues.set(id, entries); return entries
      },
    }))
  }
}
