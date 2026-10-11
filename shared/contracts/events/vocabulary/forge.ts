/* ------------------------------------------------------------------- kinds */

/**
 * What shape of bounded thing a Forge package is.
 *
 * Closed because the kind decides which operations its program may contain and
 * what its access declaration is allowed to say. `pure-transform` and
 * `data-pipeline` compute; `research-helper` and `connector-wrapper` describe an
 * act for a downstream, authorised subsystem to perform; `ui-artifact` renders a
 * declarative view; `automation-recipe` emits a bounded list of named steps.
 *
 * None of them is "a plugin", and the list is the honest limit of what this
 * architecture can sandbox. A kind that meant "whatever the generator wanted"
 * would make the whole table decorative.
 */
export const FORGE_RUNTIME_KINDS = [
  'pure-transform',
  'data-pipeline',
  'research-helper',
  'connector-wrapper',
  'ui-artifact',
  'automation-recipe',
] as const
export type ForgeRuntimeKind = (typeof FORGE_RUNTIME_KINDS)[number]
/* ------------------------------------------------------------ provenance */

/**
 * Where a candidate came from.
 *
 * `forge-generated` means a model was asked for it, so its provenance records the
 * model and a hash of the request and never records the response as truth.
 * `acquired-remote` means it came from somewhere else entirely and is therefore
 * *always* untrusted until validated, and always requires approval before it may
 * be enabled. There is no `trusted-remote`.
 */
export const FORGE_ORIGINS = ['owner-authored', 'forge-generated', 'local-import', 'acquired-remote'] as const
export type ForgeOrigin = (typeof FORGE_ORIGINS)[number]
/* ----------------------------------------------------------------- access */

/**
 * The access a package *declares*.
 *
 * Two values only, and the names are the point: `denied` and `declared`. There is
 * no `granted` here, because granting is not a package's business — it is Core's,
 * through the capability vocabulary, and the declaration only ever has to be
 * checked against what already exists.
 *
 * A declaration is never an authorisation. `network: 'declared'` says "this
 * package would need the network"; it does not give it one, and in this build the
 * sandbox cannot use one regardless.
 */
export const FORGE_ACCESS_LEVELS = ['denied', 'declared'] as const
export type ForgeAccessLevel = (typeof FORGE_ACCESS_LEVELS)[number]
/* ------------------------------------------------------------- lifecycle */

export const FORGE_VALIDATION_STAGES = [
  'manifest',
  'dependencies',
  'integrity',
  'security',
  'tests',
  'capabilities',
  'approval',
] as const
export type ForgeValidationStage = (typeof FORGE_VALIDATION_STAGES)[number]
export const FORGE_STAGE_VERDICTS = ['pass', 'fail', 'not-applicable'] as const
export type ForgeStageVerdict = (typeof FORGE_STAGE_VERDICTS)[number]
/** A run's outcome. `interrupted` is a real state, not a missing one. */
export const FORGE_RUN_STATES = ['running', 'succeeded', 'failed', 'cancelled', 'interrupted', 'refused'] as const
export type ForgeRunState = (typeof FORGE_RUN_STATES)[number]
export const FORGE_RUN_FAILURE_CODES = [
  'input-schema-violation',
  'output-schema-violation',
  'input-too-large',
  'output-too-large',
  'step-budget-exhausted',
  'deadline-exceeded',
  'cancelled',
  'input-schema-violation',
  'output-schema-violation',
  'input-too-large',
  'output-too-large',
  'forbidden-operation',
  'unknown-binding',
  'type-mismatch',
  'invalid-data',
  'forbidden-operation',
  'program-invalid',
  'recovery-interrupted',
] as const
export type ForgeRunFailureCode = (typeof FORGE_RUN_FAILURE_CODES)[number]
/* ------------------------------------------------------------- refusals */

/**
 * Every refusal Forge can state, in one closed list.
 *
 * Closed so a surface can branch on a code instead of parsing a sentence, and so
 * a test can assert that a refusal is one of these rather than "some string". The
 * list is read by the payload validators in `core/events/validate.ts`, so a code
 * that exists here is a code a journal line may carry.
 */
export const FORGE_REFUSAL_CODES = [
  'malformed-command',
  'no-payload',
  'unknown-command',
  'malformed-manifest',
  'unknown-runtime',
  'schema-invalid',
  'dependency-refused',
  'dependency-missing',
  'dependency-cycle',
  'integrity-mismatch',
  'identical-version',
  'version-conflict',
  'downgrade-not-explicit',
  'no-such-package',
  'no-such-version',
  'unknown-capability',
  'forbidden-capability',
  'capability-not-registered',
  'capability-not-held',
  'approval-required',
  'approval-refused',
  'security-finding',
  'tests-failed',
  'program-invalid',
  'impossible-access-declaration',
  'path-traversal',
  'protected-core-reference',
  'forbidden-host-api',
  'secret-access',
  'unrestricted-network',
  'hidden-dependency',
  'grant-metadata-tampering',
  'oversized-source',
  'illegal-transition',
  'not-installed',
  'not-enabled',
  'not-verified',
  'quarantined',
  'removed',
  'stop-all',
  'cancelled',
  'input-schema-violation',
  'output-schema-violation',
  'input-too-large',
  'output-too-large',
  'forbidden-operation',
  'deadline-exceeded',
  'run-failed',
  'run-budget-exceeded',
  'invalid-input',
  'invalid-data',
  'type-mismatch',
  'unknown-binding',
  'step-budget-exhausted',
  'invalid-output',
  'limit-exceeded',
  'recovery-interrupted',
  'degraded-store',
  'unsupported-runtime',
] as const
export type ForgeRefusalCode = (typeof FORGE_REFUSAL_CODES)[number]