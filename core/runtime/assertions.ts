/**
 * Structural audits for the runtime activation lane.
 *
 * These are not used by production code. They exist so a test can assert that
 * the activation system stayed what it claims to be: a registry, a dependency
 * checker and a lifecycle record — not a second authority path, not a source of
 * hidden inference, and not a place a domain can activate itself.
 */

/** Strip line and block comments so an audit does not trip on documentation. */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

export const FORBIDDEN_RUNTIME_IDENTIFIERS = Object.freeze([
  'requestCognition',
  'new ModelGateway',
  'createGrant',
  'grantCognition',
  'guard.evaluate',
  'child_process',
  'Math.random',
  'setInterval',
  'setTimeout',
  'process.env',
])

export interface RuntimeViolation {
  readonly code: 'forbidden-identifier' | 'impure-random'
  readonly identifier: string
}

export function findForbiddenIdentifiersInSource(source: string): readonly RuntimeViolation[] {
  const body = stripComments(source)
  const violations: RuntimeViolation[] = []
  for (const identifier of FORBIDDEN_RUNTIME_IDENTIFIERS) {
    if (body.includes(identifier)) {
      violations.push({
        code: identifier === 'Math.random' ? 'impure-random' : 'forbidden-identifier',
        identifier,
      })
    }
  }
  return violations
}

/**
 * The files that must be pure data and pure functions.
 *
 * `controller.ts` is deliberately absent: it is the one file allowed to append
 * to the journal and to call a handler. It is still audited for the authority
 * vocabulary by the red-team suite.
 */
export const PURE_RUNTIME_MODULES = Object.freeze([
  'types.ts',
  'dependencies.ts',
  'registry.ts',
  'state.ts',
  'projection.ts',
])
