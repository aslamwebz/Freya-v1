/* ------------------------------------------------------------ identity */

/** A principal asking Core for something. Never carries credentials. */
export type PrincipalId =
  | 'owner'
  | 'system'
  | `agent:${string}`
  | `module:${string}`
