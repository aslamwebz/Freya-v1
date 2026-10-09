import { CapabilitySettingsStore } from './capabilitySettings'
import { readRuntimeCapabilityRegistry } from '../core/model/capability-runtime'
import type { CapabilityPreferences } from '../core/capabilities'
import { app, BrowserWindow, WebContentsView, ipcMain, protocol, screen, shell, safeStorage, Notification } from 'electron'
import { join, resolve } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { WorkspaceFile, DEFAULT_MAX_BYTES } from './workspaceFile'
import { fetchDocumentBytes, fetchThumbnail, fetchVideoPreview, attachEmbedView, detachEmbedView } from './media'
import { ElectronCoreHost, type HostEnv, type DeviceHandsHostOptions } from './coreHost'
import {
  createElectronDeviceHandsEffects,
  denyAllAuthority,
  openDeviceHandsJournal,
} from './devicehands'
import { loadKeyring } from './keyring'
import { ProviderConfigStore } from './providerConfig'
import { createFreyaVaultBinding } from './vaultBinding'
import { loadLocalEnv } from './localEnv'
import { createConnectorRuntime } from './connectors/runtime'
import { createOwnWindowProvider, createSystemWindowProvider } from './context/windowProviders'
import { createElectronOwnWindowSource } from './context/electronWindowSource'
import { pickAttachments } from './attachments'
import { PresenceHost } from './presence/host'
import { createBrowserExtensionHost, type BrowserExtensionHost } from './browserext'
import { HostVoiceOutput, registerVoiceOutputIpc } from './voiceHost'
import { HostVoiceInput } from './voiceInput'
import type { EffectiveVoiceSettings } from './voiceCapabilities'
import type { CapabilityReadiness } from '../core/capabilities'
import type { VoiceSettings } from '../core/voice/settings'
import { voiceCapabilityReadiness, effectiveVoiceSettings, gateVoiceInput, gateVoiceOutput } from './voiceCapabilities'
import { LocalWhisperHost } from './localWhisper'
import { LocalWakeHost } from './localWake'
import { MicrophoneGate } from './microphoneGate'
import { DEFAULT_VOICE_CONFIG, VOICE_FOLLOW_UP_WINDOW_MS, VoiceConfigStore, type VoiceConfigPatch } from './voiceConfig'
import { DEFAULT_VOICE_SETTINGS } from '../core/voice/settings'
import { buildLocalWakeGate } from '../core/voice/wake'
import {
  createDualBrowserActivation,
  createFreyaBrowserAdapter,
  ElectronFreyaWindowFactory,
  type DualBrowserActivation,
} from './browser'
import { startControl, type ControlHandle } from './control'
import { installSingleInstanceGuard } from './startup/singleInstance'
import type { CoreCommandEnvelope } from '../core/protocol/core-protocol'
import type { ProviderConfigInput } from './providerConfig'
import type { ModelProvider } from '../core/model/provider'
import type { GrantFact } from '../core/devicehands'
import type { BrowserResult } from '../core/browser'
import { normaliseBrowserDockRequest, normaliseRendererBrowserRequest, type BrowserBridgeState } from './browser/rendererRequest'
import { createEmbeddedBrowserSurface } from './browser/embeddedSurface'
import { createScreenshotResource } from './browser/screenshotResource'
import { normaliseSemanticBrowserRequest } from './browser/semanticRequest'
import { clampSurfaceBounds, createBrowserService, type BrowserService } from '../core/browser/service'
import { EncryptedConversationStore } from '../core/conversation/encrypted-store'

const HERE = __dirname
const ROOT = join(HERE, '..')
const DEV_SERVER = process.env.FREYA_DEV_SERVER
const WORKSPACE_FILE = 'workspace.json'
const CORE_LOG_FILE = 'core-events.jsonl'

// Captured before the `.env` loader runs. A stored provider setting is applied
// beneath this snapshot at startup, so an explicit launch always wins over both a
// `.env` file and the app's saved settings. Never logged or forwarded.
const EXPLICIT_ENV: NodeJS.ProcessEnv = { ...process.env }

// Local `.env` first, in the main process, before anything reads configuration.
// Real environment variables win over the file; values are never logged, and
// nothing here is forwarded to a window — the preload bridge carries named
// commands and bounded payloads only, never environment content.
loadLocalEnv(join(ROOT, '.env'))

let mainWindow: BrowserWindow | null = null
let dockedBrowserFactory: ElectronFreyaWindowFactory | null = null
/** Null until the app is ready; every handler that needs it is registered after. */
let workspace: WorkspaceFile | null = null
/**
 * The provider config, beside the workspace and for the same reason: main-only,
 * created once the app is ready, reached from a window only through named IPC.
 */
let providerStore: ProviderConfigStore | null = null
let capabilityStore: CapabilitySettingsStore | null = null
let capabilityPreferences: CapabilityPreferences = {}
/** One Core per process. Survives renderer reloads; dies only with the app. */
let coreHost: ElectronCoreHost | null = null
/**
 * Speech output, hosted.
 *
 * Created once, before Core, and lives independently of it so a Core rebuild —
 * which happens every time the provider settings change — does not lose the list
 * of voices the window reported or strand an utterance that was playing.
 */
let voiceConfig: VoiceConfigStore | null = null
const rawVoicePreferences = () => voiceConfig?.current ?? DEFAULT_VOICE_SETTINGS
const legacyVoicePreferences = () => voiceConfig?.legacyCurrent ?? DEFAULT_VOICE_CONFIG
const voiceReadiness = (): CapabilityReadiness => voiceCapabilityReadiness({ platformAvailable: voiceOutput.platformAvailable, localInstalled: localWhisper.installed, nanoKeyPresent: !!process.env.NANOGPT_API_KEY?.trim(), remoteAudioEnabled: rawVoicePreferences().remoteAudioEnabled })
const selectedVoice = (): EffectiveVoiceSettings => effectiveVoiceSettings(rawVoicePreferences(), capabilityPreferences, voiceReadiness())
const voicePreferences = (): VoiceSettings => selectedVoice().settings
const voiceOutput = new HostVoiceOutput({ settings: voicePreferences, key: () => process.env.NANOGPT_API_KEY })
const localWhisper = new LocalWhisperHost(join(ROOT, '.local', 'whisper'))
const localWake = new LocalWakeHost(ROOT,
  () => { const p = coreHost?.voice(); if (p?.wake.armed && p.micEnabled && p.permission === 'granted' && p.state !== 'stopped-by-STOP-ALL' && !p.attention?.active) void coreHost?.detectVoiceWake().catch(() => {}) },
  () => { microphoneGate.standbyReady = false; void coreHost?.submit({ command: 'voice.mic.disable', requestId: 'wake-detector-stopped', payload: { reason: 'The local wake detector stopped. Turn the microphone on to retry.' } }).catch(() => {}) })
const voiceInput = new HostVoiceInput(voicePreferences, () => process.env.NANOGPT_API_KEY, fetch, () => localWhisper.installed)
/** The presence host. Owns the presence window and pushes frames to it. */
let presenceHost: PresenceHost | null = null
/**
 * The browser-extension bridge, when Device Hands is switched on.
 *
 * Null means the extension cannot act at all, which is the state whenever
 * `FREYA_DEVICE_HANDS` is not `1`. Kept beside the other host singletons so the
 * shutdown path can reach it.
 */
let browserExtensionHost: BrowserExtensionHost | null = null
/**
 * Phase 51's dual-browser runtime.
 *
 * **Null unless the owner opted in twice**: `FREYA_DEVICE_HANDS=1` *and*
 * `FREYA_PUBLIC_BROWSER=1`. The first is Phase 42's switch and the second is this phase's,
 * and the second cannot be useful without the first — the browser surfaces are gated by a
 * Device Hands runtime, so a public browser with no runtime behind it would have no gates at
 * all. That is the same rule Phase 43 followed when it refused to be `active` without Phase 42.
 */
let dualBrowser: DualBrowserActivation | null = null
/**
 * The control plane: the named-pipe / Unix-socket server that gives external tools
 * (CLI, MCP, scripts) a narrow view of Core and the Browser Service. One owner,
 * one pipe, no second process. Started after Core, stopped before Core, so the
 * channel and the journal are owned by the same lifetime.
 */
let controlHandle: ControlHandle | null = null
/**
 * The Browser Service: tabs, orchestration and the Semantic Browser Protocol.
 *
 * Built **after** the activation succeeds and not before, because the service's whole point is
 * to be a vocabulary over that activation. Before it, there is nothing to speak about.
 *
 * Its surface is the embedded one: one real `WebContentsView` per tab, created here and
 * placed by the renderer through a bounds message. The service knows nothing about
 * `BrowserWindow`, and a Browser Relay surface would be a different object implementing the
 * same port with no change to anything above it.
 */
let browserService: BrowserService | null = null
/**
 * The last state pushed to the window, as a string, so an unchanged push is skipped.
 *
 * The surface reports title updates, loading transitions and navigations. Serialising every
 * one of them to compare is far cheaper than serialising them across a process boundary to
 * be discarded there, and a renderer that redraws on an identical object is a renderer that
 * rebuilds its tab strip for nothing.
 */
let lastPushedBrowserState = ''
/**
 * The Freya Browser's adapter, created before Device Hands so the effects can resolve it lazily.
 *
 * It is a *factory*, not an activation: nothing is opened by constructing it, and it only
 * becomes reachable through `openInPage` when a live window is serving the authorised URL. A
 * build that never opens the Freya Browser never reaches it, and every read falls through to
 * the Phase 5 managed target exactly as it did before this phase existed.
 */
let publicBrowserAdapter: ReturnType<typeof createFreyaBrowserAdapter> | null = null
/**
 * The bounded attention wake.
 *
 * Attention's scheduled events need a clock, and this process is the only one
 * allowed to drive it: there is no `attention.tick` command, so a window cannot
 * cause a schedule to fire. The interval is deliberately coarse and does no model
 * call, no provider contact and no network access.
 */
let attentionTimer: ReturnType<typeof setInterval> | null = null
/** Resolves when the renderer has answered the closing-time request. */
let pendingCollect: (() => void) | null = null
let quitting = false

/**
 * Phase 42 Device Hands: the production composition.
 *
 * Off unless `FREYA_DEVICE_HANDS=1` is set in the main-process environment, so a
 * build that was not deliberately opted in has no Device Hands runtime at all. When
 * it is on, the surface policy is assembled from the environment, the grants are read
 * from an owner-authored file in the profile, and the authority denies every owner
 * approval — so only the three actions Phase 35 does not require approval for
 * (`browser.navigate`, `browser.read-text`, `transfer.download`) can run, and only
 * against roots, hosts and commands the owner named. Everything else is refused.
 *
 * This is the unresolved seam stated plainly: there is no Core-owned Device Hands
 * grant-minter or owner-approval channel in this architecture, so this host reads an
 * owner-authored grant file rather than minting one, and it denies approvals rather
 * than fabricating an owner. A surface that needs an approval therefore stays blocked.
 */
function splitDeviceHandsList(value: string | undefined): string[] {
  if (value === undefined) return []
  return value
    .split(';')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

/**
 * Local development is permissive by default so capability testing exercises Freya
 * rather than approval plumbing. Packaged builds stay strict. Set
 * FREYA_LOCAL_UNRESTRICTED=0 to test the strict path locally.
 */
function localUnrestrictedMode(): boolean {
  if (process.env.FREYA_LOCAL_UNRESTRICTED === '0') return false
  return process.env.FREYA_LOCAL_UNRESTRICTED === '1' || !app.isPackaged
}

function readDeviceHandsGrants(path: string): GrantFact[] {
  if (!existsSync(path)) return []
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (entry): entry is GrantFact => typeof entry === 'object' && entry !== null && !Array.isArray(entry),
    )
  } catch {
    // A grant file that cannot be parsed is no grants, not a permissive default.
    return []
  }
}

