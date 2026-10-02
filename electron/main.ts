import { app, BrowserWindow, ipcMain, screen, shell } from 'electron'
import { join } from 'node:path'
import { WorkspaceFile, DEFAULT_MAX_BYTES } from './workspaceFile'
import { ElectronCoreHost } from './coreHost'
import { loadKeyring } from './keyring'
import { loadLocalEnv } from './localEnv'
import { createOwnWindowProvider, createSystemWindowProvider } from './context/windowProviders'
import { createElectronOwnWindowSource } from './context/electronWindowSource'
import type { CoreCommandEnvelope } from '../core/protocol/core-protocol'
import type { ModelProvider } from '../core/model/provider'

const HERE = __dirname
const ROOT = join(HERE, '..')
const DEV_SERVER = process.env.FREYA_DEV_SERVER
const WORKSPACE_FILE = 'workspace.json'
const CORE_LOG_FILE = 'core-events.jsonl'

// Local `.env` first, in the main process, before anything reads configuration.
// Real environment variables win over the file; values are never logged, and
// nothing here is forwarded to a window — the preload bridge carries named
// commands and bounded payloads only, never environment content.
loadLocalEnv(join(ROOT, '.env'))

let mainWindow: BrowserWindow | null = null
/** Null until the app is ready; every handler that needs it is registered after. */
let workspace: WorkspaceFile | null = null
/** One Core per process. Survives renderer reloads; dies only with the app. */
let coreHost: ElectronCoreHost | null = null
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
} | null {
  const conversation = e2eKey('FREYA_E2E_CONVERSATION_KEY')
  const brain = e2eKey('FREYA_E2E_BRAIN_KEY')
  const mission = e2eKey('FREYA_E2E_MISSION_KEY')
  const context = e2eKey('FREYA_E2E_CONTEXT_KEY')
  const personality = e2eKey('FREYA_E2E_PERSONALITY_KEY')
  // All five or none, so a partial fixture cannot quietly run with a real keyring for
  // the domain it forgot.
  if (
    conversation === null ||
    brain === null ||
    mission === null ||
    context === null ||
    personality === null
  ) {
    return null
  }
  return { conversation, brain, mission, context, personality }
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
  if (attentionTimer !== null) {
    clearInterval(attentionTimer)
    attentionTimer = null
  }
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

  window.once('ready-to-show', () => window.show())

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

  window.on('closed', () => {
    detachCore?.()
    detachActivity?.()
    detachConversation?.()
    detachBrain?.()
    detachWork?.()
    detachMission?.()
    detachWorkforce?.()
    detachContext?.()
    detachPersonality?.()
    detachAttention?.()
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

/* ------------------------------------------------------------------ *
 * IPC — a deliberately small, named surface
 * ------------------------------------------------------------------ */

function registerIpc(): void {
  ipcMain.handle('freya:runtime', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    platform: process.platform,
    arch: process.arch,
    userData: app.getPath('userData'),
    workspaceFile: requireWorkspace().path,
    dev: Boolean(DEV_SERVER),
  }))

  ipcMain.handle('freya:workspace:load', () => requireWorkspace().load())
  ipcMain.handle('freya:core:submit', (_event, envelope: CoreCommandEnvelope) => {
    const result = requireCore().submit(envelope)
    // The microphone gate follows Core's verdict rather than the request, so a
    // refused capture never opens the device.
    void result.then((settled) => trackVoiceCapture(envelope, settled))
    return result
  })
  ipcMain.handle('freya:core:status', () => requireCore().status())
  ipcMain.handle('freya:core:activity', () => requireCore().activity())
  ipcMain.handle('freya:core:conversation', () => requireCore().conversation())
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

app.whenReady().then(() => {
  workspace = new WorkspaceFile({
    path: join(app.getPath('userData'), WORKSPACE_FILE),
  })
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
      })
    : loadKeyring(dataPath)
  void keyResult.then((result) => {
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
    coreHost = new ElectronCoreHost(
      dataPath,
      {
        NANOGPT_API_KEY: process.env.NANOGPT_API_KEY,
        NANOGPT_BASE_URL: process.env.NANOGPT_BASE_URL,
        NANOGPT_MODEL: process.env.NANOGPT_MODEL,
        FREYA_ALLOW_LIVE_MODEL: process.env.FREYA_ALLOW_LIVE_MODEL,
        // Phase 5. Both are read here and nowhere else, and neither is returned by
        // anything: the provider holds the key in a private field and Core holds a
        // provider object it cannot inspect.
        BRAVE_SEARCH_API_KEY: process.env.BRAVE_SEARCH_API_KEY,
        FREYA_ALLOW_WEB_SEARCH: process.env.FREYA_ALLOW_WEB_SEARCH,
        // Gates for the offline research fixtures. Both are required, and they are
        // read here in main rather than accepted from a window, so no renderer can
        // put a production build into fixture mode.
        FREYA_E2E: process.env.FREYA_E2E,
        FREYA_E2E_RESEARCH: process.env.FREYA_E2E_RESEARCH,
      },
      {
        conversationKey: result.conversation.key,
        brainKey: result.brain.key,
        missionKey: result.mission.key,
        contextKey: result.context.key,
        personalityKey: result.personality.key,
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
      },
    )
    registerIpc()
    mainWindow = createWindow()

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
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  if (quitting || !workspace) return
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
 * when all three of these hold:
 *
 *   - a voice capture is actually open, as Core reported it;
 *   - the request is for audio only, never a camera;
 *   - the browser raised it as a direct result of the user pressing the
 *     microphone control, which is the only code path that calls `getUserMedia`.
 *
 * That is what explicit push-to-talk means at this layer: no ambient recording,
 * no always-on stream, and no way for a window to hold a microphone open between
 * captures. A request at any other time, or for anything other than audio, is
 * refused.
 */
app.on('web-contents-created', (_event, contents) => {
  contents.session.setPermissionRequestHandler((_wc, permission, callback, details) => {
    // Electron exposes the requested media kinds on newer versions only, so this
    // reads defensively. When they are not reported, the request is refused: an
    // unknown request is not one we have granted.
    const mediaTypes = (details as { mediaTypes?: readonly string[] } | undefined)?.mediaTypes
    const audioOnly = Array.isArray(mediaTypes) && mediaTypes.length > 0 &&
      mediaTypes.every((kind) => kind === 'audio')
    callback(permission === 'media' && voiceCaptureOpen && audioOnly)
  })
})

/**
 * Whether a capture is currently open.
 *
 * Set from **Core's answer**, not from a renderer claim. The renderer opens and
 * closes the device itself — that is where the Web Audio API is — but the host
 * only relaxes the permission gate once the trusted half has agreed a capture is
 * running, so a compromised window cannot open a stream by asking nicely.
 */
let voiceCaptureOpen = false

/** Follow Core's verdict on a voice capture command. */
function trackVoiceCapture(envelope: CoreCommandEnvelope, result: { ok: boolean }): void {
  if (envelope.command === 'voice.capture.start') {
    voiceCaptureOpen = result.ok
    return
  }
  if (envelope.command === 'voice.capture.end' || envelope.command === 'voice.capture.cancel') {
    voiceCaptureOpen = false
  }
}
