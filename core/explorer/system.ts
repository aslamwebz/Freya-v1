import type { ExplorerSnapshot } from '../../shared/contracts/explorer'
import type { RuntimeProjection } from '../runtime/types'
import type { CoreStatus } from '../protocol/core-protocol'
import type { ToolCatalogueView } from '../protocol/tool-catalogue'
import type { SkillProjection } from '../protocol/skills'
import type { WorkforceProjection } from '../protocol/workforce'
import type { MissionProjection } from '../missions/types'
import type { GoalProjectionView } from '../protocol/longhorizon'
import type { CoreActivityEvent } from '../protocol/activity'
import type { VoiceProjection } from '../protocol/conversation'
import type { WorkProjection } from '../work/projection'

export interface SystemResources { skills: SkillProjection; workforce: WorkforceProjection; missions: MissionProjection; goals: GoalProjectionView; activity: CoreActivityEvent[]; voice: VoiceProjection; work: WorkProjection; vault: string; intelligence: boolean | null }

export function systemExplorer(runtime: RuntimeProjection, status: CoreStatus, tools: ToolCatalogueView, resources?: SystemResources): ExplorerSnapshot {
  const nodes: ExplorerSnapshot['nodes'] = runtime.domains.map(domain => ({ id: domain.id, name: domain.title, type: domain.family, purpose: domain.note || domain.reason, status: domain.status, process: 'Core', source: domain.module, updatedAt: domain.changedAt ?? runtime.generatedAt, version: null, actions: [], detail: { reason: domain.reason, activation: domain.activation, missing: domain.missing, evidence: domain.evidence } }))
  const edges: ExplorerSnapshot['edges'] = []
  nodes.push({ id: 'process.core', name: 'Freya Core', type: 'process', purpose: 'Owner authority, encrypted persistence and runtime admission', status: status.lifecycle, process: 'Core', source: 'electron/runtime-core.ts', updatedAt: runtime.generatedAt, version: null, actions: [] })
  for (const domain of runtime.domains) {
    edges.push({ id: `owns:${domain.id}`, from: 'process.core', to: domain.id, kind: 'architecture', label: 'owns runtime admission' })
    for (const evidence of domain.evidence) {
      const id = `dependency:${evidence.kind}:${evidence.key ?? ''}`
      if (!nodes.some(node => node.id === id)) nodes.push({ id, name: evidence.label, type: 'dependency', purpose: evidence.detail, status: evidence.satisfied ? 'satisfied' : 'missing', process: 'Core', source: 'Core runtime dependency evidence', updatedAt: runtime.generatedAt, version: null, actions: [] })
      edges.push({ id: `${domain.id}:${id}`, from: domain.id, to: id, kind: 'architecture', label: evidence.required ? 'requires' : 'degrades without' })
    }
    const id = `source:${domain.module}`
    if (!nodes.some(node => node.id === id)) nodes.push({ id, name: domain.module, type: 'source', purpose: 'Registered implementation module', status: 'registered', process: 'Development worktree', source: domain.module, updatedAt: null, version: null, actions: ['source'] })
    edges.push({ id: `${domain.id}:source`, from: domain.id, to: id, kind: 'architecture', label: 'implemented by' })
  }
  for (const provider of status.providers) {
    const id = `provider:${provider.id}`
    nodes.push({ id, name: provider.id, type: 'provider', purpose: provider.detail ?? provider.kind, status: provider.status, process: 'Freya', source: 'Core provider status', updatedAt: runtime.generatedAt, version: null, actions: ['settings/provider'] })
    edges.push({ id: `core:${id}`, from: 'process.core', to: id, kind: 'architecture', label: 'admits provider calls' })
  }
  for (const tool of tools.tools) {
    const id = `tool:${tool.name}`
    nodes.push({ id, name: tool.name, type: 'tool', purpose: tool.description, status: 'registered', process: 'Freya', source: 'Core tool catalogue', updatedAt: runtime.generatedAt, version: null, actions: ['office/tools'], detail: { capability: tool.capability, parameters: tool.parameters } })
    edges.push({ id: `core:${id}`, from: 'process.core', to: id, kind: 'architecture', label: 'authorizes capability' })
  }
  if (resources) {
    const add = (node: ExplorerSnapshot['nodes'][number], parent = 'process.core', kind: 'architecture' | 'activity' = 'architecture') => {
      nodes.push(node); edges.push({ id: `${parent}:${node.id}`, from: parent, to: node.id, kind, label: kind === 'activity' ? 'observed runtime activity' : 'owns resource' })
    }
    add({ id: 'store.vault', name: 'Encrypted Vault', type: 'storage', purpose: 'The canonical SQLCipher store. No key or raw connection is exposed.', status: resources.vault, process: 'Core', source: 'Core Vault open result', updatedAt: runtime.generatedAt, version: null, actions: ['vault'] })
    if (resources.intelligence !== null) {
      add({ id: 'process.freya', name: 'Freya intelligence process', type: 'process', purpose: 'Models, planning, memory reasoning and Workforce execution', status: resources.intelligence ? 'connected' : 'disconnected', process: 'Freya', source: 'Core authenticated intelligence connection', updatedAt: runtime.generatedAt, version: null, actions: [] })
      add({ id: 'process.superapp', name: 'Superapp', type: 'process', purpose: 'Owner desktop client. Process health is in the Control Center.', status: 'registered', process: 'Superapp', source: 'Core process architecture configuration', updatedAt: runtime.generatedAt, version: null, actions: [] })
    }
    add({ id: 'service.voice', name: 'Voice services', type: 'voice', purpose: `Microphone ${resources.voice.micEnabled ? 'enabled' : 'disabled'} · permission ${resources.voice.permission}`, status: resources.voice.state, process: 'Core and Superapp', source: 'Core Voice projection', updatedAt: runtime.generatedAt, version: null, actions: ['settings/voice'] })
    add({ id: 'service.approvals', name: 'Approvals', type: 'security', purpose: `${resources.work.counts.pendingApprovals} pending approvals`, status: resources.work.counts.pendingApprovals ? 'awaiting-approval' : resources.work.health, process: 'Core', source: 'Core Work approval projection', updatedAt: runtime.generatedAt, version: null, actions: ['workflows/tasks'] })
    add({ id: 'service.spending', name: 'Budget and spending', type: 'economic', purpose: `${status.sessionUsage.calls} provider calls · ${status.sessionUsage.unknownUsageCalls} calls with incomplete usage. Monetary cost is not reported.`, status: status.governor.status, process: 'Core', source: 'Core Governor and provider usage', updatedAt: runtime.generatedAt, version: null, actions: ['settings/spending'], detail: { sessionUsage: status.sessionUsage, durableUsage: status.durableUsage, grantsActive: status.governor.grantsActive } })
    for (const provider of status.providers) if (provider.model) add({ id: `model:${provider.id}:${provider.model}`, name: provider.model, type: 'model', purpose: `${provider.id} configured model · ${provider.detail}`, status: provider.status, process: 'Freya', source: 'Core provider configuration', updatedAt: runtime.generatedAt, version: null, actions: ['settings/provider'] }, `provider:${provider.id}`)
    for (const skill of resources.skills.skills) add({ id: `skill:${skill.skillId}`, name: skill.name, type: 'skill', purpose: `${skill.kind} · ${skill.verification}`, status: skill.status, process: 'Core', source: 'Core Skills registry', updatedAt: skill.updatedAt, version: String(skill.version), actions: ['office/skills'], detail: { ...skill } })
    for (const worker of resources.workforce.workers) add({ id: `agent:${worker.workerId}`, name: worker.name, type: 'agent', purpose: worker.specialization ?? 'Workforce worker', status: worker.state, process: 'Freya', source: 'Core Workforce projection', updatedAt: runtime.generatedAt, version: null, actions: ['office/agents'], detail: { capabilities: worker.capabilities, budget: worker.budget, assignment: worker.assignment } })
    for (const mission of resources.missions.missions) add({ id: `mission:${mission.missionId}`, name: mission.missionId, type: 'mission', purpose: `Mission · ${mission.availableActions.join(', ') || 'no available action'}`, status: mission.status, process: 'Core and Freya', source: 'Core Mission projection', updatedAt: mission.createdAt, version: null, actions: ['missions/missions'], detail: { ...mission } })
    for (const goal of resources.goals.goals) add({ id: `goal:${goal.goalId}`, name: goal.goalId, type: 'goal', purpose: 'Long-horizon goal · private content remains in Core', status: goal.state, process: 'Core and Freya', source: 'Core Goal projection', updatedAt: goal.createdAt, version: null, actions: ['missions/goals'], detail: { ...goal } })
    for (const event of resources.activity.slice(-16)) add({ id: `event:${event.id}`, name: event.kind, type: 'event', purpose: event.text, status: event.tone, process: 'Core', source: 'Core authorized activity projection', updatedAt: new Date(event.at).toISOString(), version: String(event.sequence), actions: [] }, 'process.core', 'activity')
  }
  return { generatedAt: runtime.generatedAt, source: 'Authenticated Core runtime registry, dependency evidence and tool catalogue', nodes, edges, limitations: ['Runtime facts and architectural dependencies are read-only. Resource controls use existing owner commands.', 'A registered module is not evidence of current process activity. Source changes remain in an isolated development worktree.'] }
}