function buildDeviceHandsSeam(): DeviceHandsHostOptions | undefined {
  const localUnrestricted = localUnrestrictedMode()
  if (!localUnrestricted && process.env.FREYA_PUBLIC_BROWSER === '0' && process.env.FREYA_DEVICE_HANDS !== '1') return undefined
  const userData = app.getPath('userData')
  const grants = localUnrestricted
    ? []
    : readDeviceHandsGrants(join(userData, 'device-hands.grants.json'))
  const journal = openDeviceHandsJournal(join(userData, 'device-hands.jsonl'))
  const effects = createElectronDeviceHandsEffects({
    /**
     * Phase 51's second door, resolved **per call** rather than at construction.
     *
     * This is the whole wiring. The adapter is added to the managed browser factory rather
     * than replacing it, so:
     *
     *   - a read that no live window is serving still goes to the Phase 5 managed target;
     *   - a click with no live window still resolves to `browser-action-unsupported`;
     *   - and a click **with** one is driven by the Freya Browser, through the same runtime,
     *     the same grant and the same ten gates as everything else.
     */
    inPageFactory: () => publicBrowserAdapter?.inPage ?? null,
  })
  const authority = denyAllAuthority({
    enabled: () => true,
    activeGrant: (principalId, scope) =>
      coreHost?.ownerBrowserGrant(principalId, scope) ?? grants.find(
        (grant) => grant.principalId === principalId && grant.scope === scope && grant.revokedAt === null,
      ) ?? null,
  })
  return {
    effects,
    journal,
    authority,
    policy: localUnrestricted
      ? {
          localUnrestricted: true,
          allowedRoots: [],
          deniedRoots: [],
          allowedHosts: [],
          allowedCommands: [],
          allowedEnvNames: [],
        }
      : {
          ownerPublicBrowser: process.env.FREYA_PUBLIC_BROWSER !== '0',
          allowedRoots: splitDeviceHandsList(process.env.FREYA_DEVICE_HANDS_ROOTS),
          deniedRoots: [join(userData, 'vault')],
          allowedHosts: splitDeviceHandsList(process.env.FREYA_DEVICE_HANDS_HOSTS),
          allowedCommands: splitDeviceHandsList(process.env.FREYA_DEVICE_HANDS_COMMANDS),
          // Device Hands refuses an empty allowlist — correctly, since "nothing is shared"
          // must be a decision somebody made. A surface that genuinely shares nothing
          // therefore has to say so with a name it will never match, rather than with an
          // empty list the policy refuses outright. Without this, a strict build could
          // not start the browser at all and every page read arrived as
          // `authority-refused`, which reads like a permissions problem rather than a
          // list nobody filled in.
          allowedEnvNames: splitDeviceHandsList(process.env.FREYA_DEVICE_HANDS_ENV_NAMES),
        },
    grants,
    enabled: true,
    localUnrestricted,
  }
}

/**
 * Build the Phase 51 adapter and activation, but only when both switches are on.
 *
 * Returns null — not a disabled object — because "there is no dual-browser runtime" is the
 * honest description of a build that was not opted in, and a caller that got an object would
 * reasonably assume there was something behind it.
 *
 * Approvals are denied in exactly the shape Phase 42 denies them. That means `page.click` and
 * `page.type` are refused at the Phase 35 approval gate in a default build, while the reads
 * run. Saying so here is more useful than quietly inventing an approval channel: the acts are
 * implemented and gated, and the missing piece is a Phase 35 seam, not a Phase 51 one.
 */
function buildDualBrowserSeam(extension: BrowserExtensionHost | null): DualBrowserActivation | null {
  const localUnrestricted = localUnrestrictedMode()
  if (!localUnrestricted && process.env.FREYA_PUBLIC_BROWSER === '0') return null

  const allowedHosts = localUnrestricted
    ? []
    : splitDeviceHandsList(process.env.FREYA_DEVICE_HANDS_HOSTS)
  dockedBrowserFactory = new ElectronFreyaWindowFactory({
      hostWindow: () => mainWindow,
      onOpenUrl: (url) => mainWindow?.webContents.send('freya:browser:open-url', url),
      allowedHosts,
      localUnrestricted,
      allowPrivateHosts: localUnrestricted,
      allowProtectedFields: localUnrestricted,
    })
  const adapter = createFreyaBrowserAdapter({
    factory: dockedBrowserFactory,
    poolSize: 12,
    publicAvailable: () => true,
    localUnrestricted,
  })
  publicBrowserAdapter = adapter

  const journal = coreHost?.deviceHandsJournal() ?? null
  if (journal === null) return null

  return createDualBrowserActivation({
    authority: {
      // Core's own latch is composed in by `coreHost`, exactly as it is for Device Hands.
      stopAllActive: () => false,
      perform: (request) => request.principalId === 'owner:browser' ? requireCore().performOwnerBrowserAction(request) : requireCore().performDeviceHandsAction(request),
    },
    // The **same** hash-chained journal Device Hands already appends to. One writer, one chain.
    journal,
    adapter,
    extension,
    allowedHosts,
    localUnrestricted,
    allowPrivateHosts: localUnrestricted,
    onLog: (line) => console.log(`[freya] ${line}`),
  })
}

/**
 * Assemble the Browser Service over the activation and the embedded surface.
 *
 * The activation has already succeeded by the time this runs, which is the only ordering that
 * makes sense: the service is a vocabulary over that activation, so there is nothing for it
 * to say before it exists.
 *
 * Two details are worth stating because each was the previous build's failure mode:
 *
 *   - **State is pushed, not polled.** The surface reports navigations, loads, failures and
 *     title changes; the service re-publishes; the window is sent the result. The workspace
 *     no longer re-reads the whole projection on a timer, which matters more the more tabs
 *     are open and not at all when there are none.
 *   - **The window has no easier path in.** A tab opened from the renderer is created
 *     through the service like any other, so it gets the same lifecycle, the same URL policy
 *     and the same journal entry as a tab Freya opened for itself.
 */
function mountBrowserService(seam: DualBrowserActivation): void {
  const factory = dockedBrowserFactory
  if (factory === null) {
    console.warn('[freya] the browser service did not mount: no embedded page factory')
    return
  }
  // The screenshot resource is a per-session PNG store, served over the
  // `freya-browser://` custom protocol. We register it on the *renderer* session
  // (the one the chat surface fetches from), not the Freya Browser session,
  // because the renderer is what draws the screenshot card.
  const screenshotResource = createScreenshotResource()
  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    try {
      screenshotResource.register(mainWindow.webContents.session)
    } catch (error) {
      // The protocol can already be registered on this session; we ignore that
      // because the previous instance went away with the previous app launch.
      void error
    }
  }
  const surface = createEmbeddedBrowserSurface({
    create: async (sessionId, partition) => await factory.create(sessionId, partition),
    // The factory docks exactly one view and undocks the rest, so "the front tab" is a fact
    // about the placement rather than something this file has to track itself.
    place: (sessionId, bounds) => factory.dock(sessionId, bounds),
    partitionFor: (sessionId) => `freya-public-${sessionId}`,
    canEmbed: () => mainWindow !== null && !mainWindow.isDestroyed(),
    // A capture needs a rect to place the view in. The window's own content
    // bounds are the honest default: it is the largest area a tab can occupy,
    // and it is re-derived per capture so a resize or a display move is not
    // answered with a stale rectangle.
    contentBounds: () => {
      const window = mainWindow
      if (window === null || window.isDestroyed()) return null
      return clampSurfaceBounds({ x: 0, y: 0, width: window.getContentBounds().width, height: window.getContentBounds().height }, window.getContentBounds())
    },
    screenshotResource,
  })
  const journal = coreHost?.deviceHandsJournal() ?? null
  browserService = createBrowserService({
    surface,
    commands: {
      execute: (request, context) => seam.execute(request, context),
      active: () => seam.active(),
    },
    allowedHosts: splitDeviceHandsList(process.env.FREYA_DEVICE_HANDS_HOSTS),
    allowPrivateHosts: localUnrestrictedMode(),
    ...(journal === null
      ? {}
      : {
          // The journal is opened over `DeviceHandsEventType`, so a browser event type is a
          // cast at this boundary rather than a widened union. The cast is honest: the Phase
          // 51 activation appends its own event types to the same file through exactly this
          // journal, and the file validates each payload against its own table on the way in.
          record: async (type, payload) => {
            await journal.append(type as Parameters<typeof journal.append>[0], payload)
          },
        }),
    clockMs: () => Date.now(),
  })

  const status = seam.status()
  const recovery = seam.recovery()
  // The list of what *could* be reopened, and is not.
  //
  // A page does not survive its process, so reopening one means navigating to it — and a
  // navigation to a site that has changed in the meantime is a side effect on somebody's
  // account that nobody asked for. So the list is reported, bounded to the code ceiling, and
  // left for whoever asks. Claiming a restore that has not happened would be the dishonest
  // half of recovery, and creating empty tabs for the lost sessions would be the other half:
  // a chip with no page behind it is the very shape this whole change exists to remove.
  const restorable = recovery.sessionsLost
    .filter((lost): lost is { readonly sessionId: string; readonly url: string } => typeof lost.url === 'string' && lost.url !== '')
    .slice(0, 32)
    .map((lost) => ({ sessionId: lost.sessionId, url: lost.url }))
  browserService.trust(status.journalTrustworthy, {
    trustworthy: recovery.trustworthy,
    sessionsLost: recovery.sessionsLost.length,
    referencesRetired: recovery.referencesRetired,
    restored: 0,
    skipped: recovery.sessionsLost.length - restorable.length + recovery.handoffsUncertain.length,
    restorable,
    summary: recovery.summary,
  })

  browserService.subscribe((state) => {
    // A window that has gone away gets nothing: sending to a destroyed webContents throws,
    // and a browser must not be able to take the app down on the way out.
    const window = mainWindow
    if (window === null || window.isDestroyed() || window.webContents.isDestroyed()) return
    const serialised = JSON.stringify(state)
    if (serialised === lastPushedBrowserState) return
    lastPushedBrowserState = serialised
    window.webContents.send('freya:browser:event', state)
  })
  console.log('[freya] the browser service is mounted on the embedded surface')
}

/**
 * The state the window reads.
 *
 * When the Browser Service is mounted this is **its** projection and nothing else: the Phase
 * 51 fields are folded in so an older consumer of this channel keeps working, but the fields
 * a renderer should branch on are `runtimeStatus` and `reason`. A runtime with no tabs and a
 * runtime that cannot open one are both `available: false` in the old shape, and telling them
 * apart was the whole of Part 3.
 */
function browserBridgeState(): BrowserBridgeState {
  const service = browserService
  if (service !== null) {
    const projected = service.state()
    const seam = dualBrowser
    const phase51 = seam === null ? null : seam.projection()
    return {
      ...projected,
      extensionPaired: seam?.status().extensionPaired ?? false,
      extensionLive: seam?.status().extensionLive ?? false,
      described: phase51?.described ?? 0,
      staleRefs: phase51?.staleRefs ?? 0,
      mediaObserved: phase51?.mediaObserved ?? 0,
      refusals: phase51?.refusals ?? 0,
      summary: projected.reason ?? `${String(projected.tabCount)} tab(s); the Freya Browser is available.`,
      phase51: phase51?.sessions ?? [],
    }
  }
  const seam = dualBrowser
  if (seam === null) {
    return {
      available: false,
      active: false,
      reason: 'The Freya Browser is not enabled in this build, so no page can be opened.',
      publicAvailable: false,
      journalTrustworthy: false,
      runtimeStatus: 'surfaceUnavailable',
      activeTabId: null,
      tabs: [],
      tabCount: 0,
      recovery: null,
      extensionPaired: false,
      extensionLive: false,
      summary: 'the browser is not available in this build',
      sessions: [],
      phase51: [],
      described: 0,
      staleRefs: 0,
      mediaObserved: 0,
      refusals: 0,
    }
  }

  // The activation exists but the service does not. That is a real and different state from
  // either "no browser" or "browser ready": something in the mount failed, and the owner is
  // owed that rather than a blank workspace.
  const status = seam.status()
  return {
    available: false,
    active: false,
    reason: status.summary,
    publicAvailable: status.publicAvailable,
    journalTrustworthy: status.journalTrustworthy,
    runtimeStatus: !status.journalTrustworthy ? 'journalUntrusted' : seam.active() ? 'starting' : 'disabled',
    activeTabId: null,
    tabs: [],
    tabCount: 0,
    recovery: null,
    extensionPaired: status.extensionPaired,
    extensionLive: status.extensionLive,
    summary: status.summary,
    sessions: [],
    phase51: seam.projection().sessions,
    described: 0,
    staleRefs: 0,
    mediaObserved: 0,
    refusals: 0,
  }
}

