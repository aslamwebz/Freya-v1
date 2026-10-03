/**
 * THE VAULT ERROR.
 *
 * A closed set of failure codes, and — the part that matters — fixed messages that
 * never embed the key, the key bytes, the raw SQL that carried the key, or the
 * native driver's own error text. A wrong key and an unreadable file are the same
 * class of refusal to a caller: the Vault did not open, and no plaintext substitute
 * is offered.
 *
 * This is deliberately not a security event. A Vault that cannot open is reported
 * as degraded state by whatever owns it, never as a reason to fall back to a weaker
 * store.
 */
export type VaultErrorCode =
  | 'binding_unavailable'
  | 'key_unavailable'
  | 'key_invalid'
  | 'open_failed'
  | 'not_encrypted'
  | 'migration_failed'
  | 'backup_failed'
  | 'restore_failed'
  | 'closed'
  | 'invalid'

export class VaultError extends Error {
  constructor(
    readonly code: VaultErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'VaultError'
  }
}
