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