function browserUnavailable(command: BrowserResult['command'], reason: string): BrowserResult {
  return {
    ok: false,
    command,
    target: null,
    code: 'subsystem-disabled',
    reason,
    escalation: null,
  }
}

// Dev-only seam for a SECOND isolated Freya instance (acceptance test, parallel
// dev run, or the dev:kilo launcher spinning up an alternate profile).
//
// Honoured only when ALL THREE hold:
//   1. FREYA_DEV_USER_DATA is set to an absolute or launcher-relative path.
//   2. The launch was explicitly dev-tagged (process.argv includes --dev), which
//      dev:desktop, electron:dev and dev:kilo all pass. Packaged production and
//      `npm start` do not pass --dev, so this block is a no-op for them.
//   3. The env var is non-empty.
//
// Applied BEFORE any app.getPath('userData') read and BEFORE
// app.requestSingleInstanceLock(), so single-instance scoping, workspace,
// provider config, journal, diagnostics, vault, keyring, capabilities and voice
// settings all land in the chosen directory. The path is resolved to an absolute
// form so a relative value (e.g. '.kilo/acceptance-profile') resolves against
// the repo root the launcher was started from, not against whatever cwd Electron
// inherits.
//
// The .env file is NEVER consulted for FREYA_DEV_USER_DATA. The launcher passes
// it through `env:` in the spawn options, and .env remains the single source of
// truth for provider credentials.
const devUserData = process.env.FREYA_DEV_USER_DATA
if (
  process.argv.includes('--dev') &&
  typeof devUserData === 'string' &&
  devUserData.length > 0
) {
  const absoluteDevUserData = resolve(devUserData)
  app.setPath('userData', absoluteDevUserData)
}

// The E2E harness sometimes opens two throwaway processes against the same
// temporary profile to prove session cleanup. Production never does: both explicit
// E2E gates are required before the profile lock may be bypassed.
//
// The dev:kilo acceptance-profile launcher has its OWN, non-E2E bypass so the
// 9223 test instance can run alongside the 9222 primary without inheriting any
// E2E test keys, fixture providers, fake research or E2E behaviour. It is gated
// by --dev (never present in packaged launches) AND FREYA_DEV_ALLOW_MULTI_INSTANCE,
// and only skips the single-instance lock — nothing else.
const e2eAllowsParallelInstances =
  process.env.FREYA_E2E === '1' && process.env.FREYA_E2E_ALLOW_MULTI_INSTANCE === '1'
const devAllowsParallelInstances =
  process.argv.includes('--dev') && process.env.FREYA_DEV_ALLOW_MULTI_INSTANCE === '1'
const allowsParallelInstances = e2eAllowsParallelInstances || devAllowsParallelInstances
const ownsProfile = allowsParallelInstances || installSingleInstanceGuard(
  {
    requestLock: () => app.requestSingleInstanceLock(),
    quit: () => app.quit(),
    onSecondInstance: (handler) => { app.on('second-instance', handler) },
  },
  () => mainWindow,
  () => {
    // A second launch during early boot simply yields to the primary process; its
    // normal startup will create the first window. Once Core exists, a missing
    // window is safe to recreate without constructing another Core or touching a
    // second copy of the durable stores.
    if (!app.isReady() || quitting || workspace === null || coreHost === null) return
    mainWindow = createWindow()
    startPresenceFor(mainWindow)
  },
)

/** Long enough for a round trip, short enough that a wedged renderer still quits. */
const COLLECT_TIMEOUT_MS = 750

/**
 * A deterministic key seam for the real Electron E2E process.
 *
 * The CI runner intentionally has no desktop keyring. Production must therefore
 * fall back to ephemeral storage there, which is the correct security behaviour but
 * makes a restart-persistence E2E impossible to exercise. The test harness may
 * inject non-secret 32-byte keys only when both explicit E2E variables are present,
 * and only as a *pair* — one domain persistent and the other ephemeral would fail
 * in a way that reads as a Brain bug. Normal application launches never read this.
 */
function e2eKey(variable: string): Uint8Array | null {
  if (process.env.FREYA_E2E !== '1') return null
  const encoded = process.env[variable]
  if (!encoded) return null
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.length !== 32) throw new Error(`${variable} must decode to 32 bytes`)
  return new Uint8Array(bytes)
}

/**
 * Both test keys, or neither.
 *
 * One without the other would produce a restart-persistence E2E where the
 * conversation survives and the Brain does not — or the reverse — and the failure
 * would look like a Brain bug rather than a harness that only half injected.
 */
function e2eKeys(): {
  conversation: Uint8Array
  brain: Uint8Array
  mission: Uint8Array
  context: Uint8Array
  personality: Uint8Array
  skill: Uint8Array
  forge: Uint8Array
  vault: Uint8Array
} | null {
  const conversation = e2eKey('FREYA_E2E_CONVERSATION_KEY')
  const brain = e2eKey('FREYA_E2E_BRAIN_KEY')
  const mission = e2eKey('FREYA_E2E_MISSION_KEY')
  const context = e2eKey('FREYA_E2E_CONTEXT_KEY')
  const skill = e2eKey('FREYA_E2E_SKILL_KEY')
  const forge = e2eKey('FREYA_E2E_FORGE_KEY')
  const personality = e2eKey('FREYA_E2E_PERSONALITY_KEY')
  const vault = e2eKey('FREYA_E2E_VAULT_KEY')
  // All seven or none, so a partial fixture cannot quietly run with a real keyring for
  // the domain it forgot.
  if (
    conversation === null ||
    brain === null ||
    mission === null ||
    context === null ||
    personality === null ||
    skill === null ||
    forge === null ||
    vault === null
  ) {
    return null
  }
  return { conversation, brain, mission, context, personality, skill, forge, vault }
}

/**
 * The offline research fixture provider, if both E2E gates are present.
 *
 * Exists so the Phase 5 end-to-end suite can exercise real research - real Guard,
 * real grants, real gateway, real sandboxed browser - without a live model. It is
 * injected as the **entire** provider set, exactly like the developer providers, so
 * a run cannot quietly reach a real one as well.
 *
 * It returns fixed structured JSON. It is not intelligence, it says so in its own
 * status text, and it is unreachable unless `FREYA_E2E=1` and
 * `FREYA_E2E_RESEARCH=fixtures` were both deliberately supplied to the process.
 *
 * The answers are deliberately keyed to the fixture pages, so an assertion can name
 * the exact text it expects rather than pattern-matching a model's prose.
 */
function e2eResearchFixtureProvider(env: Record<string, string | undefined>): ModelProvider | null {
  if (!(env.FREYA_E2E === '1' && env.FREYA_E2E_RESEARCH === 'fixtures')) return null
  const plans = [
    JSON.stringify({ queries: ['encrypted storage'], evidence: ['durability'], done: false }),
    JSON.stringify({ queries: ['retention disagreement'], evidence: ['conflict'], done: false }),
  ]
  let turn = 0
  return {
    id: 'fixture-research',
    kind: 'fake',
    live: false,
    status: () => ({
      id: 'fixture-research',
      kind: 'fake' as const,
      status: 'configured' as const,
      model: 'fixture-research-1',
      detail:
        'Offline E2E fixture. Returns fixed structured JSON for research planning and synthesis. Not intelligence.',
      liveEnabled: false,
    }),
    complete: async (request) => {
      // Planning turns get a fixed plan; synthesis cites the ids the coordinator
      // actually supplied, read out of the evidence it was given.
      //
      // That is deliberate rather than a shortcut. Citing invented ids would be
      // rejected by `parseSynthesis` - which is the citation-integrity property
      // working - and would leave the E2E asserting nothing. Reading them from the
      // prompt is what a real model does, and it keeps the assertion meaningful.
      const stage = request.messages.some((m) => m.role === 'system' && m.content.includes('Stage: synthesizing'))
      const sourceIds = [...request.prompt.matchAll(/"sourceId":"([^"]+)"/g)]
        .map((match) => match[1] as string)
        .filter((id, index, all) => all.indexOf(id) === index)
      const text = stage
        ? JSON.stringify({
            findings: [
              { text: 'FINDING_MARKER a local assistant keeps durable state encrypted.', sourceIds: sourceIds.slice(0, 1) },
            ],
            conflicts: [
              { text: 'CONFLICT_MARKER the sources disagree about retention.', sourceIds: sourceIds.slice(0, 2) },
            ],
            uncertainties: ['UNCERTAINTY_MARKER neither fixture source is verified.'],
          })
        : (plans[Math.min(turn, plans.length - 1)] as string)
      turn += 1
      return {
        requestId: `fixture-${turn}`,
        providerId: 'fixture-research',
        model: 'fixture-research-1',
        text,
        inputTokens: 1,
        outputTokens: 1,
      }
    },
  }
}

/**
 * The developer echo provider, if one was explicitly asked for.
 *
 * Read from the environment by name and validated against a closed set, so a
 * typo produces "no developer provider" rather than something unexpected being
 * constructed. Undefined means none, and none is the default.
 */
function developerProvider(): 'echo' | 'slow-echo' | undefined {
  const raw = process.env.FREYA_DEV_PROVIDER
  return raw === 'echo' || raw === 'slow-echo' ? raw : undefined
}

function requireWorkspace(): WorkspaceFile {
  if (!workspace) throw new Error('workspace file used before the app was ready')
  return workspace
}

function requireCore(): ElectronCoreHost {
  if (!coreHost) throw new Error('core used before the app was ready')
  return coreHost
}

function requireProviderConfig(): ProviderConfigStore {
  if (!providerStore) throw new Error('provider config used before the app was ready')
  return providerStore
}

function requireVoiceConfig(): VoiceConfigStore {
  if (!voiceConfig) throw new Error('voice config used before the app was ready')
  return voiceConfig
}

/**
 * The host environment, rebuilt from the current process environment.
 *
 * This is the same named set of values main hands to `new ElectronCoreHost` at
 * startup, and it is the only shape that may be given to `restartWithEnv`. It
 * reads `process.env` at call time, so the provider store must have been applied
 * first. Nothing here is returned to a renderer: these are main-process values,
 * and the credential among them never crosses the bridge.
 */
function currentHostEnv(): HostEnv {
  return {
    MINIMAX_API_KEY: process.env.MINIMAX_API_KEY,
    MINIMAX_BASE_URL: process.env.MINIMAX_BASE_URL,
    MINIMAX_MODEL: process.env.MINIMAX_MODEL,
    LOCAL_MODEL_BASE_URL: process.env.LOCAL_MODEL_BASE_URL,
    LOCAL_MODEL_MODEL: process.env.LOCAL_MODEL_MODEL,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    OPENAI_MODEL: process.env.OPENAI_MODEL,
    FREYA_VISION_PROVIDERS: process.env.FREYA_VISION_PROVIDERS,
    NANOGPT_API_KEY: process.env.NANOGPT_API_KEY,
    NANOGPT_BASE_URL: process.env.NANOGPT_BASE_URL,
    NANOGPT_MODEL: process.env.NANOGPT_MODEL,
    FREYA_ALLOW_LIVE_MODEL: process.env.FREYA_ALLOW_LIVE_MODEL,
    BRAVE_SEARCH_API_KEY: process.env.BRAVE_SEARCH_API_KEY,
    FREYA_ALLOW_WEB_SEARCH: process.env.FREYA_ALLOW_WEB_SEARCH,
    // The preferred backend. It has to be named here as well as on `HostEnv`, or the
    // provider that is asked first can never be given a URL to ask.
    FREYA_SEARXNG_URL: process.env.FREYA_SEARXNG_URL,
    FREYA_E2E: process.env.FREYA_E2E,
    FREYA_E2E_RESEARCH: process.env.FREYA_E2E_RESEARCH,
  }
}

/**
 * Re-read the provider environment into Core after a settings save.
 *
 * A provider credential and model are read by Core at construction, so a saved
 * setting only takes effect if the running Core is rebuilt. The stored config is
 * overlaid onto `process.env` first (the same call the write handler already
 * makes), then the host env is rebuilt and Core is restarted from it. This is
 * main-process only: no renderer can name the env or ask for a rebuild, and the
 * key never leaves this process.
 */
