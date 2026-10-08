import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { chmodSync } from 'node:fs'
import { join, dirname } from 'node:path'

/**
 * The control-plane token.
 *
 * The token is the only thing standing between a local process and Freya's Core,
 * and it is a long random secret. It is generated on first launch and stored in
 * the OS user-data directory next to the rest of the durable profile, with
 * permissions that exclude any other user on the machine.
 *
 * What the token is *not*:
 *
 *   - It is not a session secret. A client that holds the token can connect at
 *     any time the pipe is open; revoking it is a file operation, not a server
 *     decision.
 *   - It is not derived from a model, a system value or anything predictable.
 *     32 random bytes, hex-encoded.
 *   - It is not the same as a model key. The model key never crosses the
 *     renderer bridge; the control token never crosses it either, and a
 *     compromised control token cannot read a model credential.
 *   - It is not logged. The transport only compares it; the comparison function
 *     is constant-time, and nothing on either side of it produces a log line
 *     with the token in it.
 */

const TOKEN_BYTES = 32
const TOKEN_FILENAME = 'control.token'
const FILE_MODE_OWNER_ONLY = 0o600

export interface TokenLocation {
  readonly path: string
}

export function tokenPath(userDataDir: string): string {
  return join(userDataDir, TOKEN_FILENAME)
}

export function loadOrCreateToken(userDataDir: string): string {
  const path = tokenPath(userDataDir)
  if (existsSync(path)) {
    const existing = readFileSync(path, 'utf8').trim()
    if (/^[0-9a-f]{64}$/.test(existing)) return existing
    // A file that is not a 32-byte hex token is treated as a corrupt secret and
    // replaced; the alternative is a host that hands out a token it cannot trust.
  }
  const fresh = randomBytes(TOKEN_BYTES).toString('hex')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, fresh + '\n', { encoding: 'utf8', mode: FILE_MODE_OWNER_ONLY })
  try {
    chmodSync(path, FILE_MODE_OWNER_ONLY)
  } catch {
    // Windows does not honour POSIX mode bits. The OS-level ACL on the user-data
    // directory is the real boundary there, and it has already been created by
    // Electron's app.getPath('userData') call. chmod failing is a soft warning,
    // not a security failure.
  }
  return fresh
}

/**
 * Constant-time token comparison.
 *
 * `timingSafeEqual` throws when the buffers are not the same length, so the
 * lengths are checked explicitly and a mismatch returns false without a
 * comparison. The actual bytes are still compared in constant time inside the
 * try block; a length mismatch and a value mismatch produce the same boolean.
 */
export function tokensMatch(expected: string, candidate: string): boolean {
  if (typeof expected !== 'string' || typeof candidate !== 'string') return false
  if (expected.length !== candidate.length) return false
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(candidate, 'utf8')
  if (a.length !== b.length) return false
  try {
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

/**
 * A small, per-process rate limiter for failed auth attempts.
 *
 * Brute-forcing a 32-byte hex token over a local pipe is computationally
 * infeasible, but a local DoS by spammy unauthenticated connect attempts is
 * cheap, so the limiter blocks that direction only. Authenticated clients are
 * not rate-limited here; the upstream `BUDGET` is enforced by Core itself.
 */
export class AuthFailureLimiter {
  private failed = 0
  private cooldownUntil = 0
  constructor(
    private readonly maxFailures: number = 5,
    private readonly cooldownMs: number = 5_000,
  ) {}

  allow(now: number = Date.now()): boolean {
    return now >= this.cooldownUntil
  }

  noteFailure(now: number = Date.now()): void {
    this.failed += 1
    if (this.failed >= this.maxFailures) {
      this.cooldownUntil = now + this.cooldownMs
      this.failed = 0
    }
  }

  noteSuccess(): void {
    this.failed = 0
    this.cooldownUntil = 0
  }
}
