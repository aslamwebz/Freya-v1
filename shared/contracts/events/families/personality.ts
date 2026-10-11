export const PERSONALITY_EVENT_TYPES = [
// Personality & Relationship — metadata only, on the Brain's terms.
  //
  // Relationship records are the most personal thing Freya holds: facts about a
  // person, their preferences, their habits, the shorthands they share. The
  // journal is the place least able to keep a secret — it is read, copied, exported
  // into backups and forwarded to whoever is debugging — so these carry an id, a
  // code-owned slug, closed kind and status labels, the trust class Core assigned,
  // counters, and a *closed* lifecycle reason.
  //
  // There is deliberately no payload field for the recorded text, for the owner's
  // clause that matched, or for a free-text reason of any kind. That is a property
  // of the payload type rather than of anyone's care: an audit reader can see that
  // a record was admitted, superseded, withdrawn or retired, and can see the trust
  // class it carries, without this file ever holding a word the person said.
  'personality.record_changed',
'personality.degraded',
] as const
export interface PersonalityEventPayloads {
// Personality & Relationship. Metadata only, and the exact-key check in
  // `validate.ts` is what keeps it that way: a hand-edited line cannot smuggle a
  // recorded text, an owner's clause or a sentence into a payload whose schema has
  // no slot for one.
  'personality.record_changed': {
    operation: 'admitted' | 'rejected' | 'withdrawn' | 'retired' | 'superseded'
    itemId: string
    kind: 'fact' | 'preference' | 'habit' | 'catchphrase' | 'inside-joke'
    /** A code-owned slug. Never a sentence — `isSlug` is checked on recovery. */
    key: string
    sourceType:
      | 'owner-assertion'
      | 'system-observation'
      | 'experience-outcome'
      | 'freya-inference'
      | 'model-inference'
      | 'external-untrusted'
      | 'imported-document'
    confidence: 'unknown' | 'low' | 'medium' | 'high'
    lifecycleReason:
      | 'owner-withdrew-this-record'
      | 'owner-rejected-this-record'
      | 'superseded-by-a-newer-record'
      | 'retention-bound-reached'
      | null
    admitted: number
    retained: number
  }

'personality.degraded': {
    reason: string
    mode: 'encrypted' | 'ephemeral'
    durable: false
  }
}