/**
 * Re-read the provider environment into Core after a settings save.
 *
 * A provider credential and model are read by Core at construction, so a saved
 * setting only takes effect if the running Core is rebuilt. The stored config is
 * overlaid onto `process.env` first (the same call the write handler already
 * makes), then the host env is rebuilt and Core is restarted from it. This is
 * main-process only: no renderer can name the env or ask for a rebuild, and the
 * key never leaves this process.
 *
 * `EXPLICIT_ENV` is passed here for the same reason it is passed at startup, and
 * its absence was a real precedence inversion: startup ran
 * `applyToEnv(process.env, EXPLICIT_ENV)` so a launch-provided value won, while
 * this path ran `applyToEnv(process.env)` with no explicit snapshot, so the stored
 * file was laid over the top of the launch environment. The first settings save
 * would therefore silently replace a key the operator set deliberately in their
 * shell with whatever `provider.json` happened to contain — a documented ordering
 * that held on the way in and not on the way out. Both paths now use the same
 * precedence: explicit launch environment, then the stored config, then `.env`.
 */
async function reEnvCore(): Promise<void> {
  if (!providerStore) return
  await providerStore.applyToEnv(process.env, EXPLICIT_ENV)
  await coreHost?.restartWithEnv(currentHostEnv())
}

/**
 * A closing window cannot be trusted to have pushed its last layout.
 *
 * An IPC sent during teardown is dropped, so the renderer has to be asked while
 * it is still alive and the answer written synchronously. Both the window's
 * close event and `app.quit()` route through here, because a quit does not
 * necessarily close a window first.
 *
 * The timeout exists so a wedged renderer can never make the app unquittable.
 *
 * ## This is about the workspace, and only the workspace
 *
 * Closing a window is not the application quitting. On macOS a user can close
 * every window and leave the process running, and the `activate` handler will
 * make a new one; the Core those windows talk to must be the same Core, with
 * the same event sequence and the same latched security state.
 *
 * So this function flushes the layout and nothing else. Core is stopped by
 * {@link shutdownCoreAndThen}, which only `app.quit()` reaches.
 */
function collectWorkspaceAndThen(finish: () => void): void {
  const answered = new Promise<void>((resolve) => {
    pendingCollect = resolve
  })
  const timer = setTimeout(() => {
    pendingCollect?.()
    pendingCollect = null
  }, COLLECT_TIMEOUT_MS)

  const target = mainWindow
  if (target && !target.isDestroyed()) {
    target.webContents.send('freya:workspace:collect')
  } else {
    pendingCollect?.()
    pendingCollect = null
  }

  void answered.finally(() => {
    clearTimeout(timer)
    pendingCollect = null
    workspace?.flushSync()
    finish()
  })
}

/**
 * The application is really quitting.
 *
 * Collect the layout, then close Core so its last event is durable, and only
 * then let the process go. A failure to close Core cleanly must not prevent the
 * app from quitting — a user who asked to quit gets to quit.
 */
function shutdownCoreAndThen(finish: () => void): void {
  // Close the control plane first. An external tool that races a quit and
  // arrives while the journal is being torn down would otherwise get a pipe
  // that points at a Core which is no longer answering. Failing closed is the
  // honest failure mode here.
  const handle = controlHandle
  controlHandle = null
  if (handle !== null) {
    void handle.stop().catch((error: unknown) => {
      console.error('[freya] the control plane failed to stop cleanly', error)
    })
  }
  localWhisper.stop()
  localWake.stop()
  if (attentionTimer !== null) {
    clearInterval(attentionTimer)
    attentionTimer = null
  }
  // Phase 51: close every Freya Browser window before the app goes. A window that outlived its
  // runtime would be a page nothing is gating any more.
  const seam = dualBrowser
  dualBrowser = null
  publicBrowserAdapter = null
  if (seam !== null) void seam.dispose().catch(() => undefined)
  presenceHost?.stop()
  presenceHost = null
  // Before Core stops, so the bridge is closed while its authority is still readable
  // and a request in flight is refused by the host rather than by a vanished socket.
  void (browserExtensionHost?.stop() ?? Promise.resolve())
    .catch((error: unknown) => {
      console.error('[freya] the browser extension bridge failed to stop cleanly', error)
    })
  browserExtensionHost = null
  collectWorkspaceAndThen(() => {
    void (coreHost?.stop('app quitting') ?? Promise.resolve())
      .catch((error: unknown) => {
        console.error('[freya] core failed to stop cleanly', error)
      })
      .finally(() => {
        quitting = true
        finish()
      })
  })
}

/* ------------------------------------------------------------------ *
 * Window
 * ------------------------------------------------------------------ */

/**
 * Which physical display number the person asked for, or null to let the
 * platform choose.
 *
 * Display numbers are intentionally human-facing:
 *
 *   1 = primary display
 *   2 = first secondary display
 *   3 = second secondary display
 *
 * Electron does not expose the labels Windows draws in Display Settings, so
 * beyond the primary display we use a stable geometric order. The important
 * case is the ordinary two-monitor desk: `--freya-display=2` always means the one
 * display that is not primary.
 */
function requestedDisplayNumber(): number | null {
  // Chromium owns --display on Linux and interprets it as an X server address.
  // Freya therefore uses a namespaced switch so monitor selection can never
  // override DISPLAY and break Electron before our code even starts.
  const flag = process.argv.find((arg) => arg.startsWith('--freya-display='))
  const raw = flag?.slice('--freya-display='.length) ?? process.env.FREYA_DISPLAY
  if (raw === undefined || raw === '') return null
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 1) return null
  return parsed
}

/**
 * Bounds for the requested display, or null to let the platform choose.
 *
 * `workArea` rather than `bounds`, so a window aimed at another monitor does
 * not start underneath its taskbar.
 */
function boundsForRequestedDisplay(): Electron.Rectangle | null {
  const requested = requestedDisplayNumber()
  if (requested === null) return null

  const primary = screen.getPrimaryDisplay()
  const secondary = screen
    .getAllDisplays()
    .filter((display) => display.id !== primary.id)
    .sort((a, b) => {
      const horizontal = a.bounds.x - b.bounds.x
      return horizontal !== 0 ? horizontal : a.bounds.y - b.bounds.y
    })

  const displays = [primary, ...secondary]
  const display = displays[requested - 1]

  // Out of range — e.g. display 2 on a single-monitor machine — falls back to
  // the platform instead of preventing Freya from launching.
  if (!display) return null

  const area = display.workArea
  const width = Math.min(1680, area.width)
  const height = Math.min(1020, area.height)
  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    width,
    height,
  }
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    ...(boundsForRequestedDisplay() ?? { width: 1680, height: 1020 }),
    minWidth: 1024,
    minHeight: 680,
    show: false,
    // Freya always opens filling its screen.
    fullscreen: true,
    backgroundColor: '#050608',
    titleBarStyle: 'hidden',
    titleBarOverlay: process.platform === 'darwin' ? { color: '#050608', symbolColor: '#b9b2a7' } : undefined,
    trafficLightPosition: process.platform === 'darwin' ? { x: 18, y: 24 } : undefined,
    webPreferences: {
      preload: join(HERE, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  })

  window.once('ready-to-show', () => {
    if (process.argv.includes('--freya-no-focus')) window.showInactive()
    else window.show()
  })

  // Speech output: this window is a candidate speaker. Removing it on close takes
  // every utterance with it, so a window that has gone away cannot leave Core
  // reporting `speaking` for an answer nobody can hear.
  const detachVoiceOutput = voiceOutput.add(window)

  // The host pushes the current status on attach, so a freshly loaded or
  // reloaded renderer knows the Core state without polling for it.
  const detachCore = coreHost?.attach((status) => {
    if (!window.isDestroyed()) window.webContents.send('freya:core:status', status)
  })

  // Activity is a separate push, and separate on purpose. Status is a
  // projection that changes rarely; activity is a stream. Keeping them apart
  // means a busy feed cannot force a status projection to be rebuilt and shipped
  // on every event, and a window that only wants status never pays for the feed.
  const detachActivity = coreHost?.onActivity((activity) => {
    if (!window.isDestroyed()) window.webContents.send('freya:core:activity', activity)
  })

  // The transcript, on its own channel. A conversation projection is a much larger
  // payload than a status and changes on a different schedule, so shipping it with
  // either of the others would make a busy transcript force a status rebuild.
  const detachConversation = coreHost?.onConversation((projection) => {
    if (!window.isDestroyed()) window.webContents.send('freya:core:conversation', projection)
  })

  // The Brain is a fourth channel for the same reason: a memory projection is
  // neither a security status nor a transcript, and folding it into either would
  // mean long-term knowledge travels wherever that channel is cached.
  const detachBrain = coreHost?.onBrain((projection) => {
    if (!window.isDestroyed()) window.webContents.send('freya:core:brain', projection)
  })

  // Work is a fifth channel for the same reason, and here the payload changes on a
  // schedule unlike any of the others: it moves whenever a step, an action or an
  // approval does. Folding it into status would force a status projection to be
  // rebuilt and shipped on every one of those, and a security projection is the
  // wrong home for a record of what is currently executing.
  const detachWork = coreHost?.onWork((projection) => {
    if (!window.isDestroyed()) window.webContents.send('freya:core:work', projection)
  })

  // Missions are a sixth channel for the same reason. A Mission projection moves when
  // a Mission is created, moved or concluded, which is rare enough that it does not
  // need the per-step cadence `freya:core:work` has — and keeping it separate is what
  // stops a Mission's status riding along inside a security projection.
  const detachMission = coreHost?.onMission((projection) => {
    if (!window.isDestroyed()) window.webContents.send('freya:core:mission', projection)
  })

  // The Workforce projection is a seventh channel, and the note that matters is
  // about what does *not* cross: no source, no authority, no rule, no worker
  // credential. A window learns who exists and what Core says each is doing —
  // which is everything a workforce view needs — and nothing that could decide
  // anything.
  const detachWorkforce = coreHost?.onWorkforce((projection) => {
    if (!window.isDestroyed()) window.webContents.send('freya:core:workforce', projection)
  })

  // Context is an eighth channel, and the one whose source may report nothing
  // forever: before a Core starts there is no Context to mirror, so a window
  // attaches to a channel that honestly stays quiet rather than one
  // synthesising items to fill the air. What crosses is exactly what Core
  // reported — metadata only: no content, no resolver, no authority.
  const detachContext = coreHost?.onContext((projection) => {
    if (!window.isDestroyed()) window.webContents.send('freya:core:context', projection)
  })

  // Personality is a ninth channel, and the smallest of them: temperament,
  // relationship *metadata* and one optional cue for Presence to draw. What
  // does not cross is the point of it — no recorded text, no tags, no admission
  // reason, no guidance line, no key and no path — so a window can show what
  // Core knows about the relationship without holding what the relationship
  // says. Nothing here writes: the channel has no counterpart that carries a
  // payload toward Core.
  const detachPersonality = coreHost?.onPersonality((projection) => {
    if (!window.isDestroyed()) window.webContents.send('freya:core:personality', projection)
  })

  // Attention is a tenth channel: counts, the focus reading Core derived, the last
  // decision as metadata and at most one cue. The event's text does not cross —
  // only its measured length — and nothing here decides anything. Core's bounded
  // scheduler is ticked by this process, not by a window, so a renderer cannot
  // drive the clock.
  const detachAttention = coreHost?.onAttention((projection) => {
    if (!window.isDestroyed()) window.webContents.send('freya:core:attention', projection)
  })

  const detachFoundry = coreHost?.onFoundry((projection) => {
    if (!window.isDestroyed()) window.webContents.send('freya:core:foundry', projection)
  })

  // The Office is an eleventh channel, and the one whose whole content is
  // derived: Freya's station, live run stations, worker stations, approval
  // stations and the history timeline. What does not cross is the point of it —
  // no step input, no observation content, no message body, no task title, no
  // mission text, no authority, no capability instance. A window can see what
  // is happening and where; it cannot reach the substance of the work or the
  // agents, and it cannot invent either.
  const detachOffice = coreHost?.onOffice((projection) => {
    if (!window.isDestroyed()) window.webContents.send('freya:core:office', projection)
  })

  const detachRelay = coreHost?.onRelay((projection) => {
    if (!window.isDestroyed()) window.webContents.send('freya:core:relay', projection)
  })

  const detachConnectors = coreHost?.onConnectors((projection) => {
    if (!window.isDestroyed()) window.webContents.send('freya:core:connectors', projection)
  })

  /**
   * Skills: a twelfth channel. Core owns the truth about procedures, their lifecycle
   * and their evidence; this window only displays what Core pushed. There is
   * deliberately no `freya:core:skills:write` channel and no preload method that
   * accepts a skill body, so the bridge cannot become a second admission door.
   */
  /**
   * The unified conscious context: the one lane a future surface can read instead
   * of assembling eleven projections itself.
   *
   * Push-only, like every other Core projection channel here, and for the same
   * reason: the renderer holds what Core last derived and cannot write a field of
   * it. There is deliberately no `freya:core:consciousness:write`, `:submit` or
   * `:refresh` channel and no preload method that accepts a correction - a window
   * that could ask Core to rebuild a snapshot on demand is a window that could ask
   * Core to rebuild one at the wrong moment.
   */
  const detachConsciousness = coreHost?.onConsciousness((projection) => {
    if (!window.isDestroyed()) window.webContents.send('freya:core:consciousness', projection)
  })

  const detachSkills = coreHost?.onSkills((projection) => {
    if (!window.isDestroyed()) window.webContents.send('freya:core:skills', projection)
  })

  /**
   * Forge: the same shape as Skills, one channel later.
   *
   * Push-only. There is deliberately no  reya:core:forge:write, no
   * :generate, :install or :enable channel, and no preload method that accepts a
   * package body: a renderer that could push a manifest into Electron would make the
   * bridge a second admission door, and the whole of Phase 48 is that there is one door
   * and it is Core's. Mutating work goes through  reya:core:submit with a
   *  orge.* command, which Core Guard-evaluates and journals.
   */
  const detachForge = coreHost?.onForge((projection) => {
    if (!window.isDestroyed()) window.webContents.send('freya:core:forge', projection)
  })

  /**
   * World & self: a thirteenth channel, and the narrowest one in this file.
   *
   * Only the *summary* is pushed, and the only command-free read is the summary too.
   * The graph, the entity list, the inspector and the self status are all reached
   * through `freya:core:submit` with a read command, which Core Guard-evaluates.
   *
   * There is deliberately no `freya:core:world:write` channel and no preload method
   * that accepts a claim. The two owner-facing world commands exist in Core, are
   * owner-only through Guard, and are absent from the preload command allowlist — so
   * a renderer cannot create an entity, a relation, a trust level or a confidence
   * even if it can reach this bridge.
   */
  const detachWorld = coreHost?.onWorld((projection) => {
    if (!window.isDestroyed()) window.webContents.send('freya:core:world', projection)
  })

  /**
   * The Continuous Life Loop: a read channel and nothing else.
   *
   * There is deliberately no `freya:core:lifeloop:write`, no `:tick` and no
   * `:wake`. A window that could wake the loop could make Freya think, and a window
   * that could tick it could drive the clock — and the one thing Phase 23 is built
   * to guarantee is that neither is reachable from a surface. The heartbeat the loop
   * rides is the attention timer below, which exists in the main process and is not
   * a channel.
   */
  const detachLifeLoop = coreHost?.onLifeLoop((projection) => {
    if (!window.isDestroyed()) window.webContents.send('freya:core:lifeloop', projection)
  })

  /**
   * Life History: Freya's own autobiographical record.
   *
   * Push-only, like every other Core projection here. An entry carries a kind, a
   * salience, a derivation and a bounded summary — not a narrative, and not a place
   * a window can write one. There is deliberately no `freya:core:life:write` channel
   * and no preload method that accepts an entry body: the only way a Life entry
   * exists is Core's own `admitLifeEntry`, which caps confidence, refuses
   * secret-shaped text and refuses a derived entry with no evidence. A bridge door
   * would be a second admission path around all three of those checks.
   */
  const detachLife = coreHost?.onLife((projection) => {
    if (!window.isDestroyed()) window.webContents.send('freya:core:life', projection)
  })

  // Voice, on two channels, and the split is the design.
  //
  // The *projection* is state: where the machine is, whether the microphone is on,
  // what the last capture produced. It moves on a schedule nothing else does — a
  // permission prompt resolving, an engine finishing, STOP ALL landing — so it gets
  // its own channel rather than riding along inside `freya:core:status`, where it
  // would be copied and cached wherever a security projection is kept.
  //
  // The *transcript fragments* are words in flight, and they get a second channel
  // for two reasons. A window that wants an animated interim line needs every
  // fragment; a window that only cares about the final transcript should not be
  // handed a stream of guesses to filter. And the two have opposite trust: a
  // fragment marked `interim` is a guess the engine is still revising, and there
  // is no command anywhere that would submit one.
  const detachVoice = coreHost?.onVoice((projection) => {
    microphoneGate.update(projection)
    if (!projection?.micEnabled || projection.state === 'stopped-by-STOP-ALL' || !projection.wake.armed) { localWake.stop(); microphoneGate.standbyReady = false }
    if (!projection?.micEnabled || projection.state === 'stopped-by-STOP-ALL' || (!projection.attention?.active && !projection.capturing && projection.state !== 'transcribing' && projection.state !== 'submitting')) localWhisper.stop()

    if (!window.isDestroyed()) window.webContents.send('freya:core:voice', projection)
  })
  const detachVoiceTranscript = coreHost?.onVoiceTranscript((fragment) => {
    if (!window.isDestroyed()) window.webContents.send('freya:core:voice:transcript', fragment)
  })

  window.on('closed', () => {
    detachCore?.()
    detachActivity?.()
    detachConversation?.()
    detachVoice?.()
    detachVoiceTranscript?.()
    detachVoiceOutput()
    detachBrain?.()
    detachWork?.()
    detachMission?.()
    detachWorkforce?.()
    detachContext?.()
    detachPersonality?.()
    detachAttention?.()
    detachFoundry?.()
    detachOffice?.()
    detachRelay?.()
    detachConnectors?.()
    detachSkills?.()
    detachForge?.()
    detachWorld?.()
    detachConsciousness?.()
    detachLifeLoop?.()
    detachLife?.()
  })

  if (DEV_SERVER) {
    void window.loadURL(DEV_SERVER)
  } else {
    void window.loadFile(join(ROOT, 'dist', 'index.html'))
  }

  // Nothing in Freya should navigate away or spawn a window. Anything the
  // user clicks that wants to leave the app goes to the real browser.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    const current = window.webContents.getURL()
    if (url !== current) {
      event.preventDefault()
      if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    }
  })

  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })

  /**
   * The user closed the window. Hold it open just long enough to collect the
   * layout, then let it go.
   */
  window.on('close', (event) => {
    if (quitting || !workspace) return
    event.preventDefault()
    // A window closing is not the app quitting. Core keeps running, and a new
    // window will attach to this same instance.
    collectWorkspaceAndThen(() => window.destroy())
  })

  return window
}

