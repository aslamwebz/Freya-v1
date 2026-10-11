export const FOUNDRY_EVENT_TYPES = [
// Foundry (Phase 15) — metadata only, and the family where deterministic
  // identity is the whole point.  //
  // A Foundry event describes *that an artifact was produced, verified,
  // promoted or activated* and *what its deterministic identity is*. There is
  // no slot for the artifact's content, its spec, or its verification evidence:
  // those are process-local and never written here. Every field is an id, a
  // hash, a status, a closed enum, an integer counter, a measured length, or
  // a closed reason code.
  //
  // The hash is the deterministic identity — a SHA-256 of the artifact's
  // content and inputs. It is computed by the Foundry engine at creation time
  // and is never mutable.
  'foundry.artifact.created',
'foundry.artifact.transitioned',
'foundry.verification.recorded',
'foundry.promotion.recorded',
'foundry.activation.recorded',
'foundry.tool.registered',
'foundry.tool.transitioned',
'foundry.module.registered',
'foundry.module.transitioned',
'foundry.app.registered',
'foundry.app.transitioned',
'foundry.limit.exceeded',
] as const
