import { DEVICE_HANDS_LIMITS, type DeviceHandsRefusalCode } from './types'
import { checkPath, type SurfacePolicy } from './paths'

/**
 * The terminal: what one command may be, and what may never reach the program.
 *
 * ## What is deliberately enforced
 *
 * - **No shell, ever.** The port is typed to spawn a program directly with an
 *   argument vector. Everything in this file exists to make that safe rather than to
 *   compensate for a shell that is not there.
 * - **Metacharacters are refused anyway.** `; & | > < $ ` \ " ' ( ) { } [ ] * ? ! #
 *   ~` and the control characters are refused in every argument and every environment
 *   value. They are harmless without a shell, so refusing them costs nothing — and if
 *   a port is ever changed to use `sh -c`, this module already refuses every input
 *   that would have been exploitable. That is the point: the refusal is defence for a
 *   change nobody has made yet.
 * - **An absolute path in an argument is a path gate.** `rm -rf /home/x/.ssh` is
 *   refused by the *same* {@link checkPath} that gates a download, so an argument
 *   cannot reach a directory an explicit path request could not. This is the rule
 *   that makes "the terminal cannot reach the Vault" true of arguments and not only
 *   of the working directory.
 * - **The environment is constructed, never inherited.** Only names on the policy's
 *   `allowedEnvNames` may be set, and that list was itself checked against the
 *   credential deny words when the policy was read. A caller that names
 *   `AWS_SECRET_ACCESS_KEY` is refused; a caller that names nothing gets an
 *   environment with nothing in it.
 * - **A command is a bare name.** The allowlist holds no separator and no directory,
 *   so `./evil`, `..\\evil` and `/bin/sh` cannot be entries.
 *
 * ## What is deliberately absent
 *
 * No `node:child_process`, no `spawn`, no `exec`, no I/O. This module decides; the
 * port acts.
 */

/* ------------------------------------------------------------ metacharacters */

/**
 * Characters refused in every argument and every environment value.
 *
 * Enumerated as a closed list rather than a regex so a test can assert the whole
 * list, and so adding one is a visible change to a table rather than a change to a
 * pattern nobody re-reads.
 */
export const SHELL_METACHARACTERS: readonly string[] = Object.freeze([
  ';',
  '&',
  '|',
  '>',
  '<',
  '$',
  '`',
  '\\',
  '"',
  "'",
  '(',
  ')',
  '{',
  '}',
  '[',
  ']',
  '*',
  '?',
  '!',
  '#',
  '~',
  '^',
'\n',
  '\r',
  '\t',
  '%',
])

/**
 * The control characters refused in every value, checked separately from the table.
 *
 * A separate list because a control character inside a string is invisible in a log
 * line, in a diff and in a screenshot of a diff — so "why was this refused?" is
 * unanswerable if the only answer is an invisible character. Naming them here means
 * the refusal reason and the check are derived from the same list.
 */
export const FORBIDDEN_VALUE_CODES: readonly number[] = Object.freeze([
  0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x0b, 0x0c, 0x0e, 0x0f,
  0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c,
  0x1d, 0x1e, 0x1f, 0x7f,
])

/** Whether a value contains a control character this build will not pass on. */
export function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (FORBIDDEN_VALUE_CODES.includes(code)) return true
  }
  return false
}

/**
 * The characters an argument or environment value may contain.
 *
 * Letters and digits in any script (a file name is not ASCII), plus space, dot,
 * underscore, hyphen, colon, forward slash, at, equals, plus, comma and bracket-free
 * parentheses. Everything else is refused.
 */
const SAFE_VALUE = /^[\p{L}\p{N} ._\-:/@=+,]+$/u

/** An argument that looks like an absolute path must be judged by the path gate. */
const ABSOLUTE_PATH_SHAPE = /^(?:\/|[A-Za-z]:[\\/])/

/**
 * Arguments refused even though they contain no metacharacter.
 *
 * These are argument-injection vectors rather than shell injections: no shell is
 * involved, so nothing is being escaped, but the *program itself* is being told to run
 * another program. `--upload-pack` and `--receive-pack` make `git` and `ssh` execute an
 * arbitrary command; `-c core.gitProxy` redirects a protocol's transport. An approval
 * would show the owner the whole argument vector, which is the real defence — but a
 * vector that exists in *every* `git` invocation someone might approve is cheaper to
 * refuse than to explain three times.
 */