/** Start a Presence companion for this dashboard window and prime it from Core. */
function startPresenceFor(window: BrowserWindow): void {
  window.once('ready-to-show', () => {
    if (window.isDestroyed()) return
    presenceHost?.stop()
    const next = new PresenceHost({
      displayNumber: requestedDisplayNumber(),
      dev: Boolean(DEV_SERVER),
    })
    presenceHost = next
    next.start(window)

    const host = coreHost
    if (host !== null) {
      next.updateCore(host.status())
      next.updateAttention(host.attention())
      next.updateWork(host.work())
      next.updatePersonality(host.personality())
      next.updateVoice(host.voice())
    }
  })
}

/* ------------------------------------------------------------------ *
 * IPC — a deliberately small, named surface
 * ------------------------------------------------------------------ */

function registerIpc(): void {
  // Speech capability reporting. The only message a window may send about voice
  // that is not a Core command, and it carries no words and no authority — just
  // what the platform's speech engine turned out to be.
  registerVoiceOutputIpc(voiceOutput)
  ipcMain.handle('freya:voice:wake:status', () => ({ ready: localWake.ready, frames: localWake.frames, detections: localWake.detections, peak: localWake.peak }))
  ipcMain.on('freya:voice:wake:pcm', (event, audio: unknown) => {
    const p = coreHost?.voice()
    if (event.sender === mainWindow?.webContents && p?.wake.armed && p.micEnabled && p.permission === 'granted' && p.state !== 'stopped-by-STOP-ALL' && !p.attention?.active) localWake.push(audio)
  })

  ipcMain.handle('freya:runtime', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    platform: process.platform,
    arch: process.arch,
    userData: app.getPath('userData'),
    workspaceFile: requireWorkspace().path,
    dev: Boolean(DEV_SERVER),
  }))

  // Provider settings. The read returns only the masked view — base URL, model,
  // the live flag and whether a key exists. The write accepts the four named
  // fields, stores the key in the OS wrapper and then re-reads the environment
  // into Core. The raw key never appears in either direction: it goes into the
  // store and into `process.env`, and nowhere else.
  ipcMain.handle('freya:provider:read', () => requireProviderConfig().read())
  const capabilityRegistry = () => readRuntimeCapabilityRegistry(currentHostEnv(), capabilityPreferences, { ...(coreHost?.capabilityReadiness() ?? {}), ...voiceReadiness() })
  ipcMain.handle('freya:capabilities:read', (event) => {
    if (event.sender !== mainWindow?.webContents) throw new Error('Capability settings are only available in the main window.')
    return capabilityRegistry()
  })
  ipcMain.handle('freya:capabilities:write', async (event, input: unknown) => {
    if (event.sender !== mainWindow?.webContents || !capabilityStore) throw new Error('Capability settings are unavailable.')
    capabilityPreferences = await capabilityStore.write(input)
    // Refresh the Chat default immediately; the running Core reads the same preference closure.
    if (coreHost && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('freya:core:status', coreHost.status())
    return capabilityRegistry()
  })
  ipcMain.handle('freya:voice:settings:read', () => ({ ...voicePreferences() }))
  ipcMain.handle('freya:voice:settings:write', async (_event, input: unknown) => {
    if (!voiceConfig) throw new Error('Voice settings are not ready.')
    await requireCore().submit({ command: 'voice.mic.disable', requestId: 'voice-settings-change' })
    await voiceOutput.cancel()
    const saved = await voiceConfig.write(input)
    if (capabilityStore) capabilityPreferences = await capabilityStore.write({ ...capabilityPreferences, stt: [saved.inputProvider === 'local-whisper' ? 'local' : 'nanogpt'], tts: [saved.outputProvider === 'platform' ? 'native' : 'nanogpt'] })
    localWhisper.stop()
    localWake.stop()
    return saved
  })
  ipcMain.handle('freya:provider:write', async (_event, input: ProviderConfigInput) => {
    const saved = await requireProviderConfig().write(input)
    try {
      await reEnvCore()
    } catch (error) {
      /**
       * The write has already been persisted, so this is not a failed save and must
       * not be reported as one.
       *
       * What failed is the live rebuild. Reporting it as a failed write would tell
       * somebody their key was not stored when it was, and the natural response —
       * entering it again — would be the wrong one. The message therefore states
       * both halves: the setting is saved, and it takes effect on the next launch.
       */
      const detail = error instanceof Error ? error.message : 'the reason was not reported'
      throw new Error(
        `The provider settings were saved, but Freya could not restart with them: ${detail}. They will take effect the next time Freya starts.`,
        { cause: error },
      )
    }
    return saved
  })

  ipcMain.handle('freya:voice-config:read', () => requireVoiceConfig().readLegacy())
  ipcMain.handle('freya:voice-config:write', async (_event, input: VoiceConfigPatch) => {
    const saved = await requireVoiceConfig().writeLegacy(input)

    const host = coreHost
    if (host !== null) {
      await host.submit({
        command: 'voice.auto-speak.set',
        requestId: `voice-config-auto-speak-${Date.now()}`,
        payload: { enabled: saved.autoSpeak },
      })
      await host.submit({
        command: 'voice.proactive-alerts.set',
        requestId: `voice-config-proactive-${Date.now()}`,
        payload: { enabled: saved.proactiveAlerts },
      })
      await host.submit({
        command: 'voice.mute.set',
        requestId: `voice-config-tts-${Date.now()}`,
        payload: { muted: saved.ttsProvider === 'off' },
      })
      if (saved.ttsVoiceId !== null) {
        await host.submit({
          command: 'voice.tts.voice.select',
          requestId: `voice-config-voice-${Date.now()}`,
          payload: { voiceId: saved.ttsVoiceId },
        })
      }
      if (saved.wakeProvider === 'off') {
        await host.submit({
          command: 'voice.wake.disarm',
          requestId: `voice-config-wake-${Date.now()}`,
        })
      }
    }
    return saved
  })

  ipcMain.handle('freya:workspace:load', () => requireWorkspace().load())
  // The whole privileged act of "attach a file": a dialog in this process, a
  // bounded read behind it, and a typed outcome in front of it.
  //
  // The window is resolved from the *asking* webContents, so a renderer can only
  // ever open a dialog parented to itself. There is deliberately no companion
  // channel that accepts a path from the renderer — that would be an arbitrary
  // filesystem read dressed as an attachment.
  // A picture a card draws. The window asked; the main process fetched; the bytes came
  // back as a data: URL. `null` means the window sent something that is not an ordinary
  // web address, which is a refusal rather than an error worth a dialog.
  ipcMain.handle('freya:media:thumbnail', async (_event, url: unknown) => {
    if (typeof url !== 'string') {
      return { ok: false, dataUrl: null, bytes: 0, format: null, claimedType: null, reason: 'that is not an address' }
    }
    return fetchThumbnail(url)
  })

  ipcMain.handle('freya:media:document', async (_event, url: unknown) => {
    if (typeof url !== 'string') return { ok: false, reason: 'that is not an address' }
    return fetchDocumentBytes(url)
  })

  ipcMain.handle('freya:media:video', async (_event, url: unknown) => {
    if (typeof url !== 'string') {
      return { ok: false, dataUrl: null, bytes: 0, format: null, claimedType: null, reason: 'that is not an address' }
    }
    return fetchVideoPreview(url)
  })

  // The hosted player overlay: the renderer names the address it wants played and
  // the modal box to draw it in; this process re-checks the player allowlist, owns
  // the view and detaches it when the preview closes or switches. The window is
  // resolved from the asking webContents, so a preview can only ever attach to its
  // own window.
  ipcMain.handle('freya:media:embed-attach', async (event, request: unknown) => {
    const owner = BrowserWindow.fromWebContents(event.sender)
    if (owner === null || owner.isDestroyed()) return { ok: false, reason: 'no window is attached to this preview' }
    const payload = (request ?? {}) as Record<string, unknown>
    return attachEmbedView(owner, { WebContentsView }, {
      url: payload['url'],
      x: payload['x'],
      y: payload['y'],
      width: payload['width'],
      height: payload['height'],
    })
  })

  ipcMain.handle('freya:media:embed-detach', async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender)
    if (owner === null || owner.isDestroyed()) return { ok: false }
    return { ok: detachEmbedView(owner) }
  })

  ipcMain.handle('freya:attachment:pick', async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender)
    if (owner === null) {
      return { ok: false, reason: 'The file picker needs a window, and there was none.' }
    }
    const { dialog } = await import('electron')
    return pickAttachments({
      showOpenDialog: (request) => dialog.showOpenDialog(owner, {
        title: request.title,
        // Copied into the mutable arrays Electron's types declare. The request is
        // `readonly` so the picker contract cannot be mutated by a caller; the
        // dialog needs its own arrays, and this is the boundary where that
        // immutability is spent.
        properties: [...request.properties],
        filters: request.filters.map((filter) => ({
          name: filter.name,
          extensions: [...filter.extensions],
        })),
      }),
    })
  })
  // The window is frameless, so the renderer drives these. Each acts on the
  // window that asked, never another: a window can name no other window.
  ipcMain.handle('freya:window:minimize', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize()
  })
  ipcMain.handle('freya:window:maximize', (event) => {
    const target = BrowserWindow.fromWebContents(event.sender)
    if (!target) return
    if (target.isFullScreen()) target.setFullScreen(false)
    else if (target.isMaximized()) target.unmaximize()
    else target.maximize()
  })
  ipcMain.handle('freya:window:close', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close()
  })
  ipcMain.handle('freya:core:submit', async (_event, envelope: CoreCommandEnvelope) => {
    if (envelope.command === 'voice.wake.arm') {
      const p = requireCore().voice()
      if (_event.sender !== mainWindow?.webContents || !p?.micEnabled || p.permission !== 'granted' || requireCore().status().stopAll.active) return { requestId: envelope.requestId, ok: false, reason: 'Turn on the microphone first.' }
      if (!await localWake.start()) return { requestId: envelope.requestId, ok: false, reason: 'Local wake detector could not start.' }
      microphoneGate.standbyReady = true
      localWake.reset()
    }
    if (envelope.command === 'voice.capture.start' && voicePreferences().inputProvider === 'local-whisper' && requireCore().status()?.stopAll.active !== true) {
      const p = requireCore().voice()
      if (_event.sender !== mainWindow?.webContents || !p?.micEnabled || p.permission !== 'granted') return { requestId: envelope.requestId, ok: false, reason: 'Microphone permission is required.' }
      if (!await localWhisper.start()) return { requestId: envelope.requestId, ok: false, reason: 'Local speech recognition could not start.' }
      if (requireCore().voice()?.wake.armed) localWake.reset()
    }
    const result = requireCore().submit(envelope)
    // Surface a small set of turn events on the control plane so external
    // tools (opencode, the CLI, an MCP host) can wait without polling. The
    // publisher is a no-op when no control server is running, so this is free
    // in environments that have not opted into the control plane.
    void result.then((settled) => {
      if (!settled.ok) return
      const handle = controlHandle
      if (handle === null) return
      if (envelope.command === 'conversation.turn.submit') {
        const payload = envelope.payload as { conversationId?: unknown } | undefined
        if (typeof payload?.conversationId === 'string') {
          handle.publish({
            jsonrpc: '2.0',
            method: 'event',
            params: { topic: 'conversation.response', payload: { conversationId: payload.conversationId, ok: true }, at: new Date().toISOString() },
          })
        }
      } else if (envelope.command === 'conversation.create') {
        const outcome = settled as unknown as { conversation?: { conversationId?: string } }
        const id = outcome?.conversation?.conversationId
        if (typeof id === 'string') {
          handle.publish({
            jsonrpc: '2.0',
            method: 'event',
            params: { topic: 'conversation.created', payload: { conversationId: id }, at: new Date().toISOString() },
          })
        }
      }
    })
    // The microphone gate follows Core's verdict rather than the request, so a
    // refused capture never opens the gate, and a refusal cannot leave the gate
    // latched open for whatever asks next.
    void result.then((settled) => {
      trackVoiceCapture(envelope, settled)
      // And a settlement releases the utterance Core was waiting on. Core is what
      // decides what the report means; this only stops the promise from hanging,
      // which is what keeps `voice.speaking` true only while something is audible.
      if (envelope.command === 'voice.tts.settle') {
        const utteranceId = (envelope.payload as { utteranceId?: unknown } | undefined)?.utteranceId
        const outcome = (envelope.payload as { outcome?: unknown } | undefined)?.outcome
        if (typeof utteranceId === 'string' && settled.ok) {
          voiceOutput.settle(utteranceId, outcome === 'completed')
        }
      }
    })
    return result
  })
  ipcMain.handle('freya:core:status', () => requireCore().status())
  ipcMain.handle('freya:core:activity', () => requireCore().activity())
  ipcMain.handle('freya:core:conversation', () => requireCore().conversation())

  // Phase 51 stays the browser authority boundary. The window can read this
  // display projection and submit one closed-vocabulary request; it cannot reach
  // the BrowserWindow, adapter, extension session, journal or Device Hands runtime.
  ipcMain.handle('freya:browser:state', () => browserBridgeState())
  ipcMain.handle('freya:browser:dock', (event, input: unknown) => {
    if (event.sender !== mainWindow?.webContents) return false
    const window = mainWindow
    if (window === null || window.isDestroyed()) return false
    // Bounds are re-derived from the window's own content rect on every message rather than
    // trusted from the renderer. A renderer that asks for a rect outside the window gets a
    // rect clamped into it, which is what stops a compromised page from parking a native view
    // over the rest of the application chrome.
    const dock = normaliseBrowserDockRequest(input, window.getContentBounds())
    if (!dock) return false
    if (browserService !== null) {
      const bounds = clampSurfaceBounds(dock.bounds, window.getContentBounds())
      // A zero-area rect is the honest way to say "hidden": a native view given one is neither
      // painted nor hit-testable, which a `visible: false` toggle is not on every Electron
      // version. A surface with no native view answers false and the workspace shows its own
      // chrome instead.
      return browserService.dock(dock.sessionId, dock.sessionId === null ? null : bounds)
    }
    return dockedBrowserFactory?.dock(dock.sessionId, dock.bounds) ?? false
  })
  ipcMain.handle('freya:browser:command', async (event, input: unknown) => {
    if (event.sender !== mainWindow?.webContents) {
      throw new Error('Browser commands are restricted to the main window.')
    }
    const service = browserService
    if (service === null) {
      return {
        ok: false,
        op: 'tabs',
        code: 'subsystem-disabled',
        reason: 'The Freya Browser is not available in this build, so no tab was opened or changed.',
        data: {},
      }
    }
    const bounded = normaliseSemanticBrowserRequest(input)
    if (!bounded.ok) {
      return { ok: false, op: 'tabs', code: 'request-malformed', reason: bounded.reason, data: {} }
    }
    return await service.run(bounded.request)
  })
  ipcMain.handle('freya:browser:execute', async (event, input: unknown) => {
    if (event.sender !== mainWindow?.webContents) throw new Error('Browser requests are restricted to the main window.')
    const bounded = normaliseRendererBrowserRequest(input)
    if (!bounded.ok) throw new Error(bounded.reason)
    const seam = dualBrowser
    if (seam === null) {
      return browserUnavailable(
        bounded.request.command,
        'The dual-browser runtime is not enabled, so no page was opened or changed.',
      )
    }
    return seam.execute(bounded.request, { origin: 'owner' })
  })

  ipcMain.handle('freya:core:voice', () => requireCore().voice())
  ipcMain.handle('freya:core:brain', () => requireCore().brain())
  ipcMain.handle('freya:core:work', () => requireCore().work())
  // Missions, same bargain: the projection crosses, the substance does not. There is
  // deliberately no channel for a Mission's private text — that lives in the encrypted
  // store and reaches a window only through Core's own read, not as a standing feed.
  ipcMain.handle('freya:core:mission', () => requireCore().mission())
  // The Workforce projection, same bargain as every other channel here: what a
  // window needs to render crosses, and there is deliberately no handle to a
  // source, a rule or a worker behind it. A read, from a window, of a
  // projection Core built.
  ipcMain.handle('freya:core:workforce', () => requireCore().workforce())
  // The Context projection, same bargain as every other channel: a read of
  // what Core reported, which answers `null` until a Core has started and
  // reports one. There is deliberately no `freya:core:context:write` and no
  // context command — a window cannot put context *in*, because Context
  // authority is Core's to hold inside itself, not this bridge's to lend.
  ipcMain.handle('freya:core:context', () => requireCore().context())
  // The Personality projection, same bargain, tighter still: a read of what
  // Core reported, `null` until a Core has started, and no handle to a source,
  // a record or a cue behind it. There is deliberately no
  // `freya:core:personality:write` and no `personality.*` command — a window
  // cannot file a preference, record a habit or declare an inside joke, because
  // relationship truth is Core's to hold and this bridge lends none of it.
  ipcMain.handle('freya:core:personality', () => requireCore().personality())
  // The Attention projection, same bargain as every other channel: a read of what
  // Core reports. There is deliberately no `freya:core:attention:write` and no
  // `attention.tick` command — a window cannot decide, spend a budget, bypass a
  // cooldown or drive the scheduler.
  ipcMain.handle('freya:core:attention', () => requireCore().attention())
  ipcMain.handle('freya:core:foundry', () => requireCore().foundry())
  // The Office projection, same bargain as every other channel: a read of what
  // Core reports. The Office is a pure function of real Work/Workforce/Core
  // state, so what crosses is exactly what Core derived — stations, counts,
  // history and pending presence requests. There is deliberately no
  // `freya:core:office:write` and no office command that invents a station,
  // inflates a count or fabricates a percentage. The one Office command that
  // writes, `office.presence.request`, goes through `freya:core:submit` like
  // every other command — it is validated and journalled in Core, not here.
  ipcMain.handle('freya:core:office', () => requireCore().office())
  ipcMain.handle('freya:core:relay', () => requireCore().relay())
  ipcMain.handle('freya:core:connectors', () => requireCore().connectors())
  // The Skills projection is read-only; mutation remains Core-command-only.
  ipcMain.handle('freya:core:skills', () => requireCore().skills())
  // The Forge projection is read-only; every mutation is a Guard-evaluated Core command.
  ipcMain.handle('freya:core:forge', () => requireCore().forge())
  // The World & self summary is read-only, and it is counts only. The graph, the
  // entity list, the inspector and the self status are Core commands, not a channel.
  ipcMain.handle('freya:core:world', () => requireCore().world())
  // The unified conscious context: one `handle`, no `on`. There is deliberately no
  // write channel for this lane - no `consciousness:set`, `:submit`, `:refresh` -
  // because a snapshot a window could ask Core to rebuild is a snapshot a window
  // could ask Core to build wrongly, and there is no command behind it to refuse.
  ipcMain.handle('freya:core:consciousness', () => requireCore().consciousness())
  ipcMain.handle('freya:core:lifeloop', () => requireCore().lifeLoop())
  ipcMain.handle('freya:core:life', () => requireCore().life())

  ipcMain.handle('freya:workspace:save', (_event, payload: unknown) => {
    const accepted = requireWorkspace().schedule(payload)
    if (!accepted) {
      console.warn(
        `[freya] workspace rejected: not serialisable, or larger than ${DEFAULT_MAX_BYTES} bytes`,
      )
    }
    // The renderer has answered the closing-time request, if there was one.
    pendingCollect?.()
    pendingCollect = null
    return accepted
  })
}

