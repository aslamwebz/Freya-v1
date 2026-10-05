/**
 * CONNECTOR AUTHORIZATION — state, nonce and PKCE, and the callback check.
 *
 * This file is pure and host-agnostic: it builds the opaque values an OAuth
 * authorization request needs and verifies the callback that comes back. The
 * *secrets* — a code verifier, a client secret — never leave the host process,
 * and the only value Core ever records is the `requestId` it issued.
 *
 * ## Why all three
 *
 *   - **state** binds the callback to the request this process started. A
 *     callback whose state does not match a pending request is a forgery and is
 *     refused.
 *   - **nonce** binds the resulting identity token to this request, so a token
 *     minted for another session cannot be replayed into this one.
 *   - **PKCE** (`S256`) proves the process that redeems the code is the one that
 *     asked for it, so an intercepted code is useless without the verifier.
 *
 * Every value is drawn from the platform CSPRNG. A caller may inject the
 * randomness source for deterministic tests; nothing else about the flow is
 * configurable.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { ConnectorKind } from './types'
import { CONNECTOR_LIMITS } from './types'

export interface PkcePair {
  readonly verifier: string
  readonly challenge: string
  readonly method: 'S256'
}

export interface AuthRequest {
  readonly requestId: string
  readonly connector: ConnectorKind
  readonly state: string
  readonly nonce: string
  readonly codeVerifier: string
  readonly codeChallenge: string
  readonly createdAt: string
}

export interface AuthCallback {
  readonly state: string
  readonly code: string
  /** The `nonce` echoed by the provider's identity token, when it has one. */
  readonly nonce?: string | null
}

export type AuthCallbackVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly failureCode: 'invalid_request' | 'cross_account'; readonly reason: string }

const RANDOM_BYTES = 32
const VERIFIER_BYTES = 32

/** base64url without padding, the encoding RFC 7636 specifies. */
export function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** A PKCE verifier/challenge pair. The verifier is 43–128 characters. */
export function createPkcePair(random: (size: number) => Uint8Array = (size) => new Uint8Array(randomBytes(size))): PkcePair {
  const verifier = base64UrlEncode(random(VERIFIER_BYTES))
  const challenge = base64UrlEncode(createHash('sha256').update(verifier).digest())
  return { verifier, challenge, method: 'S256' }
}

/**
 * Build one authorization request.
 *
 * `requestId` is Core's id for the pending request; the rest stay host-side.
 * The state and nonce are independent random values, so a leaked state does not
 * imply a leaked nonce.
 */
export function createAuthRequest(input: {
  requestId: string
  connector: ConnectorKind
  now: Date
  random?: (size: number) => Uint8Array
}): AuthRequest {
  const random = input.random ?? ((size: number) => new Uint8Array(randomBytes(size)))
  const pkce = createPkcePair(random)
  return {
    requestId: input.requestId,
    connector: input.connector,
    state: base64UrlEncode(random(RANDOM_BYTES)),
    nonce: base64UrlEncode(random(RANDOM_BYTES)),
    codeVerifier: pkce.verifier,
    codeChallenge: pkce.challenge,
    createdAt: input.now.toISOString(),
  }
}

/** Constant-time equality for two short tokens. */
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/**
 * Verify a callback against the request this process started.
 *
 * Every failure is a closed verdict, never a thrown error, so the caller can
 * journal the refusal without catching. The order matters: state is checked
 * first, because an unmatched state means the callback is not for a request
 * this process holds and nothing else about it can be trusted.
 */
export function verifyAuthCallback(
  request: AuthRequest,
  callback: AuthCallback,
  now: Date,
): AuthCallbackVerdict {
  const requestedMs = Date.parse(request.createdAt)
  if (!Number.isFinite(requestedMs) || now.getTime() - requestedMs > CONNECTOR_LIMITS.authRequestTtlMs) {
    return { ok: false, failureCode: 'invalid_request', reason: 'the authorization request has expired' }
  }
  if (typeof callback.state !== 'string' || !safeEqual(callback.state, request.state)) {
    return { ok: false, failureCode: 'cross_account', reason: 'the callback state does not match a pending request' }
  }
  if (typeof callback.code !== 'string' || callback.code.length === 0) {
    return { ok: false, failureCode: 'invalid_request', reason: 'the callback carried no authorization code' }
  }
  if (callback.nonce !== undefined && callback.nonce !== null) {
    if (!safeEqual(callback.nonce, request.nonce)) {
      return { ok: false, failureCode: 'cross_account', reason: 'the callback nonce does not match this request' }
    }
  }
  return { ok: true }
}
