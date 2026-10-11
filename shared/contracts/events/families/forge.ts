export const FORGE_EVENT_TYPES = [
// Forge (Phase 48) — metadata only, and the family where the *body* is absent.
  //
  // A Forge package is a generated or acquired program. The program itself, its
  // description, a run's input and a run's output are **not in this journal** —
  // they live in the encrypted body store, and this family records only that a
  // version exists, what it hashes to, what state it is in, what the pipeline
  // decided, and how a run ended.
  //
  // There is no `forge.installed` that also enables, and there is no event whose
  // name could be read as "a generated package became trusted Core code". The
  // vocabulary is deliberately small: a candidate was created, a validation ran,
  // a version was installed, enabled, disabled, rolled back, quarantined, degraded
  // or removed, an approval was recorded, a run started and ended, and something
  // was refused. Every payload is an id, a slug, a closed label, a closed code, an
  // integer, a measured length, a hash or an instant.
  'forge.candidate.created',
'forge.validating.recorded',
'forge.validation.recorded',
'forge.installed',
'forge.enabled',
'forge.disabled',
'forge.rolledback',
'forge.quarantined',
'forge.degraded',
'forge.removed',
'forge.approval.recorded',
'forge.run.recorded',
/**
   * An attempt was refused.
   *
   * Journalled rather than dropped, for the same reason `skill.proposal.rejected`
   * exists: a refusal pattern is what an investigation needs, and the payload is a
   * closed code plus an id — never the text that was refused.
   */
  'forge.refused',
'forge.limit.exceeded',
] as const
