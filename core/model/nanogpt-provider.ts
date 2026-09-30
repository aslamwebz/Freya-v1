import type { ModelProvider, ModelRequest, ModelResult } from './provider'
import type { ProviderStatus } from '../protocol/core-protocol'

/**
 * The NanoGPT provider.
 *
 * **Disabled unless deliberately configured.** There is no fallback provider, no
 * free public default, and no "try it and see". If the configuration is absent
 * the status is `unconfigured` and the gateway will not select it.
 *
 * Two independent conditions must both hold before a live call is possible:
 *
 *   1. `NANOGPT_API_KEY`, `NANOGPT_BASE_URL` and `NANOGPT_MODEL` are present;
 *   2. `FREYA_ALLOW_LIVE_MODEL=1`.
 *
 * Without the second, a configured provider still reports `disabled`. The
 * first is a credential; the second is a decision to spend.
 *
 * The key is read here, held in a closure, and never returned by `status()`,
 * never logged, and never recorded in an event.
 */

export interface NanoGptConfig {
  apiKey: string
  baseUrl: string
  model: string
  /** The explicit decision to spend inference. Never inferred. */
  liveEnabled: boolean
}

export interface NanoGptEnv {
  NANOGPT_API_KEY?: string | undefined
  NANOGPT_BASE_URL?: string | undefined
  NANOGPT_MODEL?: string | undefined
  FREYA_ALLOW_LIVE_MODEL?: string | undefined
}

/** Read configuration from the environment. Never throws, never guesses. */
export function readNanoGptConfig(env: NanoGptEnv): NanoGptConfig | null {
  const apiKey = env.NANOGPT_API_KEY?.trim()
  const baseUrl = env.NANOGPT_BASE_URL?.trim()
  const model = env.NANOGPT_MODEL?.trim()
  if (!apiKey || !baseUrl || !model) return null
  return {
    apiKey,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    model,
    liveEnabled: env.FREYA_ALLOW_LIVE_MODEL === '1',
  }
}

export interface NanoGptProviderOptions {
  config: NanoGptConfig | null
  /** Injected so tests never touch a network. */
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export class NanoGptProvider implements ModelProvider {
  readonly id = 'nanogpt'
  readonly kind = 'nanogpt' as const
  readonly live = true

  private readonly config: NanoGptConfig | null
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  constructor(options: NanoGptProviderOptions) {
    this.config = options.config
    this.fetchImpl = options.fetchImpl ?? fetch
    this.timeoutMs = options.timeoutMs ?? 30_000
  }

  status(): ProviderStatus {
    if (this.config === null) {
      return {
        id: this.id,
        kind: this.kind,
        status: 'unconfigured',
        model: null,
        detail: 'Set NANOGPT_API_KEY, NANOGPT_BASE_URL and NANOGPT_MODEL to enable.',
        liveEnabled: false,
      }
    }
    if (!this.config.liveEnabled) {
      return {
        id: this.id,
        kind: this.kind,
        status: 'disabled',
        // A model name is not a secret and is useful to show.
        model: this.config.model,
        detail: 'Configured, but FREYA_ALLOW_LIVE_MODEL is not set. Live inference is off.',
        liveEnabled: false,
      }
    }
    return {
      id: this.id,
      kind: this.kind,
      status: 'configured',
      model: this.config.model,
      detail: 'Live inference enabled for this session.',
      liveEnabled: true,
    }
  }

  async complete(request: ModelRequest): Promise<ModelResult> {
    if (this.config === null || !this.config.liveEnabled) {
      // Unreachable via the gateway, which only selects a `configured`
      // provider. Kept so a direct call cannot spend anything.
      throw new Error('nanogpt live inference is not enabled')
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.fetchImpl(`${this.config.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: request.model ?? this.config.model,
          max_tokens: request.maxOutputTokens,
          messages: [{ role: 'user', content: request.prompt }],
        }),
      })

      if (!response.ok) {
        // The status is safe to record; the body may echo the request.
        throw new Error(`nanogpt responded ${response.status}`)
      }

      const body = (await response.json()) as {
        model?: string
        choices?: { message?: { content?: string } }[]
        usage?: { prompt_tokens?: number; completion_tokens?: number }
      }

      return {
        requestId: request.requestId,
        providerId: this.id,
        model: body.model ?? request.model ?? this.config.model,
        text: body.choices?.[0]?.message?.content ?? '',
        inputTokens: typeof body.usage?.prompt_tokens === 'number' ? body.usage.prompt_tokens : null,
        outputTokens:
          typeof body.usage?.completion_tokens === 'number' ? body.usage.completion_tokens : null,
      }
    } finally {
      clearTimeout(timer)
    }
  }
}
