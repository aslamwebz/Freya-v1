/**
 * Phase 43 — Browser Extension: the Electron host side.
 *
 * `core/browserext` is the pure protocol. This folder is the only part that owns a
 * socket, a clock or `node:crypto`, and it is wired to the existing Phase 35 Device
 * Hands runtime rather than to a second browser-control stack.
 */

export { nodeBridgeCrypto } from './crypto'

export {
  WS_GUID,
  WS_OPCODE,
  computeAcceptKey,
  encodeFrame,
  encodeText,
  encodeClose,
  encodePing,
  encodePong,
  decodeClientFrames,
  type WsFrame,
  type WsDecodeResult,
} from './wsFrames'

export {
  isExtensionResponse,
  type ExtensionRequest,
  type ExtensionResponse,
  type ElementDescriptor,
} from './protocol'

export {
  createBrowserAdapter,
  type BrowserAdapter,
  type BrowserAdapterOptions,
  type BrowserTransport,
  type ActionContext,
} from './browserAdapter'

export {
  createBridgeServer,
  type BridgeServer,
  type BridgeServerOptions,
} from './bridgeServer'

export {
  createBrowserExtensionHost,
  createInMemoryTokenStore,
  type BrowserExtensionActivation,
  type BrowserExtensionHost,
  type BrowserExtensionHostOptions,
  type BridgeTokenStore,
  type BridgeTokenRecord,
} from './host'
