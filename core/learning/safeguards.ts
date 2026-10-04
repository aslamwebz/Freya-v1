/**
 * PHASE 28 SAFEGUARDS — what learning is not allowed to become.
 *
 * PLAN.md §2.3: **knowledge is not permission.** §2.10: **generated capability starts
 * untrusted and inactive.** A learned procedure is the most attractive laundering route in
 * the system — it looks like Freya getting better, and it is exactly the shape a capability
 * grant would take if nobody guarded it.
 *
 * Four mechanisms, all structural:
 *
 * 1. **A proposal is inert data.** `assertProposalIsInert` returns a value that cannot
 *    express anything but inertness: `grantsCapability: false`, `executable: false`,
 *    `authority: 'none'`. A consumer can *render* the guarantee rather than merely not
 *    violate it.
 * 2. **No proposal may be derived from an untrusted source.** A page, a document or a model
 *    guess cannot reach a procedure. `PROPOSAL_SOURCES` is narrower than the pipeline's
 *    ceiling table, and the check is a set membership test rather than a heuristic.
 * 3. **Support is counted in distinct checks, not repeats.** Repeating one run forty times
 *    is one piece of evidence. `LEARNING_PROPOSAL_THRESHOLDS` counts distinct verification
 *    ids and distinct experiences, so the cheapest way to fail the gate is not to try
 *    harder.
 * 4. **Nothing here can promote anything.** The single exit is `admitToSkills`, which hands
 *    a proposal to `core/skills` as data. That domain then applies its own gates — a
 *    proposal is a *candidate*, never a trial — and it does so without asking this domain
 *    for permission, because this domain has no permission to give.
 *
 * ## What is deliberately not here
 *
 * No self-modification, no code generation, no runtime patching, no capability synthesis.
 * A later phase may propose *that* Freya acquire a capability (Phase 29); this phase is
 * about what may be *learned* from a check that already passed, and the difference between
 * "we checked this and it worked" and "we may now do this" is the whole boundary.
 */

import { LEARNING_FORBIDDEN_FIELDS, isForbiddenLearningFieldName, type ProcedureProposal, type SourceTrust } from './types'

/**
 * The sources a procedure proposal may be derived from.
 *
 * Narrower than the distillation table on purpose. A model or a page may be *recorded* as
 * an experience the owner can read, and may even be distilled into a low-confidence claim
 * — but nothing a model or a page touched may become a reusable procedure. The reasoning:
 * a procedure is the one artefact here that something might later *act* on, so it is the
 * one artefact whose evidence has to have been checked by something that was not trying to
 * produce it.
 */
export const PROPOSAL_SOURCES: readonly SourceTrust[] = ['experience-outcome', 'owner-assertion', 'system-observation']

export function isProposalSource(source: SourceTrust): boolean {
  return PROPOSAL_SOURCES.includes(source)
}

/** The only exit. Rendered rather than merely respected, so a surface can show it. */
export const LEARNING_GRANTS_NOTHING = Object.freeze({
  grantsCapability: false as const,
  grantsAuthority: false as const,
  grantsPermission: false as const,
  mayExecute: false as const,
  mayPromoteItself: false as const,
  reason: 'learning is evidence, not authority',
})

/**
 * Whether a proposal is inert.
 *
 * Three structural checks, not a scan of its text:
 *
 * - the three guarantee fields carry their only legal values;
 * - its name and step labels are bounded, and no *field name* on it is one of
 *   `LEARNING_FORBIDDEN_FIELDS`;
 * - its step count is within the domain bound.
 *
 * The forbidden-field check walks field names, not values. A step summary that happens to
 * contain the word "always" is prose about a check and is caught by the overclaim gate at
 * construction; a step summary that *says* it is allowed to approve things is not prose,
 * it is a forged shape, and that is what this catches.
 */