// The `freya-browser://` scheme is the only path a window has to fetch a screenshot the
// main process just captured. It must be registered as privileged before `app.ready`,
// because the renderer that asks for the screenshot loads over http and a non-privileged
// custom scheme is rejected by Electron's CORS layer. `standard: true` makes it a same-origin
// scheme; `supportFetchAPI: true` is what `fetch()` needs; `secure: true` keeps CSP
// happy on a renderer that ships one.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'freya-browser',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false, codeCache: false },
  },
])

app.whenReady().then(async () => {
  if (!ownsProfile) return
  workspace = new WorkspaceFile({
    path: join(app.getPath('userData'), WORKSPACE_FILE),
  })
  // Created beside the workspace, and created before Core so the stored provider
  // values can be applied to the process environment Core is then built from.
  providerStore = new ProviderConfigStore(join(app.getPath('userData'), 'provider.json'))
  // A credential saved through the Settings surface must be usable on the next
  // launch, so it is applied here — before Core reads `process.env.NANOGPT_*`.
  // A real launch environment still wins; the `.env` file does not.
  await providerStore.applyToEnv(process.env, EXPLICIT_ENV)
  capabilityStore = new CapabilitySettingsStore(join(app.getPath('userData'), 'capabilities.json'))
  capabilityPreferences = await capabilityStore.read()
  voiceConfig = new VoiceConfigStore(join(app.getPath('userData'), 'voice.json'))
  await voiceConfig.load()
  // The keys are fetched before the Core is constructed, and they are the only
  // secrets this process handles. A machine with no OS secure storage gets `null`
  // for both, which makes Core fall back to ephemeral stores that label themselves —
  // never to a plaintext file and never to a key stored beside the data.
  //
  // Two domains, two independent secrets. On this first run the keyring adopts any
  // Phase 3 conversation key verbatim so existing history stays readable, and
  // mints a separate Brain key.
  //
  // CI has no desktop keyring, so the explicit E2E harness injects a deterministic
  // pair of non-secret test keys. That is not a production fallback and is
  // unreachable unless FREYA_E2E=1 was deliberately supplied to the process.
  const dataPath = join(app.getPath('userData'), CORE_LOG_FILE)
  const testKeys = e2eKeys()
  const keyResult = testKeys
    ? Promise.resolve({
        conversation: { key: testKeys.conversation, reason: null as string | null },
        brain: { key: testKeys.brain, reason: null as string | null },
        mission: { key: testKeys.mission, reason: null as string | null },
        context: { key: testKeys.context, reason: null as string | null },
        personality: { key: testKeys.personality, reason: null as string | null },
        skill: { key: testKeys.skill, reason: null as string | null },
        forge: { key: testKeys.forge, reason: null as string | null },
        vault: { key: testKeys.vault, reason: null as string | null },
      })
    : loadKeyring(dataPath)
  void keyResult.then(async (result) => {
    // Reported per domain, because the two failures are genuinely independent: a
    // machine can open an existing conversation key and be unable to create a Brain
    // one. A single warning would hide which half is missing.
    if (result.conversation.key === null) {
      // A warning, with a reason and no value. The conversation still works for the
      // session; it just will not survive a restart, and the UI says so.
      console.warn(`[freya] conversation history is not being saved — ${result.conversation.reason}`)
    }
    if (result.brain.key === null) {
      // Freya still answers. She just will not remember across a restart, and the
      // surface says exactly that rather than implying a memory that is not there.
      console.warn(`[freya] Freya will not remember across restarts — ${result.brain.reason}`)
    }
    if (result.mission.key === null) {
      // Same shape as the Brain's: Missions still work for this session, and the
      // surface reports `durable: false` rather than implying persistence it lacks.
      console.warn(`[freya] Missions are not being saved — ${result.mission.reason}`)
    }
    if (result.skill.key === null) {
      console.warn(`[freya] Skills are not being saved — ${result.skill.reason}`)
    }
    if (result.vault.key === null) {
      console.warn(`[freya] encrypted Vault is unavailable — ${result.vault.reason}`)
    }
    if (result.personality.key === null) {
      // The one domain whose absence changes behaviour and not only durability.
      // Without a durable store the cue ledger cannot be trusted, so Core refuses
      // anti-repetition memory outright and offers no expression guidance at all —
      // which is correct: an empty ledger would re-offer the same gesture forever.
      console.warn(
        `[freya] what Freya records about you will not survive a restart, and she will not reuse gestures — ${result.personality.reason}`,
      )
    }
    const fixtureProvider = e2eResearchFixtureProvider(process.env)
    const vaultPath = join(app.getPath('userData'), 'vault', 'freya.db')
    const vaultBinding = process.platform === 'win32'
      ? createFreyaVaultBinding(join(ROOT, 'native', 'sqlcipher', 'win32-x64', 'better_sqlite3-electron44.node'))
      : undefined

    // CI runs Electron on Linux, while the repository intentionally ships a
    // SQLCipher native binding only for the supported Windows desktop build. Keep
    // the Vault configuration present so every other domain reports the same
    // honest platform posture it has in production. For conversation bodies only,
    // the explicit E2E harness injects Core's existing encrypted compatibility
    // store so the process-relaunch test can exercise real encrypted persistence
    // rather than ephemeral memory. Production Windows never takes this branch.
    const e2eEncryptedConversationCompatibility =
      process.env.FREYA_E2E === '1' && vaultBinding === undefined
    const e2eConversationStore =
      e2eEncryptedConversationCompatibility && result.conversation.key !== null
        ? await EncryptedConversationStore.open({
            path: `${dataPath}.conversations`,
            key: result.conversation.key,
          })
        : undefined

    const deviceHandsSeam = buildDeviceHandsSeam()
    coreHost = new ElectronCoreHost(
      dataPath,
      {
        MINIMAX_API_KEY: process.env.MINIMAX_API_KEY,
    MINIMAX_BASE_URL: process.env.MINIMAX_BASE_URL,
    MINIMAX_MODEL: process.env.MINIMAX_MODEL,
    LOCAL_MODEL_BASE_URL: process.env.LOCAL_MODEL_BASE_URL,
    LOCAL_MODEL_MODEL: process.env.LOCAL_MODEL_MODEL,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    OPENAI_MODEL: process.env.OPENAI_MODEL,
    FREYA_VISION_PROVIDERS: process.env.FREYA_VISION_PROVIDERS,
    NANOGPT_API_KEY: process.env.NANOGPT_API_KEY,
        NANOGPT_BASE_URL: process.env.NANOGPT_BASE_URL,
        NANOGPT_MODEL: process.env.NANOGPT_MODEL,
        FREYA_ALLOW_LIVE_MODEL: process.env.FREYA_ALLOW_LIVE_MODEL,
        // Phase 5. Both are read here and nowhere else, and neither is returned by
        // anything: the provider holds the key in a private field and Core holds a
        // provider object it cannot inspect.
        BRAVE_SEARCH_API_KEY: process.env.BRAVE_SEARCH_API_KEY,
        FREYA_ALLOW_WEB_SEARCH: process.env.FREYA_ALLOW_WEB_SEARCH,
        FREYA_SEARXNG_URL: process.env.FREYA_SEARXNG_URL,
        // Gates for the offline research fixtures. Both are required, and they are
        // read here in main rather than accepted from a window, so no renderer can
        // put a production build into fixture mode.
        FREYA_E2E: process.env.FREYA_E2E,
        FREYA_E2E_RESEARCH: process.env.FREYA_E2E_RESEARCH,
      },
      {
        conversationKey: result.conversation.key,
        ...(e2eConversationStore ? { conversationStore: e2eConversationStore } : {}),
        brainKey: result.brain.key,
        missionKey: result.mission.key,
        contextKey: result.context.key,
        personalityKey: result.personality.key,
        skillKey: result.skill.key,
        forgeKey: result.forge.key,
        vault: {
          path: vaultPath,
          keyProvider: { load: async () => ({ key: result.vault.key, reason: result.vault.reason }) },
          ...(vaultBinding ? { binding: vaultBinding } : {}),
        },
        // Explicit host setting; own-app sees only Freya. System is honestly unsupported.
        ...(['own-app', 'system'].includes(process.env.FREYA_CONTEXT_WINDOW_OBSERVATION ?? '') ? {
          windowObservation: {
            enabled: true,
            provider: process.env.FREYA_CONTEXT_WINDOW_OBSERVATION === 'own-app'
              ? createOwnWindowProvider(createElectronOwnWindowSource())
              : createSystemWindowProvider(),
            scope: { scopeKind: 'surface' as const, scopeId: 'desktop-window' },
          },
        } : {}),
        // Opt-in, and named for what it is. Never inferred from a debug flag or
        // from a missing credential: a build that answers from a canned string
        // without saying so is the failure this guards against. The slow variant
        // exists so the end-to-end suite has something to cancel.
        ...(developerProvider() ? { developerProvider: developerProvider() } : {}),
        // The *entire* provider set when the research fixtures are gated on, so an
        // E2E run cannot fall through to a real provider.
        ...(fixtureProvider ? { providers: [fixtureProvider] } : {}),
        // Phase 44: the connector connection plane. Built here so the token store
        // uses Electron's OS secure storage; with no client credentials the
        // runtime is fail-closed and every connector reports unconfigured.
        connectorRuntime: async () => {
          const runtime = await createConnectorRuntime({
            safeStorage,
            tokenFilePath: `${dataPath}.connectors.tokens`,
            configs: {},
            oauthClient: {
              async exchange() {
                throw new Error('no connector OAuth client is configured')
              },
              async refresh() {
                throw new Error('no connector OAuth client is configured')
              },
            },
            fetchImpl: fetch as never,
          })
          return { auth: runtime.auth }
        },
        // Phase 42. Off unless the main process was deliberately opted in. The seam
        // carries the real adapters, a durable journal and an owner-authored grant
        // file; Core's own STOP ALL is composed on top of it by the host.
        ...(deviceHandsSeam ? { deviceHands: deviceHandsSeam } : {}),
        // Input uses the configured adapter and explicit remote-audio consent.
        // Output uses local system speech; neither credential reaches the window.
        capabilityPreferences: () => capabilityPreferences,
        voiceTts: gateVoiceOutput(voiceOutput, selectedVoice),
        voiceStt: gateVoiceInput(voiceInput, selectedVoice),
        voiceWake: buildLocalWakeGate(),
        voiceAttentionTimeoutMs: () => voicePreferences().attentionTimeoutMs,
        voiceAutoSpeak: legacyVoicePreferences().autoSpeak,
        voiceProactiveAlerts: legacyVoicePreferences().proactiveAlerts,
        voiceMuted: legacyVoicePreferences().ttsProvider === 'off',
        voiceFollowUpWindowMs: VOICE_FOLLOW_UP_WINDOW_MS,
      },
    )
    registerIpc()

    /**
     * Mount the browser-extension bridge, but only when Device Hands is really on.
     *
     * Phase 43 landed this seam set to `'pending-phase42'`: the bridge, the pairing
     * and the read-only observations worked, and every *act* was refused at the
     * `enabled` gate. That was the honest state while nothing supplied a real Device
     * Hands adapter. Phase 42 is now in main, so the seam can be `'active'` — and the
     * activation follows the same switch that governs Device Hands itself rather than
     * being its own flag, because a browser-control surface that can be enabled while
     * the hands it depends on are off is two switches where there should be one.
     *
     * The grant source is the **same owner-authored grant file** Phase 42 reads, and
     * the same policy lists. That is deliberate: the extension is a port onto Device
     * Hands, not a second capability with its own grants. An extension cannot hold a
     * grant the hands themselves do not have.
     *
     * Approvals are denied rather than routed, matching Phase 42 exactly. There is no
     * owner-approval channel in this architecture, and inventing one here would let a
     * browser action self-approve. A consequential action therefore stays blocked,
     * which is the correct outcome rather than a gap to paper over.
     *
     * `stopAllActive` comes from Core's own latch, so pressing STOP ALL refuses
     * extension actions on the same turn as everything else.
     */
    if (deviceHandsSeam !== undefined) {
      const localUnrestricted = localUnrestrictedMode()
      const seamGrants = localUnrestricted
        ? []
        : readDeviceHandsGrants(join(app.getPath('userData'), 'device-hands.grants.json'))
      browserExtensionHost = createBrowserExtensionHost({
        activation: 'active',
        localUnrestricted,
        urlOptions: { allowPrivateHosts: localUnrestricted },
        activeGrant: (principalId, scope) =>
          seamGrants.find(
            (grant) => grant.principalId === principalId && grant.scope === scope && grant.revokedAt === null,
          ) ?? null,
        requestOwnerApproval: async (ask) => ({
          approvalId: ask.approvalId,
          granted: localUnrestricted,
          decidedBy: localUnrestricted ? 'owner' : 'unknown',
          decidedAt: new Date().toISOString(),
        }),
        requestControl: async () => localUnrestricted,
        policy: localUnrestricted
          ? {
              localUnrestricted: true,
              allowedRoots: [],
              deniedRoots: [],
              allowedHosts: [],
              allowedCommands: [],
              allowedEnvNames: [],
            }
          : {
              allowedRoots: splitDeviceHandsList(process.env.FREYA_DEVICE_HANDS_ROOTS),
              deniedRoots: [join(app.getPath('userData'), 'vault')],
              allowedHosts: splitDeviceHandsList(process.env.FREYA_DEVICE_HANDS_HOSTS),
              allowedCommands: splitDeviceHandsList(process.env.FREYA_DEVICE_HANDS_COMMANDS),
              allowedEnvNames: splitDeviceHandsList(process.env.FREYA_DEVICE_HANDS_ENV_NAMES),
            },
      })
      browserExtensionHost
        .start()
        .then((started) => {
          console.log(`[freya] the browser extension bridge is listening on port ${started.port}`)
        })
        .catch((error: unknown) => {
          // A bridge that cannot bind must not take the app down with it, and must not
          // leave a half-started host behind pretending to be available.
          console.error('[freya] the browser extension bridge failed to start', error)
          browserExtensionHost = null
        })
    }

    /**
     * Mount the Freya Browser, but only when the owner asked for it *and* Device Hands is on.
     *
     * The activation is deliberately built **after** the bridge and given it, so a handoff to
     * Chrome has a real destination and a refusal has a real reason. Activation is async and
     * cannot block the window: a Freya Browser that fails to open leaves `dualBrowser` null
     * and the app exactly as it was, which is the safe direction.
     */
    const dualBrowserSeam = buildDualBrowserSeam(browserExtensionHost)
    if (dualBrowserSeam !== null) {
      dualBrowserSeam
        .activate()
        .then((result) => {
          if (!result.ok) {
            console.error(`[freya] the Freya Browser did not activate: ${result.reason}`)
            dualBrowser = null
            return
          }
          dualBrowser = dualBrowserSeam
          mountBrowserService(dualBrowserSeam)
          // Hand Core the seam. Until this runs a turn asking for a browser is
          // refused honestly; after it, the tool reaches the real Freya Browser
          // through Device Hands, on the native/public port.
          coreHost?.attachDualBrowser(dualBrowserSeam.runtime)
          // And the tab tool, once the service exists. It is a different door on purpose: the
          // reader tool keeps the routed command vocabulary and no way to see tab state.
          if (browserService !== null) {
            coreHost?.attachBrowserTabs({ run: async (request) => await browserService!.run(request) })
          }
          console.log(`[freya] ${result.reason}`)
        })
        .catch((error: unknown) => {
          console.error('[freya] the Freya Browser failed to activate', error)
          dualBrowser = null
        })
    }

    mainWindow = createWindow()
    startPresenceFor(mainWindow)

    // The external control plane. Started after the window so any first peer
    // that connects can immediately focus the existing instance; stopped
    // before Core in `shutdownCoreAndThen` so the channel and the journal
    // never disagree about who is alive.
    if (controlHandle === null) {
      try {
        const { ControlService } = await import('./control/service')
        const service = new ControlService({
          coreHost: requireCore(),
          getBrowserService: () => browserService,
          getMainWindow: () => mainWindow,
          focusWindow: () => {
            const win = mainWindow
            if (win === null || win.isDestroyed()) return false
            if (win.isMinimized()) win.restore()
            win.show()
            win.focus()
            return true
          },
          stopAllActive: () => requireCore().status().stopAll.active,
          hostPrincipalId: () => 'owner',
          notify: async (text: string) => {
            if (Notification.isSupported()) {
              new Notification({ title: 'Freya', body: text, silent: true }).show()
            }
          },
        })
        controlHandle = await startControl({
          userDataDir: app.getPath('userData'),
          service,
          enabled: true,
          log: (line) => console.log(line),
        })
        console.log(`[freya] control plane ready at ${controlHandle.endpoint}`)
      } catch (error) {
        console.error('[freya] the control plane failed to start; external tools will be unable to reach this Freya instance', error)
        controlHandle = null
      }
    }

    // Wire the presence host to Core projections. The presence host receives
    // the same projections as the main window, but it only forwards them to
    // the presence window — it never interprets them.
    coreHost?.attach((status) => presenceHost?.updateCore(status))
    coreHost?.onAttention((projection) => presenceHost?.updateAttention(projection))
    coreHost?.onWork((projection) => presenceHost?.updateWork(projection))
    coreHost?.onPersonality((projection) => presenceHost?.updatePersonality(projection))

    // Deliberately not awaited before the window opens: a slow or unwritable log
    // should degrade Core, not hold the app off the screen. A window created
    // before Core is ready attaches and simply receives the status when it lands.
    void coreHost.start().catch((error: unknown) => {
      console.error('[freya] core failed to start', error)
    })
    // The bounded attention wake. Coarse on purpose, and the only timer that
    // exists for attention; it makes no model call and reaches no provider.
    if (attentionTimer === null) {
      attentionTimer = setInterval(() => {
        void coreHost?.attentionTick().catch((error: unknown) => {
          console.error('[freya] attention tick failed', error)
        })
      }, 30_000)
    }
  })

  app.on('activate', () => {
    if (mainWindow === null || mainWindow.isDestroyed()) {
      mainWindow = createWindow()
      startPresenceFor(mainWindow)
    }
  })
})