export const FORBIDDEN_ARGUMENT_PATTERNS: readonly string[] = Object.freeze([
  '--upload-pack',
  '--receive-pack',
  '-up',
  '--exec',
  '-e',
  'core.gitproxy',
  'proxycommand',
  'sshcommand',
  '--config-env',
  '--output',
])

/* ------------------------------------------------------------------ shapes */

/** A command request as the port receives it. */
export interface TerminalCommand {
  readonly command: string
  readonly args: readonly string[]
  readonly workingDirectory: string
  /** Constructed, never inherited. Keyed by the exact names on the policy. */
  readonly env: Readonly<Record<string, string>>
}

export type CommandReading =
  | { readonly ok: true; readonly command: TerminalCommand }
  | { readonly ok: false; readonly code: DeviceHandsRefusalCode; readonly reason: string }

function refuse(code: DeviceHandsRefusalCode, reason: string): CommandReading {
  return { ok: false, code, reason }
}

/** Every forbidden character a value contains, for the refusal message. */
function metacharactersIn(value: string): readonly string[] {
  if (hasControlCharacter(value)) return ['a control character']
  return SHELL_METACHARACTERS.filter((character) => value.includes(character))
}

/* --------------------------------------------------------------- validation */

/**
 * Read, bound and narrow one terminal request.
 *
 * `input` is untrusted. Nothing here is repaired: a bad command is refused with a
 * code, not trimmed into something runnable, and an argument that fails the charset
 * is refused rather than stripped of its offending character — because stripping
 * turns `rm -rf /; curl evil` into `rm -rf /curl evil`, which is a *different
 * command*, and a gate that silently changes what it is authorising is not a gate.
 */
