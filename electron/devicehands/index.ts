/**
 * Phase 42 — Device Hands host activation.
 *
 * The real host adapters for Phase 35's four surfaces, the durable journal they
 * derive from, and the explicit activation that switches them on. Nothing here is
 * reachable from a renderer: the composition lives in the Electron main process, and
 * the only things that cross to a window are Core's own projections.
 *
 * See `core/devicehands/README.md` for the runtime and `PHASE-35.md` for the security
 * argument. The short version of what this directory adds:
 *
 *   - `journal.ts`   — a durable, hash-chained record. A tampered line refuses to open.
 *   - `effects.ts`   — the six bounded effects, each with an injected primitive so a
 *                      refusal can be proved by a counter that did not move.
 *   - `activation.ts`— explicit activate/deactivate, and the honest list of the two
 *                      browser actions this architecture will not run.
 *   - `electronEffects.ts` — the production primitives: Electron's clipboard, Node's
 *                      process spawner, the managed read-only browser and a pinned
 *                      HTTP transport.
 */

export { openDeviceHandsJournal, type DeviceHandsJournal } from './journal'
export {
  createDeviceHandsEffects,
  type ByteStream,
  type ClipboardLike,
  type DeviceBrowserFactory,
  type DeviceBrowserSession,
  type DeviceHandsEffects,
  type DeviceHandsEffectsDeps,
  type HttpGetLike,
  type HttpGetLikeResult,
  type HttpPostLike,
  type ResolveExecutable,
  type SpawnFn,
  type SpawnOptions,
  type SpawnedProcess,
  type TerminalDeps,
  type TransferDeps,
} from './effects'
export {
  createDeviceHandsActivation,
  denyAllAuthority,
  DEVICE_HANDS_BLOCKED_ACTIONS,
  type DeviceHandsActivation,
  type DeviceHandsActivationOptions,
  type DeviceHandsActivationRequest,
  type DeviceHandsActivationResult,
  type DeviceHandsActivationStatus,
  type DeviceHandsAuthority,
  type DeviceHandsBlockedAction,
} from './activation'
export { createElectronDeviceHandsEffects } from './electronEffects'