app.on('window-all-closed', () => {
  if (!ownsProfile) return
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  if (!ownsProfile || quitting || !workspace) return
  // A quit can arrive without the window's close event ever firing, so this
  // hook has to do the collect itself and then re-enter the quit.
  event.preventDefault()
  shutdownCoreAndThen(() => app.quit())
})

/**
 * Permissions.
 *
 * Everything is denied by default, which is the posture the rest of the security
 * story rests on. The single exception is the microphone, and it is granted only
 * when all four of these hold:
 *
 *   - the owner has turned the microphone on, as **Core** reported it;
 *   - a voice capture is actually open, as Core reported it;
 *   - the request is for audio only, never a camera;
 *   - the browser raised it as a direct result of the user pressing the
 *     microphone control, which is the only code path that calls `getUserMedia`.
 *
 * Push-to-talk remains capture-scoped. Hands-free is the one explicit ambient
 * exception: while the owner has armed it, a local Web Audio meter may keep an
 * audio stream open for bounded wake detection. No audio leaves that stream until
 * local speech activity produces one bounded wake clip for Core to transcribe.
 * A request at any other time, or for anything other than audio, is refused.
 *
 * ## Why there are two handlers
 *
 * `setPermissionRequestHandler` covers the prompt. `setPermissionCheckHandler`
 * covers the *synchronous* question a renderer asks when a `MediaStream` is
 * constructed from an already-granted source, and — more importantly here — it
 * is the only place a renderer can be caught asking whether it is allowed to use
 * the microphone *between* captures. Installing only the first leaves a window that
 * polls permission as a way to learn whether a capture is expected, which is a
 * side channel into Core's state; installing both means both answers come from
 * Core's own projection and neither can be used as a probe.
 *
 * Both read the same two facts, and both are cleared together.
 */
