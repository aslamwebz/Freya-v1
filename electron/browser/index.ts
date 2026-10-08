/**
 * Phase 51 — Dual Browser Runtime: the Electron side, as one barrel.
 *
 * Everything here is main-process only and touches the operating system; the decisions live
 * in `core/browser`, which this folder imports and which imports nothing from it.
 *
 *   - `./freyaWindow` — the embedded Freya Browser. A window in a non-persistent partition,
 *     every permission denied, no private or local address reachable, no download written.
 *   - `./publicAdapter` — that window's implementation of the **existing** Device Hands
 *     browser port, Electron-free so its refusals are testable without a display.
 *   - `./activation` — the composition. It is given the Phase 35 runtime and the Phase 43
 *     extension host and builds neither.
 */

export {
  ElectronFreyaWindowFactory,
  FREYA_BROWSER_DENIED_PERMISSIONS,
  type FreyaWindowFactoryOptions,
  type FreyaWindowOptions,
} from './freyaWindow'

export {
  createFreyaBrowserAdapter,
  type FieldDescriptor,
  type FreyaBrowserAdapter,
  type FreyaBrowserAdapterOptions,
  type FreyaBrowserPage,
  type FreyaBrowserPageFactory,
} from './publicAdapter'

export {
  createDualBrowserActivation,
  type DualBrowserActivation,
  type DualBrowserActivationOptions,
  type DualBrowserActivationState,
  type DualBrowserActivationStatus,
  type Phase51Authority,
} from './activation'

export * from './embeddedSurface'
export * from './semanticRequest'
