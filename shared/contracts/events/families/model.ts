export const MODEL_EVENT_TYPES = [
// Model execution
  //
  // The invariant the reducer relies on, and the reason `started` is written at
  // the last possible moment: `model.request.started` means the gateway was about
  // to hand this request to a provider. Every terminal event after it therefore
  // describes a provider that was contacted, and a `cancelled` that says
  // `providerContacted: false` is the one case where a start is withdrawn.
  'model.request.started',
'model.request.completed',
'model.request.failed',
'model.request.cancelled',
] as const
export interface ModelEventPayloads {
'model.request.started': {
    requestId: string
    grantId: string | null
    providerId: string
    model: string
    maxOutputTokens: number
    /** When the gateway decided to contact a provider. Never a UI clock. */
    startedAt: string
  }

'model.request.completed': {
    requestId: string
    providerId: string
    model: string
    inputTokens: number | null
    outputTokens: number | null
  }

'model.request.failed': {
    requestId: string
    providerId: string
    reason: string
  }

/**
   * A request the owner stopped, or that Core shut down with in flight.
   *
   * Not a failure, and the payload says why that is not a detail: a request
   * refused before the provider was contacted cost nothing, and one aborted
   * after it was reached was probably billed for the work it had already done.
   * Collapsing the two would report a cancelled request as either a free call or
   * a lost one, and both would be wrong.
   */
  'model.request.cancelled': {
    requestId: string
    providerId: string
    /** Why it was stopped, in words a person can act on. */
    reason: string
    /**
     * Whether the provider had already been asked. False means the call
     * happened and cost nothing; true means the figures stay a lower bound.
     */
    providerContacted: boolean
  }
}