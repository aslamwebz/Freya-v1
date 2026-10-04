import {
  BROWSER_BRIDGE_LIMITS,
  isBrowserBridgeCapability,
  type BrowserBridgeCapability,
  type BrowserBridgeCommand,
  type BrowserBridgeRefusalCode,
} from './types'
import type { BridgeCrypto } from './crypto'

/**
 * The session registry: short-lived, connection-bound, replay-resistant identity.
 *
 * A session is not authority. It is the *identity* under which a command is considered.
 * The Device Hands grant gate still runs behind it, so a session with every capability
 * and no grant is refused by Core. The registry adds the properties that make the wire
 * itself safe:
 *
 *   - **Bound to one connection.** A session id lifted from another socket is
 *     `session-missing`, because the registry checks the connection, not just the id.
 *   - **Bound to one tab and origin, when shared.** A command naming a different tab is
 *     `tab-mismatch`; a command with no shared tab is `tab-not-shared`.
 *   - **Monotonic sequence.** A message that arrives at or below the last sequence is
 *     `sequence-out-of-order`, so a captured frame cannot be reordered into a fresh act.
 *   - **A bounded nonce window.** A repeated nonce is `nonce-replayed`.
 *   - **Idempotent commands.** The same idempotency key returns the first result, and the
 *     same key for a *different* command is `idempotency-conflict`.
 *
 * Pure except for the injected clock and crypto. No sockets, no `setTimeout`, no Node.
 */

export interface BridgeSession {
  readonly sessionId: string
  readonly connectionId: string
  readonly extensionId: string
  readonly tokenHash: string
  readonly createdAt: number
  readonly expiresAt: number
  capabilities: readonly BrowserBridgeCapability[]
  /** The tab the owner explicitly shared, or null when none is shared. */
  sharedTabId: number | null
  /** The origin captured at share time, so a navigation revokes the share. */
  sharedOrigin: string | null
  /** The page URL captured at share time. Re-read is refused after a navigation. */
  sharedUrl: string | null
  revoked: boolean
  revokedAt: number | null
  lastSeq: number
  readonly nonces: string[]
  readonly idempotency: Map<string, { readonly command: string; readonly result: unknown }>
}

export interface CreateSessionInput {
  readonly connectionId: string
  readonly extensionId: string
  readonly tokenHash: string
  readonly capabilities: readonly BrowserBridgeCapability[]
  readonly now: number
  readonly ttlMs?: number
}

export interface SessionRefusal {
  readonly code: BrowserBridgeRefusalCode
  readonly reason: string
  readonly session: BridgeSession | null
}

export type SessionAuthorization =
  | { readonly ok: true; readonly session: BridgeSession; readonly replayed: boolean }
  | { readonly ok: false; readonly refusal: SessionRefusal }

function clampTtl(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) {
    return BROWSER_BRIDGE_LIMITS.sessionTtlMs
  }
  return Math.min(Math.floor(requested), BROWSER_BRIDGE_LIMITS.sessionTtlMs)
}

function clampCapabilities(input: readonly BrowserBridgeCapability[]): readonly BrowserBridgeCapability[] {
  const seen = new Set<BrowserBridgeCapability>()
  for (const capability of input) {
    if (isBrowserBridgeCapability(capability)) seen.add(capability)
  }
  return Object.freeze([...seen])
}

export interface SessionRegistry {
  create(input: CreateSessionInput): BridgeSession
  get(sessionId: string): BridgeSession | null
  all(): readonly BridgeSession[]
  byConnection(connectionId: string): readonly BridgeSession[]
  /** Bind a tab, its URL and origin. Host-only; a client cannot call this. */
  bindTab(sessionId: string, tabId: number, url: string, origin: string): void
  unbindTab(sessionId: string): void
  /** Replace capabilities. Host-only, and clamped to the closed vocabulary. */
  setCapabilities(sessionId: string, capabilities: readonly BrowserBridgeCapability[]): void
  revoke(sessionId: string, now: number): boolean
  revokeConnection(connectionId: string, now: number): number
  close(sessionId: string): void
  /**
   * Authorise one inbound command frame.
   *
   * Returns `replayed: true` with the cached result when the idempotency key matches the
   * same command; the caller must then return the cached result rather than dispatch.
   */
  authorize(input: {
    readonly sessionId: string
    readonly connectionId: string
    readonly seq: unknown
    readonly nonce: unknown
    readonly idempotencyKey: unknown
    readonly command: BrowserBridgeCommand
    readonly now: number
  }): SessionAuthorization
  rememberResult(
    sessionId: string,
    idempotencyKey: string,
    command: BrowserBridgeCommand,
    result: unknown,
  ): void
}

