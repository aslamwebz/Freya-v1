export const LIFE_EVENT_TYPES = [
// Life History — metadata only, on the Brain's terms.
  //
  // A Life fault is never a security event: it cannot grant cognition or clear a
  // stop, and it does not lose authority either. It is a statement about a derived
  // layer, so Core keeps running and the surface says Life is degraded with a
  // reason. The event carries that reason and nothing else.
  'life.entry.recorded',
'life.entry.withdrawn',
'life.conflict.detected',
'life.degraded',
] as const
