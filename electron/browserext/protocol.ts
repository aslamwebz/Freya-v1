import type { BrowserBridgeCommand } from '../../core/browserext'

/**
 * The host↔extension *request* protocol, distinct from the extension↔host *command*
 * protocol in `core/browserext`.
 *
 * The command protocol is what an authenticated session sends; this is what the host
 * asks the device to do once Core has allowed it. Keeping them separate means the
 * extension never sees a Device Hands action key, a grant or a policy — it only ever
 * sees a page operation the host has already authorised.
 */

export interface ExtensionRequest {
  readonly kind: 'request'
  readonly requestId: string
  readonly command: BrowserBridgeCommand
  readonly args: Readonly<Record<string, unknown>>
  readonly tabId: number | null
  readonly frameId: number
  readonly url: string | null
  readonly deadlineAt: number
}

export interface ExtensionResponse {
  readonly kind: 'response'
  readonly requestId: string
  readonly ok: boolean
  readonly code: string
  readonly reason: string
  readonly result: unknown
}

/** A bounded element descriptor, with the protected-field verdict already applied. */
export interface ElementDescriptor {
  readonly tagName: string
  readonly type: string | null
  readonly name: string | null
  readonly id: string | null
  readonly autocomplete: string | null
  readonly placeholder: string | null
  readonly ariaLabel: string | null
  readonly protected: boolean
}

export function isExtensionResponse(value: unknown): value is ExtensionResponse {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const raw = value as Record<string, unknown>
  return (
    raw.kind === 'response' &&
    typeof raw.requestId === 'string' &&
    typeof raw.ok === 'boolean' &&
    typeof raw.code === 'string' &&
    typeof raw.reason === 'string'
  )
}
