import { ModelRequestCancelled, readFinishReason, throwIfAborted, validateModelAttachments, type ModelProvider, type ModelRequest, type ModelCallOptions, type ModelResult, type ModelCatalogOptions, type ModelCatalogEntry } from './provider'
import type { ProviderStatus } from '../protocol/core-protocol'

export type CompatibleProviderId = 'minimax' | 'local' | 'openai'
export interface CompatibleConfig { apiKey: string; baseUrl: string; model: string; liveEnabled: boolean; vision: boolean; timeoutMs?: number }

/** Fixed credential recipients. This policy is separate from NanoGPT's policy. */
export function approveCompatibleEndpoint(id: CompatibleProviderId, raw: string): URL {
  const url = new URL(raw)
  if (url.username || url.password || url.search || url.hash || Array.from(raw).some((char) => char.charCodeAt(0) <= 32)) throw new Error('Provider endpoint refused.')
  if (id === 'local') {
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Local inference requires a literal loopback HTTP endpoint.')
  } else {
    const origins = id === 'minimax' ? ['https://api.minimax.io', 'https://api.minimaxi.com'] : ['https://api.openai.com']
    if (!origins.includes(url.origin)) throw new Error('Provider credential recipient refused.')
  }
  return url
}

/**
 * Clean and validate provider completion text.
 *
 * Sanitizes provider-specific transport artifacts, strips multimodal hallucination lines,
 * redacts credentials, and guards against autoregressive degeneration loops (repeating token patterns).
 */
export function cleanProviderCompletion(rawText: string, apiKey?: string): { text: string; corrupted: boolean; reason?: string } {
  let text = apiKey && apiKey.length > 0 ? rawText.split(apiKey).join('[redacted]') : rawText

  // Strip known multimodal VTT internal notes leaked by MiniMax media models
  text = text.replace(/^(?:VTTEmbedded_note:|VTTEmbedded:)[^\r\n]*(?:\r?\n|$)/gmi, '')

  // Detect degenerative repetition loops: substring of 3..60 characters repeating >= 4 times consecutively
  const loopMatch = text.match(/(.{3,60}?)\1{3,}/su)
  if (loopMatch && loopMatch.index !== undefined) {
    const loopStart = loopMatch.index
    const prefix = text.slice(0, loopStart).trim()
    if (prefix.length > 0) {
      text = prefix
    } else {
      return { text: '', corrupted: true, reason: 'Provider response degenerated into a repetitive protocol loop.' }
    }
  }

  // Strip dangling delimiter tokens when they do not enclose an active tool envelope
  if (!/<tool_call>|FREYA_TOOL_CALL/i.test(text)) {
    text = text.replace(/(?:\]?<\]minimax\[>(?:\[ya ism\]|\[)?|\[ya ism\]|<\]minimax>|\[minimax\])+/gi, '').trim()
  }

  const cleaned = text.trim()
  if (cleaned.length === 0 && rawText.trim().length > 0) {
    return { text: '', corrupted: true, reason: 'Provider output contained only malformed protocol artifacts.' }
  }

  return { text: cleaned, corrupted: false }
}

/** MiniMax protocol: https://platform.minimax.io/docs/api-reference/text-openai-api
 * OpenAI-compatible text/image adapter; all redirects are refused before credentials can move. */
export class CompatibleModelProvider implements ModelProvider {
  readonly live = true
  readonly kind: CompatibleProviderId
  constructor(readonly id: CompatibleProviderId, private readonly config: CompatibleConfig | null, private readonly fetchImpl: typeof fetch = fetch) { this.kind = id }
  status(): ProviderStatus {
    return { id: this.id, kind: this.kind, status: !this.config ? 'unconfigured' : this.config.liveEnabled ? 'configured' : 'disabled', model: this.config?.model ?? null, liveEnabled: this.config?.liveEnabled ?? false, detail: !this.config ? 'Configure an approved endpoint and model, plus a credential for remote inference.' : this.config.liveEnabled ? 'Configured adapter; network health has not been probed.' : 'Live inference is disabled.' }
  }
  async listModels(options: ModelCatalogOptions): Promise<readonly ModelCatalogEntry[]> {
    throwIfAborted(options.signal, 'cancelled before model discovery')
    return this.config ? [{ id: this.config.model, ownedBy: this.id }] : []
  }
  servesModel(model: string): boolean { return this.config?.model === model }
  async complete(request: ModelRequest, options: ModelCallOptions): Promise<ModelResult> {
    throwIfAborted(options.signal, 'cancelled before provider contact')
    const config = this.config
    if (!config || !config.liveEnabled) throw new Error('Provider is not enabled.')
    const attachments = request.messages.flatMap((message) => validateModelAttachments(message.attachments))
    if (attachments.some((attachment) => attachment.type !== 'image')) throw new Error('This provider adapter does not support file attachments.')
    if (attachments.length && !config.vision) throw new Error('The selected model does not have declared image support.')
    const base = approveCompatibleEndpoint(this.id, config.baseUrl).href.replace(/\/+$/, '')
    const target = `${base.endsWith('/v1') ? base : `${base}/v1`}/chat/completions`
    approveCompatibleEndpoint(this.id, target)
    // Local endpoints never receive a credential, even if a malformed caller supplied one.
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (this.id !== 'local') headers.authorization = `Bearer ${config.apiKey}`
    const timeoutMs = config.timeoutMs ?? 60_000
    const signal = AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
    try {
      const response = await this.fetchImpl(target, { method: 'POST', redirect: 'manual', signal, headers, body: JSON.stringify({ model: request.model ?? config.model, max_tokens: request.maxOutputTokens, messages: request.messages.map((message) => {
        const parts = validateModelAttachments(message.attachments)
        return { role: message.role, content: parts.length ? [{ type: 'text', text: message.content }, ...parts.map((attachment) => ({ type: 'image_url', image_url: { url: `data:${attachment.mimeType};base64,${attachment.data}` } }))] : message.content }
      }) }) })
      if (response.status >= 300 && response.status < 400) throw new Error('Provider redirect refused; no follow-up request was sent.')
      if (!response.ok) throw new Error(`Provider responded ${response.status}.`)
      const body = await response.json() as { choices?: { message?: { content?: unknown }; finish_reason?: unknown }[]; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } }
      const choice = body.choices?.[0]
      if (typeof choice?.message?.content !== 'string') throw new Error('Provider returned no text completion.')
      const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
      const cleaned = cleanProviderCompletion(choice.message.content, config.apiKey)
      if (cleaned.corrupted) {
        throw new Error(`Provider returned unreadable output: ${cleaned.reason}`)
      }
      return { requestId: request.requestId, providerId: this.id, model: request.model ?? config.model, text: cleaned.text, inputTokens: count(body.usage?.prompt_tokens), outputTokens: count(body.usage?.completion_tokens), finishReason: readFinishReason(choice.finish_reason) }
    } catch (error) {
      if (options.signal.aborted) throw new ModelRequestCancelled('cancelled during provider request')
      if (signal.aborted) {
        // eslint-disable-next-line preserve-caught-error -- Raw transport causes can expose credentials.
        throw new Error('Provider request timed out.')
      }
      // Do not surface raw transport errors, which may contain headers or request bodies.
      if (error instanceof Error && /^(Provider (responded|redirect|returned))/.test(error.message)) throw error
      // eslint-disable-next-line preserve-caught-error -- Raw transport causes can expose credentials.
      throw new Error('Provider request failed.')
    }
  }
}