app.on('web-contents-created', (_event, contents) => {
  if (!ownsProfile) return
  contents.session.setPermissionRequestHandler((_wc, permission, callback, details) => {
    // Electron exposes the requested media kinds on newer versions only, so this
    // reads defensively. When they are not reported, the request is refused: an
    // unknown request is not one we have granted.
    const mediaTypes = (details as { mediaTypes?: readonly string[] } | undefined)?.mediaTypes
    const audioOnly = Array.isArray(mediaTypes) && mediaTypes.length > 0 &&
      mediaTypes.every((kind) => kind === 'audio')
    callback(permission === 'media' && _wc === mainWindow?.webContents && microphoneExpected() && audioOnly)
  })
  contents.session.setPermissionCheckHandler((_wc, permission) => {
    // Deliberately origin-blind and content-blind: a request is allowed only when
    // Core has an open capture, and a page loaded into any window therefore cannot
    // obtain a stream by asking while an unrelated capture happens to be running.
    // Web content cannot activate the microphone at all, because it has no path to
    // `getUserMedia` — the permission gate is the second lock, not the only one.
    if (permission !== 'media') return false
    return _wc === mainWindow?.webContents && microphoneExpected()
  })
})

/**
 * Whether the operating system should hand over a microphone right now.
 *
 * Set from **Core's answer**, never from a renderer claim. The renderer opens and
 * closes the device itself — that is where the Web Audio API is — but the host
 * only relaxes the permission gate once the trusted half has agreed either a
 * bounded capture is running or the owner explicitly armed hands-free, and the
 * microphone is enabled. Disarming hands-free or STOP ALL closes that ambient
 * permission again immediately.
 */

const microphoneGate = new MicrophoneGate()

function microphoneExpected(): boolean {
  return microphoneGate.allowed
}

/**
 * Follow Core's verdict on a voice command.
 *
 * Every arm reads the same Core projection afterwards rather than tracking a
 * separate local model of it, because the projection is the truth and a second
 * copy is a second thing that can be wrong. The two booleans above are only the
 * hot path's cache of "does Core's projection currently say an open capture on an
 * enabled microphone", and they are rewritten from it on every voice command.
 */
function trackVoiceCapture(envelope: CoreCommandEnvelope, _result: { ok: boolean }): void {
  switch (envelope.command) {
    case 'voice.capture.start':
    case 'voice.capture.end':
    case 'voice.capture.cancel':
    case 'voice.mic.enable':
    case 'voice.mic.disable':
    case 'voice.permission.request':
    case 'voice.permission.report':
    case 'voice.tts.cancel':
    case 'voice.wake.arm':
    case 'voice.wake.disarm':
      break
    default:
      return
  }
  const voice = requireCore().voice()
  // A refused start must not leave the gate open: the previous value is only
  // replaced when Core actually agrees a session exists. Before Core has built
  // the service at all, both stay false — which is the safe reading, since there
  // is no capture for a window to be asking about.
  microphoneGate.update(voice)
  if (envelope.command === 'voice.mic.enable' && _result.ok) microphoneGate.beginPermission()

  presenceHost?.updateVoice(voice)
}
