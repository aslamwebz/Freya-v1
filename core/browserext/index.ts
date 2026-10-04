/**
 * Phase 43 — Browser Extension: the Core-side wire protocol, as one barrel.
 *
 * **Not wired into a composition root.** There is no import of this folder from
 * `core/index.ts`, no host adapter for a renderer, and no protocol projection. The
 * protocol is implemented and proved; it is *not* switched on, and nothing in it can
 * switch itself on. The Electron bridge in `electron/browserext` is the host side, and
 * the Manifest V3 extension in `extension/` is the device.
 *
 * The invariant: the extension grants nothing, and this bridge mints no authority. It
 * carries an identity and a set of host-decided capabilities; every page-touching
 * command is still dispatched through Device Hands, and therefore through Guard, the
 * Governor, STOP ALL and the grant gate.
 */

export {
  BROWSER_BRIDGE_PROTOCOL,
  BROWSER_BRIDGE_COMMANDS,
  isBrowserBridgeCommand,
  BROWSER_BRIDGE_CAPABILITIES,
  isBrowserBridgeCapability,
  BROWSER_BRIDGE_COMMAND_CAPABILITY,
  BROWSER_BRIDGE_COMMAND_ACTION,
  BROWSER_BRIDGE_OBSERVATION_CAPABILITIES,
  BROWSER_BRIDGE_CONTROL_CAPABILITIES,
  BROWSER_BRIDGE_REFUSAL_CODES,
  isBrowserBridgeRefusalCode,
  BROWSER_BRIDGE_REFUSAL_REASONS,
  BROWSER_BRIDGE_LIMITS,
  BROWSER_BRIDGE_AUDIT_EVENTS,
  BROWSER_PROTECTED_FIELD_KINDS,
  isBrowserProtectedFieldKind,
  type BrowserBridgeCommand,
  type BrowserBridgeCapability,
  type BrowserBridgeRefusalCode,
  type BrowserBridgeAuditEvent,
  type BrowserBridgeAuditEntry,
  type BrowserProtectedFieldKind,
  type BridgeHelloMessage,
  type BridgePairRequestMessage,
  type BridgeAuthRequestMessage,
  type BridgeCommandMessage,
  type BridgeEventMessage,
  type BridgeByeMessage,
  type BridgeInbound,
  type BridgeServerHello,
  type BridgePairOk,
  type BridgeAuthOk,
  type BridgeCommandResult,
  type BridgeRefusal,
  type BridgeOutbound,
} from './types'

export {
  BROWSER_BRIDGE_ALLOWED_SCHEMES,
  BROWSER_BRIDGE_INTERNAL_SCHEMES,
  isPrivateOrLocalHost,
  checkBridgePageUrl,
  checkBridgeFrame,
  classifyProtectedField,
  isProtectedField,
  protectedFieldRefusal,
  utf8Bytes,
  truncateUtf8,
  BROWSER_BRIDGE_TEXT_CEILING,
  type BridgeUrlOptions,
  type BridgeUrlReading,
  type BridgeFrameInput,
  type BridgeFrameReading,
  type BridgeFieldDescriptor,
} from './safety'

export {
  generatePairingCode,
  pairingCodeHash,
  tokenHash,
  generateToken,
  createPairingOffer,
  verifyPairingCode,
  codesMatch,
  type PairingOffer,
  type PairingVerification,
  type PairingOfferOptions,
} from './pairing'

export {
  toHex,
  base64Url,
  timingSafeStringEqual,
  type BridgeCrypto,
} from './crypto'

export {
  createSessionRegistry,
  type BridgeSession,
  type SessionRegistry,
  type SessionAuthorization,
  type SessionRefusal,
  type CreateSessionInput,
} from './session'

export {
  createBrowserBridge,
  parseInbound,
  originMatches,
  actionIdFor,
  BROWSER_BRIDGE_EVENTS,
  isBrowserBridgeEvent,
  type BrowserBridge,
  type BrowserBridgeOptions,
  type BrowserBridgePorts,
  type BridgeDispatchRequest,
  type BridgeDispatchResult,
  type InboundParse,
  type BrowserBridgeEvent,
} from './bridge'
