export const BRAIN_EVENT_TYPES = [
// Brain — metadata only.
  //
  // The Brain holds the most valuable long-term state in the system and the
  // journal is the least protected place it could go: audit logs get read, copied,
  // exported into backups and forwarded to people debugging things. So these carry
  // ids, counts, source classes and lengths. Never what was learned, never a
  // memory's text, never a subject a person typed.
  //
  // Note what is absent too: there is no `brain.memory.recalled`. Recall happens
  // constantly and putting it in the durable log would turn the journal into a
  // record of Freya's private associations.
  'brain.seeded',
'brain.memory.admitted',
'brain.memory.reviewed',
'brain.memory.archived',
'brain.memory.ownership_set',
'brain.memory.corrected',
'brain.world.entity_noted',
'brain.world.related',
'brain.world.observed',
'brain.experience.recorded',
'brain.degraded',
] as const
