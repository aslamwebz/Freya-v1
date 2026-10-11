import type { CoreCommandEnvelope, CoreCommandResult } from '../protocol/core-protocol'
import type { Guard, Principal } from '../security/guard'
import type { WorldRelationGraphView } from '../protocol/world'
import type { LearningRecordsOutcome } from '../protocol/learning'
import type { SourceRequest } from '../../shared/contracts/explorer'
import type { Vault } from '../vault/vault'
import type { SourceWorkspace } from './source-workspace'
import { VaultExplorer, validateVaultRequest } from '../vault/explorer'
import type { systemExplorer } from './system'
export { systemExplorer } from './system'

interface ExplorerContext {
  owner: Principal; guard: Guard; stopped: boolean; vaultFault: string | null
  ensureVault(): Promise<Vault | null>
  audit(payload: { commandId: string; contentLength: number; source: string }): Promise<unknown>
  newId(): string
  world(): WorldRelationGraphView
  records(): LearningRecordsOutcome | undefined
  learningEncrypted: boolean
  source(): SourceWorkspace
  system(): ReturnType<typeof systemExplorer>
}
export const EXPLORER_COMMANDS = new Set(['vault.explorer', 'development.source', 'system.explorer.read'])
export async function handleExplorerCommand(envelope: CoreCommandEnvelope, context: ExplorerContext): Promise<CoreCommandResult> {
  const { command, requestId } = envelope
  const reject = (_: CoreCommandEnvelope, reason: string): CoreCommandResult => ({ requestId, ok: false, refusal: { reason } })
  const carriesFields = (value: unknown) => value !== undefined && value !== null && (typeof value !== 'object' || Object.keys(value).length > 0)
  switch (command) {
        case 'vault.explorer': {
          validateVaultRequest(envelope.payload)
          const request = envelope.payload
          const reading = ['catalog', 'read', 'history', 'export'].includes(request.operation)
          const decision = context.guard.evaluate(context.owner, reading ? 'core.status.read' : 'core.command.submit')
          if (!decision.allowed) return reject(envelope, decision.reason)
          if (!reading && context.stopped) return reject(envelope, 'STOP ALL blocks Vault changes')
          const vault = await context.ensureVault()
          if (!vault) return reject(envelope, context.vaultFault ?? 'Encrypted Vault is unavailable; no plaintext fallback is permitted')
          if (!reading) await context.audit({ commandId: context.newId(), contentLength: request.content?.length ?? 0, source: `vault.${request.operation}` })
          const result = new VaultExplorer(vault).execute(request)
          if (result.explorer) {
            const graph = context.world()
            if (graph.persistence.mode === 'encrypted') {
              for (const node of graph.nodes) result.explorer.nodes.push({ id: `entity:${node.entityId}`, name: node.name ?? node.label ?? node.entityId, type: 'world entity', purpose: `${node.kind} · ${node.claimKind} · ${node.epistemic}`, status: node.withdrawn ? 'withdrawn' : node.freshness, process: 'Core', source: 'SQLCipher world evidence projection', updatedAt: node.lastObservedAt, version: String(graph.sequence), actions: [], detail: { ...node } })
              const known = new Set(result.explorer.nodes.map(node => node.id))
              for (const edge of graph.edges) if (known.has(`entity:${edge.fromEntityId}`) && known.has(`entity:${edge.toEntityId}`)) result.explorer.edges.push({ id: `world:${edge.edgeId}`, from: `entity:${edge.fromEntityId}`, to: `entity:${edge.toEntityId}`, kind: 'record', label: edge.relationType })
              if (graph.nodesHidden || graph.edgesHidden) result.explorer.limitations.push(`${graph.nodesHidden} world nodes and ${graph.edgesHidden} edges withheld by the authorized projection bounds.`)
            }
            const records = context.records()
            if (records?.ok && context.learningEncrypted) {
              for (const record of records.records.items) result.explorer.nodes.push({ id: `learning:${record.recordId}`, name: record.recordId, type: record.stage === 'experience' ? 'experience' : 'learning evidence', purpose: `${record.kind} · ${record.verificationStatus} · ${record.scope}`, status: record.status, process: 'Core', source: 'SQLCipher learning projection', updatedAt: record.lifecycleAt ?? record.recordedAt, version: null, actions: [], detail: { ...record } })
              if (records.records.truncated) result.explorer.limitations.push('Learning metadata listing is bounded; additional records are retained in Core.')
            }
            result.explorer.limitations.push('World and learning metadata are read-only projections; sensitive evidence is withheld by the existing domain policies. Owner-note CRUD does not modify those records.')
          }
          return { requestId, ok: true, vault: result }
        }
        case 'development.source': {
          const decision = context.guard.evaluate(context.owner, 'core.command.submit')
          if (!decision.allowed) return reject(envelope, decision.reason)
          if (context.stopped) return reject(envelope, 'STOP ALL blocks development operations')
          const request = envelope.payload as SourceRequest
          if (!request || typeof request.operation !== 'string') return reject(envelope, 'Source operation is missing')
          if (!['list', 'read', 'diff', 'search'].includes(request.operation)) await context.audit({ commandId: context.newId(), contentLength: request.content?.length ?? 0, source: `development.${request.operation}` })
          return { requestId, ok: true, source: await context.source().execute(request) }
        }
        case 'system.explorer.read': {
          if (carriesFields(envelope.payload)) return reject(envelope, 'System read accepts no fields')
          const decision = context.guard.evaluate(context.owner, 'core.status.read')
          if (!decision.allowed) return reject(envelope, decision.reason)
          return { requestId, ok: true, explorer: context.system() }
        }

    default: return reject(envelope, 'Unknown explorer command')
  }
}
