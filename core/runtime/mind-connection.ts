import type { RpcPeer } from '../../shared/runtime/rpc'
import type { MindRuntime, MindServiceOptions, MindSubmitInput, MindTurnResult } from '../mind/mind'
import type { CognitionIntent } from '../authority'
import type { CognitionGrantSpec } from '../cognition/grants'
import type { ConversationMessage, ConversationTurn } from '../conversation/types'
import { CONVERSATION_LIMITS } from '../conversation/types'
import { MIND_TOOL_LIMITS } from '../mind/tools'
import { TURN_GRANT_TTL_MS } from '../mind/turn-runner'
import type { MindTool } from '../mind/tools'
import { PROCESS_TOOL_NAMES } from '../mind/process-tools'
import { randomUUID } from 'node:crypto'

/** Core owns each foreground lease; a connected engine cannot invent owner turns. */
export class MindConnection implements MindRuntime {
  private peer: RpcPeer | null = null
  private options: MindServiceOptions | null = null
  private readonly active = new Map<string, { input: MindSubmitInput; startedAt: string; controller: AbortController; providerContacted: boolean; turn?: ConversationTurn; toolSteps: { name: string; capability: string; outcome: string; executed: boolean }[] }>()

  bind(options: MindServiceOptions): MindRuntime { this.options = options; return this }
  connect(peer: RpcPeer): void {
    if (this.peer?.connected) throw new Error('Freya is already connected')
    this.peer = peer
    peer.onClose(() => {
      if (this.peer !== peer) return
      this.peer = null
      for (const lease of this.active.values()) lease.controller.abort(new Error('Freya disconnected'))
    })
  }
  get connected(): boolean { return this.peer?.connected === true }
  tools(tools: readonly MindTool[]): readonly MindTool[] {
    return tools.map(tool => !PROCESS_TOOL_NAMES.has(tool.name) ? tool : { ...tool, run: request => this.runTool(tool.name, request) })
  }
  private async runTool(name: string, request: Parameters<MindTool['run']>[0]): Promise<Awaited<ReturnType<MindTool['run']>>> {
    const peer = this.peer
    if (!peer?.connected) throw new Error('Freya is disconnected; the admitted tool was not executed')
    request.signal?.throwIfAborted()
    const id = randomUUID()
    const cancel = () => { void peer.call('tool.cancel', { id }, 5_000).catch(() => {}) }
    request.signal?.addEventListener('abort', cancel, { once: true })
    try { return await peer.call('tool.run', { id, name, request: { arguments: request.arguments, context: request.context } }) }
    finally { request.signal?.removeEventListener('abort', cancel) }
  }
  activeTurn(conversationId: string) {
    const active = [...this.active.values()].find(value => value.input.conversationId === conversationId)
    return active ? { turnId: active.input.turnId, startedAt: active.startedAt } : null
  }
  cancelTurn(turnId: string, reason?: string): number {
    this.active.get(turnId)?.controller.abort(new Error(reason ?? 'the owner stopped this response'))
    const count = this.options?.gateway.cancelRequest(turnId, reason ?? 'the owner stopped this response') ?? 0
    if (this.peer?.connected) void this.peer.call('mind.cancel', { turnId, reason }).catch(() => {})
    return count
  }
  async runTurn(input: MindSubmitInput): Promise<MindTurnResult> {
    const options = this.options
    const peer = this.peer
    if (!options || !peer?.connected) throw new Error('Freya intelligence process is unavailable; the request was not executed')
    if (this.activeTurn(input.conversationId)) throw new Error('a response is already in progress for this conversation')
    const now = options.now?.() ?? new Date()
    const lease = { input, startedAt: now.toISOString(), controller: new AbortController(), providerContacted: false, turn: undefined as ConversationTurn | undefined,
      toolSteps: [] as { name: string; capability: string; outcome: string; executed: boolean }[] }
    this.active.set(input.turnId, lease)
    options.onTurnStateChange?.()
    const optional = <T>(read: () => T, fallback: T): T => { try { return read() } catch { return fallback } }
    try {
      return await peer.call<MindTurnResult>('mind.run', {
        input,
        context: {
          mode: options.store.mode, faultReason: options.store.faultReason,
          identity: options.identity, budget: options.budget,
          runtimeFacts: options.runtimeFacts?.() ?? [],
          selectedModel: options.selectedModel?.() ?? null, selectedProviderId: options.selectedProviderId?.() ?? null,
          matrixSpaceIds: options.matrixSpaceIds?.(input.conversationId) ?? [],
          reference: optional(() => options.recall?.(input.text) ?? null, null),
          learningAdvice: optional(() => options.learnedAdvice?.(input.text) ?? '', ''),
          sharedContext: optional(() => options.turnContext?.({ text: input.text, conversationId: input.conversationId, now }) ?? null, null),
          ledger: optional(() => options.expressionMemory?.readLedger() ?? null, null),
          facts: optional(() => options.interactionFacts?.() ?? [], []),
          relationships: optional(() => options.relationshipItems?.() ?? [], []),
          preferenceTokens: options.preferenceTokens?.() ?? [],
          tools: options.tools?.list().map(({ run: _run, ...tool }) => tool) ?? [],
        },
      })
    } catch (error) {
      // Never retry a paid or effectful turn. The existing interrupted outcome is durable.
      const reason = error instanceof Error ? error.message : 'Freya disconnected'
      const stored = await options.store.readConversation(input.conversationId)
      const terminal = stored?.turns.find(turn => turn.turnId === input.turnId && turn.outcome !== 'pending')
      if (terminal && terminal.outcome !== 'pending') return { turnId: input.turnId, conversationId: input.conversationId, outcome: terminal.outcome,
        reason: terminal.reason, assistantMessage: stored?.messages.find(message => message.messageId === terminal.assistantMessageId) ?? null,
        providerId: terminal.providerId, model: terminal.model, providerContacted: lease.providerContacted }
      if (lease.turn) {
        await options.store.recordTurnOutcome(input.turnId, 'interrupted', { endedAt: new Date().toISOString(), reason })
        await options.fabric.append('conversation.turn.interrupted', {
          conversationId: input.conversationId, turnId: input.turnId,
          userMessageId: lease.turn.userMessageId, assistantMessageId: null,
          contentLength: 0, requestId: input.turnId, providerId: null, model: null, outcome: 'interrupted', reason,
        }, { actor: 'owner', correlationId: input.turnId })
      }
      return { turnId: input.turnId, conversationId: input.conversationId, outcome: 'interrupted', reason,
        assistantMessage: null, providerId: null, model: null, providerContacted: lease.providerContacted }
    } finally { this.active.delete(input.turnId); options.onTurnStateChange?.() }
  }

