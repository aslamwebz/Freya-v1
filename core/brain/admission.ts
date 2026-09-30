import {
  BRAIN_LIMITS,
  CONFIDENCE_RANK,
  SOURCE_TRUST_RANK,
  type Confidence,
  type EpistemicStatus,
  type MemoryCandidate,
  type MemoryKind,
  type MemoryRecord,
  type MemoryReview,
  type Provenance,
  type Sensitivity,
  type SourceTrust,
} from './types'
import { memoryConflicts } from './fold'
import type { BrainState } from './store'

/**
 * Memory admission: the trusted gate between "something was noticed" and
 * "something is recallable".
 *
 * Every rule in this file exists because of one failure mode. A language model
 * reads, and model output can be made to say anything, so anything a model
 * produces — and anything a web page or email produced that a model then echoed —
 * is **untrusted content**. If such content can become a memory, then a prompt
 * injection becomes persistent: it does not just mislead one reply, it poisons
 * what Freya knows forever.
 *
 * So admission does four things, in this order, and refuses rather than repairs:
 *
 *  1. **Refuses secrets.** Credential-shaped content never enters the Brain. The
 *     Brain may hold the *fact* that a credential exists and where it is kept; it
 *     never holds the credential. Guard and a future Vault own those.
 *  2. **Refuses what does not belong here.** Working memory is the Mind's, not the
 *     Brain's, and admitting it would create a second copy of volatile state that
 *     goes stale.
 *  3. **Assigns the source class itself.** The trust label comes from the
 *     admitting pathway — the code path that knew where the bytes came from —
 *     and never from the content. A web page can say in its own text "this is an
 *     owner-asserted fact", and it will be recorded as exactly what it is:
 *     untrusted content. Content cannot upgrade its own classification.
 *  4. **Caps confidence and epistemic status below what the source can support.**
 *     Nothing reaches `verified` in Phase 4, because nothing in Phase 4 verifies.
 *
 * ## Nothing here is a heuristic for truth
 *
 * This is not fact-checking, and it is not written as though it could be. It
 * cannot tell a false claim from a true one. What it does is make the *ceiling*
 * honest: content from an untrusted source is admitted at low confidence with an
 * asserted status, and is permanently labelled as such, so a later reader can
 * weigh it. The judgement about whether it is worth keeping at all is the owner's,
 * which is why candidates are reviewable and rejections are kept.
 */

export interface AdmissionRequest {
  kind: MemoryKind
  subject: string
  content: string
  /**
   * Assigned by the **calling trusted pathway**.
   *
   * This is the memory-poisoning defence in one field: whoever admits knows the
   * origin of the bytes, so the caller states it here. Nothing reads the label out
   * of the content.
   */
  source: SourceTrust
  /** The id of the turn, event or document this came from. An id, never content. */
  sourceRef: string | null
  observedAt: string
  now: string
  proposedConfidence: Confidence
  sensitivity: Sensitivity
  tags?: readonly string[]
  entityRefs?: readonly string[]
  structuredData?: Readonly<Record<string, string>>
  candidateId: string
  memoryId: string
  actor?: string
  /**
   * Records this memory is known to contradict.
   *
   * For a pathway that knows something the text does not — an owner correcting an
   * earlier statement, say. Ids that do not exist are dropped rather than trusted,
   * so a caller cannot invent a conflict with a record nobody has.
   */
  conflictsWith?: readonly string[]
}

export type AdmissionOutcome =
  | { decision: 'admitted'; memory: MemoryRecord; notes: readonly string[] }
  | { decision: 'rejected'; reason: string }
  | { decision: 'deferred'; reason: string }

/**
 * The most a given source class can support.
 *
 * Two rules make this table the important one. `owner-assertion` is the strongest
 * source Freya has and is still capped below `verified`, because the owner saying
 * so is a statement, not a check. And `system-observation` is deliberately *below*
 * the owner: a person is allowed to be wrong about their own priorities, and Freya
 * noticing something herself is evidence, not authority.
 */