export function createSessionRegistry(crypto: BridgeCrypto): SessionRegistry {
  const sessions = new Map<string, BridgeSession>()
  const byConnection = new Map<string, Set<string>>()

  function newSessionId(): string {
    return `sess-${crypto.sha256Hex(`${String(Date.now())}:${crypto.randomBytes(16).join(',')}`).slice(0, 32)}`
  }

  function sessionRefusal(
    code: BrowserBridgeRefusalCode,
    reason: string,
    session: BridgeSession | null,
  ): SessionRefusal {
    return { code, reason, session }
  }

  function forget(session: BridgeSession): void {
    sessions.delete(session.sessionId)
    const set = byConnection.get(session.connectionId)
    if (set !== undefined) {
      set.delete(session.sessionId)
      if (set.size === 0) byConnection.delete(session.connectionId)
    }
  }

  return {
    create(input) {
      const ttl = clampTtl(input.ttlMs)
      const session: BridgeSession = {
        sessionId: newSessionId(),
        connectionId: input.connectionId,
        extensionId: input.extensionId,
        tokenHash: input.tokenHash,
        createdAt: input.now,
        expiresAt: input.now + ttl,
        capabilities: clampCapabilities(input.capabilities),
        sharedTabId: null,
        sharedOrigin: null,
        sharedUrl: null,
        revoked: false,
        revokedAt: null,
        lastSeq: 0,
        nonces: [],
        idempotency: new Map(),
      }
      sessions.set(session.sessionId, session)
      let set = byConnection.get(input.connectionId)
      if (set === undefined) {
        set = new Set()
        byConnection.set(input.connectionId, set)
      }
      set.add(session.sessionId)
      return session
    },

    get(sessionId) {
      return sessions.get(sessionId) ?? null
    },

    all() {
      return [...sessions.values()]
    },

    byConnection(connectionId) {
      const ids = byConnection.get(connectionId)
      if (ids === undefined) return []
      return [...ids].map((id) => sessions.get(id)).filter((s): s is BridgeSession => s !== undefined)
    },

    bindTab(sessionId, tabId, url, origin) {
      const session = sessions.get(sessionId)
      if (session === undefined) return
      session.sharedTabId = tabId
      session.sharedUrl = url
      session.sharedOrigin = origin
    },

    unbindTab(sessionId) {
      const session = sessions.get(sessionId)
      if (session === undefined) return
      session.sharedTabId = null
      session.sharedUrl = null
      session.sharedOrigin = null
    },

    setCapabilities(sessionId, capabilities) {
      const session = sessions.get(sessionId)
      if (session === undefined) return
      session.capabilities = clampCapabilities(capabilities)
    },

    revoke(sessionId, now) {
      const session = sessions.get(sessionId)
      if (session === undefined) return false
      session.revoked = true
      session.revokedAt = now
      return true
    },

    revokeConnection(connectionId, now) {
      const ids = byConnection.get(connectionId)
      if (ids === undefined) return 0
      let count = 0
      for (const id of [...ids]) {
        const session = sessions.get(id)
        if (session !== undefined && !session.revoked) {
          session.revoked = true
          session.revokedAt = now
          count += 1
        }
      }
      return count
    },

    close(sessionId) {
      const session = sessions.get(sessionId)
      if (session !== undefined) forget(session)
    },

    authorize(input) {
      const session = sessions.get(input.sessionId)
      if (session === undefined) {
        return {
          ok: false,
          refusal: sessionRefusal('session-missing', 'There is no such session on this host.', null),
        }
      }
      if (session.connectionId !== input.connectionId) {
        return {
          ok: false,
          refusal: sessionRefusal(
            'session-missing',
            'That session id belongs to a different connection, so it is not this connection\'s to use.',
            session,
          ),
        }
      }
      if (session.revoked) {
        return {
          ok: false,
          refusal: sessionRefusal('session-revoked', 'That session was revoked.', session),
        }
      }
      if (input.now > session.expiresAt) {
        return {
          ok: false,
          refusal: sessionRefusal('session-expired', 'That session has expired.', session),
        }
      }

      // Sequence: strictly increasing. A frame at or below the last one is a reorder or
      // a replay, and both are refused rather than accommodated.
      if (typeof input.seq !== 'number' || !Number.isInteger(input.seq) || input.seq <= session.lastSeq) {
        return {
          ok: false,
          refusal: sessionRefusal(
            'sequence-out-of-order',
            `Message sequence ${String(input.seq)} is not greater than the last sequence ${String(session.lastSeq)}.`,
            session,
          ),
        }
      }

      // Nonce: bounded window, replay refused.
      if (
        typeof input.nonce !== 'string' ||
        input.nonce.length === 0 ||
        input.nonce.length > BROWSER_BRIDGE_LIMITS.maxIdChars
      ) {
        return {
          ok: false,
          refusal: sessionRefusal('payload-invalid', 'A command needs a bounded nonce.', session),
        }
      }
      if (session.nonces.includes(input.nonce)) {
        return {
          ok: false,
          refusal: sessionRefusal('nonce-replayed', 'That nonce has already been used on this session.', session),
        }
      }

      // Idempotency: same key + same command is a retry; same key + different command is
      // a conflict, because a key that can name two commands is not a key.
      if (
        typeof input.idempotencyKey !== 'string' ||
        input.idempotencyKey.length === 0 ||
        input.idempotencyKey.length > BROWSER_BRIDGE_LIMITS.maxIdChars
      ) {
        return {
          ok: false,
          refusal: sessionRefusal('payload-invalid', 'A command needs a bounded idempotency key.', session),
        }
      }
      const cached = session.idempotency.get(input.idempotencyKey)
      if (cached !== undefined) {
        if (cached.command !== input.command) {
          return {
            ok: false,
            refusal: sessionRefusal(
              'idempotency-conflict',
              'That idempotency key was already used for a different command.',
              session,
            ),
          }
        }
        return { ok: true, session, replayed: true }
      }

      // Accept: advance sequence, remember the nonce within its window.
      session.lastSeq = input.seq
      session.nonces.push(input.nonce)
      while (session.nonces.length > BROWSER_BRIDGE_LIMITS.maxNonceWindow) {
        session.nonces.shift()
      }
      return { ok: true, session, replayed: false }
    },

    rememberResult(sessionId, idempotencyKey, command, result) {
      const session = sessions.get(sessionId)
      if (session === undefined) return
      session.idempotency.set(idempotencyKey, { command, result })
      while (session.idempotency.size > BROWSER_BRIDGE_LIMITS.maxIdempotencyEntries) {
        const oldest = session.idempotency.keys().next().value
        if (oldest === undefined) break
        session.idempotency.delete(oldest)
      }
    },
  }
}
