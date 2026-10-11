export const RUNTIME_EVENT_TYPES = [
// Runtime Activation (Phase 40) — metadata only.
  //
  // These record the registration and lifecycle decisions of the runtime
  // activation system: which domain was evaluated, whether its declared
  // dependencies were satisfied, what status it was moved to, and why. There is
  // no slot for a secret, a credential, a provider payload or a dependency's
  // contents; every field is a namespaced id, a closed status, a closed outcome,
  // a sentence a person can read, or a list of dependency labels.
  //
  // None of these is a security event. A decision here *reflects* a gate that
  // already existed; it cannot clear STOP ALL, widen a grant, approve anything or
  // contact a model. The absence of such a spelling is the point.
  'runtime.activation.decided',
'runtime.activation.changed',
'runtime.activation.stopped',
'runtime.activation.reconciled',
] as const