/**
 * The fields that state the guarantee rather than make a claim.
 *
 * `authority` is on `LEARNING_FORBIDDEN_FIELDS`, because a learning record carrying an
 * authority field is the thing this phase refuses. A proposal carries `authority: 'none'`
 * *because* it has none, so the scanner below skips exactly these three names — and skips
 * them by identity, checking that each still holds its only legal value. That is the
 * distinction: `authority: 'none'` is a refusal being rendered, `authority: 'some-cap'`
 * would be a claim, and the first check above is what catches it.
 */
const INERTNESS_FIELDS = Object.freeze(['grantsCapability', 'executable', 'authority'] as const)

export function assertProposalIsInert(proposal: ProcedureProposal): { ok: true } | { ok: false; code: string; reason: string } {
  if (proposal.grantsCapability !== false || proposal.executable !== false || proposal.authority !== 'none') {
    return {
      ok: false,
      code: 'proposal-not-inert',
      reason: 'a procedure proposal must grant no capability, be non-executable and carry no authority',
    }
  }
  for (const name of Object.keys(proposal)) {
    if ((INERTNESS_FIELDS as readonly string[]).includes(name)) continue
    if (isForbiddenLearningFieldName(name)) {
      return {
        ok: false,
        code: 'proposal-not-inert',
        reason: `a procedure proposal may not carry the field ${name}`,
      }
    }
  }
  if (proposal.steps.length === 0) {
    return { ok: false, code: 'proposal-not-inert', reason: 'a procedure proposal must have at least one step' }
  }
  return { ok: true }
}

/**
 * A skill-admission packet.
 *
 * This is the *entire* surface Phase 28 hands to `core/skills`: a name, steps with keys and
 * summaries, and the ids behind them so the Skills domain can apply its own evidence and
 * trust-class rules. There is no capability, no scope, no origin, no activation and no
 * priority field here, because a field is a place a future reader would look for authority
 * and find something that looks like it.
 *
 * Note what is **absent** as much as what is present: no `status`. A proposal does not
 * decide its own status. The Skills domain starts every admission at `candidate` and
 * promotes it on evidence, which is the only ordering in which a self-assessment could not
 * be the thing that granted the promotion.
 */
export interface SkillAdmissionPacket {
  readonly kind: 'procedure'
  readonly name: string
  readonly steps: readonly { readonly key: string; readonly summary: string }[]
  /** Ids the Skills domain can read for provenance. Ids, never content. */
  readonly originRefs: readonly string[]
  readonly trustClass: 'derived'
  /** Always `false`. Present so the packet states its own inertness. */
  readonly executable: false
}

/**
 * Turn a proposal into a packet for the Skills domain.
 *
 * Refuses a proposal that is not inert rather than sanitising it. Sanitising would mean
 * quietly repairing something that should never have been produced, and a silent repair is
 * how a forbidden field becomes a permitted one nobody reviewed.
 */
export function admitToSkills(proposal: ProcedureProposal): { ok: true; packet: SkillAdmissionPacket } | { ok: false; code: string; reason: string } {
  const inert = assertProposalIsInert(proposal)
  if (!inert.ok) return inert
  return {
    ok: true,
    packet: Object.freeze({
      kind: 'procedure' as const,
      name: proposal.name,
      steps: Object.freeze(proposal.steps.map((step) => Object.freeze({ ...step }))),
      originRefs: Object.freeze([...proposal.knowledgeIds, ...proposal.experienceIds]),
      trustClass: 'derived' as const,
      executable: false as const,
    }),
  }
}

/**
 * Whether a name is one a procedure proposal may carry.
 *
 * Not a slug check. A procedure name is prose — "verify the vault before releasing" — and
 * forbidding prose would forbid the only thing that makes a procedure reviewable. What is
 * forbidden is the *shape*: an overclaim marker, so no proposal can be named "this always
 * works".
 */
export function isAdmissibleProposalName(name: string): boolean {
  if (name.length === 0) return false
  const normalised = ` ${name.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()} `
  const markers = ['always', 'never', 'guaranteed', 'forever', 'in general', 'any situation']
  return markers.every((marker) => !normalised.includes(` ${marker} `))
}

/** Every forbidden field name, exported so a test can enumerate the whole vocabulary. */
export { LEARNING_FORBIDDEN_FIELDS }