  /** Closed, turn-scoped operations. No raw store, key, principal, SQL or STOP-ALL mutation. */
  async handle(method: string, raw: unknown): Promise<unknown> {
    const p = raw as { turnId: string; args: unknown[] }
    const lease = this.active.get(p?.turnId)
    const options = this.options
    if (!lease || !options || !Array.isArray(p.args)) throw new Error('no admitted foreground turn')
    const [a, b, c] = p.args
    const conversationId = lease.input.conversationId
    switch (method) {
      case 'turn.read': return options.store.readConversation(conversationId)
      case 'turn.put': {
        const record = a as Parameters<typeof options.store.putConversation>[0]
        if (record.conversationId !== conversationId) throw new Error('conversation scope mismatch')
        return options.store.putConversation(record)
      }
      case 'turn.message': {
        const message = a as ConversationMessage
        if (message.conversationId !== conversationId || message.turnId !== p.turnId || !['user', 'assistant'].includes(message.role)) throw new Error('message scope mismatch')
        if (message.role === 'user' && message.content !== lease.input.text.trim()) throw new Error('owner message mismatch')
        return options.store.appendMessage(message)
      }
      case 'turn.start': {
        const turn = a as ConversationTurn
        if (turn.turnId !== p.turnId || turn.conversationId !== conversationId || turn.outcome !== 'pending') throw new Error('turn scope mismatch')
        await options.store.recordTurnStart(turn); lease.turn = turn; return null
      }
      case 'turn.outcome': return options.store.recordTurnOutcome(p.turnId, a as Parameters<typeof options.store.recordTurnOutcome>[1], b as Parameters<typeof options.store.recordTurnOutcome>[2])
      case 'turn.event': {
        const type = a as string, payload = b as Record<string, unknown>
        if (!['conversation.turn.started', 'conversation.turn.completed', 'conversation.turn.denied', 'conversation.turn.failed', 'conversation.turn.cancelled', 'conversation.turn.interrupted'].includes(type)
          || payload.turnId !== p.turnId || payload.conversationId !== conversationId) throw new Error('event scope mismatch')
        return options.fabric.append(type as never, payload as never, { actor: 'owner', correlationId: p.turnId })
      }
      case 'turn.grant': {
        const spec = a as CognitionGrantSpec
        const maxCalls = options.tools?.isEmpty() !== false ? 1 : MIND_TOOL_LIMITS.maxProviderCalls
        if (spec.grantId !== `turn:${p.turnId}` || spec.actor !== 'owner' || spec.backgroundAllowed !== false
          || spec.maxCalls !== maxCalls || spec.maxOutputTokens !== CONVERSATION_LIMITS.maxOutputTokensPerTurn
          || spec.allowedOrigins.length !== 1 || spec.allowedOrigins[0] !== 'user'
          || spec.allowedCauses.length !== 1 || spec.allowedCauses[0] !== 'user_message'
          || spec.goalId !== null || spec.runId !== null || spec.parentGrantId !== null
          || Date.parse(spec.expiresAt) > Date.now() + TURN_GRANT_TTL_MS || Date.parse(spec.expiresAt) <= Date.now()) throw new Error('foreground grant scope mismatch')
        return options.authority.createGrant(spec)
      }
      case 'turn.cognition': {
        const intent = a as CognitionIntent
        if (intent.kind !== 'user_turn' || intent.grantId !== `turn:${p.turnId}` || intent.correlationId !== p.turnId
          || !intent.cognitionRequestId?.startsWith(p.turnId)) throw new Error('cognition scope mismatch')
        const alreadyContacted = lease.providerContacted
        lease.providerContacted = true // Contact remains conservatively recorded if the response is lost.
        const outcome = await options.authority.request({ ...intent, signal: lease.controller.signal, requestedModel: options.selectedModel?.() ?? null,
          requestedProviderId: options.selectedProviderId?.() ?? null, goalId: null })
        lease.providerContacted = alreadyContacted || outcome.status === 'allowed' || ('providerContacted' in outcome && outcome.providerContacted)
        return outcome
      }
      case 'turn.tool': {
        const request = a as Parameters<NonNullable<typeof options.tools>['invoke']>[0]
        const invocation = await options.tools?.invoke({ ...request, signal: lease.controller.signal,
          context: { ...request.context, conversationId, matrixSpaceIds: options.matrixSpaceIds?.(conversationId) ?? [] } })
        if (invocation && lease.toolSteps.length < 32) lease.toolSteps.push({
          name: invocation.observation.tool, capability: invocation.observation.capability,
          outcome: invocation.observation.kind, executed: invocation.executed,
        })
        return invocation
      }
      case 'turn.changed': options.onTurnStateChange?.(); return null
      case 'turn.cancel': return options.gateway.cancelRequest(p.turnId, 'the owner stopped this response')
      case 'turn.experience': {
        const experience = a as Parameters<NonNullable<typeof options.onTurnExperience>>[0]
        if (experience.turnId !== p.turnId || experience.conversationId !== conversationId) throw new Error('experience scope mismatch')
        // The unprivileged intelligence process may describe tools, but Core
        // records only tool observations from calls actually admitted by Core.
        await options.onTurnExperience?.({ ...experience, toolSteps: lease.toolSteps }); return null
      }
      case 'turn.ownerMessage': {
        const message = a as Parameters<NonNullable<typeof options.onOwnerMessage>>[0]
        if (message.turnId !== p.turnId || message.conversationId !== conversationId || message.text !== lease.input.text.trim()) throw new Error('owner message scope mismatch')
        options.onOwnerMessage?.(message); return null
      }
      case 'turn.cue': options.expressionMemory?.recordCueUse(a as string, b as Parameters<NonNullable<typeof options.expressionMemory>['recordCueUse']>[1], c as string); return null
      default: throw new Error('operation unavailable to Freya')
    }
  }
}
