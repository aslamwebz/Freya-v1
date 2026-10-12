import type { ModelMessage, ModelToolCall, ModelToolDefinition } from './provider'

export function serialiseToolFields(message: ModelMessage): Record<string, unknown> {
  return {
    ...(message.toolCallId === undefined ? {} : { tool_call_id: message.toolCallId }),
    ...(message.toolCalls === undefined ? {} : { tool_calls: message.toolCalls.map(call => ({
      id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments },
    })) }),
    ...(message.reasoningContent === undefined ? {} : { reasoning_content: message.reasoningContent }),
    ...(message.reasoningDetails === undefined ? {} : { reasoning_details: message.reasoningDetails }),
  }
}

export function serialiseToolDefinitions(tools: readonly ModelToolDefinition[] | undefined): Record<string, unknown> {
  return tools?.length ? { tools: tools.map(tool => ({ type: 'function', function: tool })), tool_choice: 'auto' } : {}
}

/** Reject the entire ambiguous batch. Never run a valid prefix of a broken batch. */
export function readNativeToolCalls(raw: unknown): { toolCalls?: readonly ModelToolCall[]; toolCallError?: string } {
  if (raw === undefined || raw === null) return {}
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 10) return { toolCallError: 'Invalid native tool-call batch.' }
  const calls: ModelToolCall[] = [], ids = new Set<string>()
  for (const item of raw) {
    const call = item as { id?: unknown; type?: unknown; function?: { name?: unknown; arguments?: unknown } } | null
    if (!call || call.type !== 'function' || typeof call.id !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(call.id)
      || ids.has(call.id) || typeof call.function?.name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(call.function.name)
      || typeof call.function.arguments !== 'string' || call.function.arguments.length > 66_000) {
      return { toolCallError: 'Malformed or duplicate native tool call; no calls executed.' }
    }
    ids.add(call.id)
    calls.push({ id: call.id, name: call.function.name, arguments: call.function.arguments })
  }
  return { toolCalls: calls }
}

/** Preserve observations as quoted data when a caller uses a text-only resource. */
export function textCompatibilityMessages(messages: readonly ModelMessage[]): readonly ModelMessage[] {
  return messages.map(message => message.role === 'tool'
    ? { role: 'user', content: `UNTRUSTED tool result ${JSON.stringify(message.toolCallId)}: ${message.content}` }
    : message.toolCalls
      ? { role: 'assistant', content: message.content + '\n' + JSON.stringify({ attemptedToolCalls: message.toolCalls }) }
      : message)
}