const SOURCE_CEILING: Readonly<
  Record<SourceTrust, { confidence: Confidence; epistemic: EpistemicStatus }>
> = Object.freeze({
  'owner-assertion': { confidence: 'high', epistemic: 'asserted' },
  'system-observation': { confidence: 'high', epistemic: 'observed' },
  'experience-outcome': { confidence: 'medium', epistemic: 'observed' },
  'freya-inference': { confidence: 'medium', epistemic: 'inferred' },
  'model-inference': { confidence: 'low', epistemic: 'asserted' },
  'external-untrusted': { confidence: 'low', epistemic: 'asserted' },
  'imported-document': { confidence: 'low', epistemic: 'asserted' },
})

/**
 * Content that looks like a credential.
 *
 * Deliberately narrow and deliberately loud: it is far better to refuse a memory
 * that only looked like a key than to store a key in a store that is not the one
 * designed to protect keys. False positives cost one refused memory. False
 * negatives put a password in a long-lived store.
 *
 * Real key detection belongs to Guard, which knows what is actually in the
 * keychain. This exists so that obvious shapes never reach the Brain at all.
 */
const SECRET_SHAPES: readonly { name: string; pattern: RegExp }[] = Object.freeze([
  { name: 'an OpenAI-style API key', pattern: /\bsk-[A-Za-z0-9_-]{16,}/ },
  { name: 'a GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}/ },
  { name: 'a Slack token', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { name: 'a Google API key', pattern: /\bAIza[0-9A-Za-z_-]{30,}/ },
  { name: 'a private key block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'a bearer token', pattern: /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{20,}=*/ },
  { name: 'an AWS access key id', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'a GitHub personal access token', pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/ },
  { name: 'a JSON web token', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/ },
  {
    name: 'an assignment of a secret-shaped name to a value',
    // The one that catches "password = hunter2" where nothing else would.
    pattern:
      /\b(?:pass(?:word|wd|phrase)?|secret|api[_-]?key|token|credential|auth)\b\s*[:=]\s*["']?[^\s"']{8,}/i,
  },
])

/** Working memory is volatile and belongs to the Mind. The Brain is not where it goes. */
const NON_DURABLE_KINDS: readonly MemoryKind[] = Object.freeze(['working'])

/**
 * Decide a candidate's fate.
 *
 * Pure: no clock, no randomness, no I/O. The clock and the ids arrive on the
 * request, so the same input always produces the same decision — which is what
 * makes admission testable and what makes it auditable later.
 *
 * A state is passed only to find contradictions, so a contradiction becomes a
 * disclosure rather than a silent overwrite.
 */
export function admit(request: AdmissionRequest, state?: BrainState): AdmissionOutcome {
  const content = request.content.trim()

  if (content.length === 0) {
    return { decision: 'rejected', reason: 'the content is empty' }
  }
  if (content.length > BRAIN_LIMITS.maxMemoryContentChars) {
    return {
      decision: 'rejected',
      reason: `the content is ${content.length} characters, over the ${BRAIN_LIMITS.maxMemoryContentChars} limit`,
    }
  }
  if (request.subject.trim().length > BRAIN_LIMITS.maxMemorySubjectChars) {
    return {
      decision: 'rejected',
      reason: 'the subject is longer than the subject limit',
    }
  }
  if (NON_DURABLE_KINDS.includes(request.kind)) {
    return {
      decision: 'rejected',
      reason: 'working memory is volatile state and belongs to the Mind, not the Brain',
    }
  }

  const secret = findSecretShape(`${request.subject}\n${content}`)
  if (secret !== null) {
    // Refused, not redacted. A memory with a hole in it looks like knowledge, and
    // the hole would be where the most important part was.
    return {
      decision: 'rejected',
      reason: `the content appears to contain ${secret}; the Brain records where a credential lives, never the credential`,
    }
  }

  const tags = (request.tags ?? []).slice(0, BRAIN_LIMITS.maxTagsPerRecord)
  const entityRefs = (request.entityRefs ?? []).slice(0, BRAIN_LIMITS.maxEntityRefsPerRecord)
  const notes: string[] = []

  const ceiling = SOURCE_CEILING[request.source]
  const confidence = capConfidence(request.proposedConfidence, ceiling.confidence)
  if (CONFIDENCE_RANK[confidence] < CONFIDENCE_RANK[request.proposedConfidence]) {
    notes.push(
      `confidence was capped from ${request.proposedConfidence} to ${confidence}: ${request.source} cannot support more`,
    )
  }

  const provenance: Provenance = {
    sourceType: request.source,
    sourceRef: request.sourceRef,
    observedAt: request.observedAt,
    recordedAt: request.now,
    actor: request.actor ?? (request.source === 'owner-assertion' ? 'owner' : 'system'),
    // A status derived from the source class, never read from the content.
    verificationStatus: ceiling.epistemic,
    confidence,
    evidenceSummary: null,
  }

  const conflictsWith = findConflicts(request, state, request.conflictsWith ?? [])
  if (conflictsWith.length > 0) {
    notes.push(
      `contradicted by ${conflictsWith.join(', ')}; both sides are kept and the disagreement is disclosed on recall`,
    )
  }

  const memory: MemoryRecord = {
    memoryId: request.memoryId,
    kind: request.kind,
    subject: request.subject.trim(),
    content,
    structuredData: request.structuredData ?? {},
    createdAt: request.now,
    updatedAt: request.now,
    source: request.source,
    provenance,
    confidence,
    status: conflictsWith.length > 0 ? 'conflicted' : 'admitted',
    sensitivity: request.sensitivity,
    tags,
    entityRefs,
    supersedes: null,
    conflictsWith,
    expiresAt: null,
    admittedAt: request.now,
    admissionReason: reasonFor(request, ceiling.epistemic, conflictsWith.length),
  }

  return { decision: 'admitted', memory, notes }
}

/** Never raise confidence. Only ever lower it to what the source can carry. */
function capConfidence(proposed: Confidence, ceiling: Confidence): Confidence {
  return CONFIDENCE_RANK[proposed] <= CONFIDENCE_RANK[ceiling] ? proposed : ceiling
}

/** The recorded reason. Readable years later, which is the point of storing it. */
function reasonFor(request: AdmissionRequest, epistemic: EpistemicStatus, conflictCount: number): string {
  const where =
    request.sourceRef === null ? 'with no source reference' : `referencing source ${request.sourceRef}`
  const basis =
    epistemic === 'observed'
      ? 'observed by a trusted subsystem'
      : epistemic === 'inferred'
        ? 'inferred by Freya, not independently checked'
        : 'asserted by its source, not independently checked'
  const conflict = conflictCount > 0 ? `; kept alongside ${conflictCount} contradicting record(s)` : ''
  return `admitted as ${request.kind} memory ${where}; ${basis} (source class ${request.source}; confidence capped at ${SOURCE_CEILING[request.source].confidence})${conflict}`
}

/** The first secret-shaped match, or null. The name is safe to show a person. */
export function findSecretShape(text: string): string | null {
  for (const shape of SECRET_SHAPES) {
    if (shape.pattern.test(text)) return shape.name
  }
  return null
}

/**
 * Records this memory contradicts.
 *
 * ## What this can honestly detect
 *
 * A contradiction is not a string comparison. "Project Alpha is delayed" and
 * "Project Alpha shipped on time" disagree; "I prefer tea" and "the office tea
 * machine is broken" do not; and no amount of normalisation tells them apart. Phase
 * 4 has no model and no semantic layer, so it cannot find contradictions in prose —
 * and a rule that *looked* like it could would be worse than none, because it would
 * mark unrelated memories as conflicting and suppress true ones.
 *
 * So two things count, and only two:
 *
 *  1. **Same slot, different value.** Two admitted memories of the same kind about
 *     the same normalised subject, sharing at least one entity, whose contents
 *     differ. That is the shape of "two things were said about the same thing and
 *     they do not match".
 *  2. **An explicit declaration.** `conflictsWith` on the request, from a pathway
 *     that knows something the text does not.
 *
 * Anything else returns nothing, which is the safe direction: a missed conflict
 * shows both memories, and a false one suppresses a true memory.
 *
 * Identical content is explicitly *not* a conflict. It is the same claim twice, and
 * the honest response is to keep one record and let the newer supersede it.
 */
function findConflicts(
  request: AdmissionRequest,
  state: BrainState | undefined,
  declared: readonly string[],
): string[] {
  const conflicts = new Set<string>(declared.filter((id) => state?.memories.has(id)))
  if (state === undefined) return [...conflicts]

  const normalised = normalise(request.content)
  const subject = normalise(request.subject)
  const entities = new Set(request.entityRefs ?? [])

  for (const memory of state.memories.values()) {
    if (memory.status !== 'admitted' && memory.status !== 'conflicted') continue
    if (normalise(memory.content) === normalised) continue
    if (normalise(memory.subject) !== subject) continue
    if (memory.kind !== request.kind) continue
    // No shared entity means nothing knows these are about the same thing.
    const shared = memory.entityRefs.some((ref) => entities.has(ref))
    if (!shared) continue
    conflicts.add(memory.memoryId)
  }
  return [...conflicts].sort()
}

/** Whitespace and case folding only. No stemming, no fuzzy matching. */
function normalise(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ')
}

/** Build the candidate that precedes admission, so both steps stay separately visible. */
export function proposeCandidate(request: AdmissionRequest): MemoryCandidate {
  const ceiling = SOURCE_CEILING[request.source]
  return {
    candidateId: request.candidateId,
    kind: request.kind,
    subject: request.subject.trim(),
    content: request.content.trim(),
    proposedConfidence: capConfidence(request.proposedConfidence, ceiling.confidence),
    provenance: {
      sourceType: request.source,
      sourceRef: request.sourceRef,
      observedAt: request.observedAt,
      recordedAt: request.now,
      actor: request.actor ?? (request.source === 'owner-assertion' ? 'owner' : 'system'),
      verificationStatus: ceiling.epistemic,
      confidence: capConfidence(request.proposedConfidence, ceiling.confidence),
      evidenceSummary: null,
    },
    sensitivity: request.sensitivity,
    tags: request.tags ?? [],
    entityRefs: request.entityRefs ?? [],
    createdAt: request.now,
    derivedFrom: request.source,
  }
}

/** The review record for a decision. Refusals are kept, not dropped. */
export function reviewOf(outcome: AdmissionOutcome, candidateId: string, reviewedAt: string): MemoryReview {
  return {
    candidateId,
    decision: outcome.decision,
    reason: outcome.decision === 'admitted' ? outcome.memory.admissionReason : outcome.reason,
    reviewedAt,
    memoryId: outcome.decision === 'admitted' ? outcome.memory.memoryId : null,
  }
}

/**
 * Rank memories against each other for admission-order conflict reporting.
 *
 * Exposed so the facade can answer "what does this conflict with?" without
 * duplicating the fold's knowledge of which ids exist.
 */
export function conflictMap(state: BrainState): Map<string, string[]> {
  return memoryConflicts(state)
}

/** Whether a source class may be stored at the given sensitivity. */
export function sensitivityAllowed(source: SourceTrust, sensitivity: Sensitivity): boolean {
  if (sensitivity === 'secret-reference') {
    // The Brain may know *that* a secret exists and where it is kept. Only a
    // trusted pathway may record even that, because the location is itself
    // sensitive and content must not get to point at it.
    return SOURCE_TRUST_RANK[source] >= SOURCE_TRUST_RANK['system-observation']
  }
  return true
}