export function readTerminalCommand(
  input: unknown,
  policy: SurfacePolicy,
): CommandReading {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return refuse('request-malformed', 'A terminal request must be an object.')
  }
  const raw = input as Record<string, unknown>

  /* ------------------------------------------------------------- the program */
  if (typeof raw.command !== 'string') {
    return refuse('request-malformed', 'A terminal request must name a program.')
  }
  const command = raw.command.trim().toLowerCase()
  if (command.length === 0) {
    return refuse('command-not-allowed', 'A terminal request must name a program.')
  }
  if (metacharactersIn(command).length > 0) {
    return refuse(
      'command-argument-unsafe',
      `The program name "${command}" contains a shell metacharacter. Program names are bare words on this allowlist.`,
    )
  }
  if (!policy.allowedCommands.includes(command)) {
    return refuse(
      'command-not-allowed',
      `"${command}" is not on the command allowlist (${policy.allowedCommands.join(', ')}). Nothing outside that list may be started.`,
    )
  }

  /* ------------------------------------------------------------ the arguments */
  const rawArgs = raw.args === undefined || raw.args === null ? [] : raw.args
  if (!Array.isArray(rawArgs)) {
    return refuse('command-argument-invalid', 'Arguments must be a list of strings.')
  }
  if (rawArgs.length > DEVICE_HANDS_LIMITS.maxCommandArgs) {
    return refuse(
      'command-argument-count-exceeded',
      `A command may carry at most ${String(DEVICE_HANDS_LIMITS.maxCommandArgs)} arguments; this one has ${String(rawArgs.length)}.`,
    )
  }
  const args: string[] = []
  for (const entry of rawArgs) {
    if (typeof entry !== 'string') {
      return refuse('command-argument-invalid', 'Every argument must be a string.')
    }
    if (entry.length === 0) {
      return refuse('command-argument-invalid', 'An empty argument is refused rather than dropped, because dropping it changes the argument count the program sees.')
    }
    if (entry.length > DEVICE_HANDS_LIMITS.maxCommandArgBytes) {
      return refuse(
        'command-argument-count-exceeded',
        `An argument exceeded ${String(DEVICE_HANDS_LIMITS.maxCommandArgBytes)} bytes.`,
      )
    }
    const unsafe = metacharactersIn(entry)
    if (unsafe.length > 0) {
      return refuse(
        'command-argument-unsafe',
        `The argument "${entry}" contains ${unsafe.map((c) => `"${c}"`).join(', ')}. Arguments are passed as a vector and never parsed by a shell, so a shell character is refused rather than escaped.`,
      )
    }
    if (!SAFE_VALUE.test(entry)) {
      return refuse(
        'command-argument-invalid',
        'An argument may only contain letters, digits, space and . _ - : / @ = + , — and nothing else.',
      )
    }
    const forbidden = FORBIDDEN_ARGUMENT_PATTERNS.find((pattern) =>
      entry.toLowerCase().includes(pattern.toLowerCase()),
    )
    if (forbidden !== undefined) {
      return refuse(
        'command-argument-unsafe',
        `"${entry}" contains "${forbidden}", which asks the program to run another program. No shell is involved, so nothing is being escaped — but this vector exists in every invocation somebody might approve, so it is refused outright.`,
      )
    }
    // The same path gate a download passes. An absolute path in an argument is a path
    // request wearing a disguise, and it is judged as one.
    if (ABSOLUTE_PATH_SHAPE.test(entry)) {
      const path = checkPath(entry, policy)
      if (!path.ok) {
        return refuse(
          path.code === 'path-outside-allowlist' ? 'command-argument-unsafe' : path.code,
          `The argument "${entry}" is a path, and that path was refused: ${path.reason}`,
        )
      }
    }
    args.push(entry)
  }

  /* -------------------------------------------------- the working directory */
  if (typeof raw.workingDirectory !== 'string') {
    return refuse('request-malformed', 'A terminal request must name a working directory, so the program cannot choose one itself.')
  }
  const working = checkPath(raw.workingDirectory, policy)
  if (!working.ok) {
    return refuse(
      working.code === 'path-outside-allowlist' ? 'command-working-directory-denied' : working.code,
      working.reason,
    )
  }

  /* ---------------------------------------------------------- the environment */
  const env: Record<string, string> = {}
  const rawEnv = raw.env === undefined || raw.env === null ? {} : raw.env
  if (typeof rawEnv !== 'object' || Array.isArray(rawEnv)) {
    return refuse('request-malformed', 'The environment must be an object of name to value.')
  }
  const envEntries = Object.entries(rawEnv as Record<string, unknown>)
  if (envEntries.length > DEVICE_HANDS_LIMITS.maxAllowedEnvNames) {
    return refuse(
      'budget-exceeded',
      `At most ${String(DEVICE_HANDS_LIMITS.maxAllowedEnvNames)} environment variables may be set for one command.`,
    )
  }
  for (const [name, value] of envEntries) {
    if (!policy.allowedEnvNames.includes(name)) {
      return refuse(
        'environment-variable-not-allowed',
        `"${name}" is not on this policy's environment allowlist (${policy.allowedEnvNames.join(', ')}). The environment is built from that list and never inherited from the process.`,
      )
    }
    if (typeof value !== 'string') {
      return refuse('request-malformed', `The value of "${name}" must be a string.`)
    }
    if (value.length === 0 || value.length > DEVICE_HANDS_LIMITS.maxCommandArgBytes) {
      return refuse(
        'command-argument-invalid',
        `The value of "${name}" must be between 1 and ${String(DEVICE_HANDS_LIMITS.maxCommandArgBytes)} characters.`,
      )
    }
    if (metacharactersIn(value).length > 0 || !SAFE_VALUE.test(value)) {
      return refuse(
        'command-argument-invalid',
        `The value of "${name}" contains a character this build will not pass to a program.`,
      )
    }
    env[name] = value
  }

  return {
    ok: true,
    command: Object.freeze({
      command,
      args: Object.freeze(args),
      workingDirectory: working.normalised,
      env: Object.freeze(env),
    }),
  }
}

/**
 * The canonical form of a command, for binding an approval to it.
 *
 * Every field that would change what the program does is in it, in a fixed order. It
 * is a string comparison rather than a hash here on purpose — the approval digest in
 * `./digest` hashes the canonical form, and the canonical form itself is what a test
 * can read and assert on, so the thing that decides authorisation is inspectable.
 */
export function commandCanonicalForm(command: TerminalCommand): string[] {
  return [
    command.command,
    ...command.args,
    command.workingDirectory,
    ...Object.keys(command.env)
      .sort()
      .map((name) => `${name}=${command.env[name] ?? ''}`),
  ]
}
