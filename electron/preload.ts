import { contextBridge, ipcRenderer } from 'electron'
import type {
  CoreCommandEnvelope,
  CoreCommandName,
  CoreCommandResult,
  CoreStatus,
} from '../core/protocol/core-protocol'
import type { CoreActivityEvent } from '../core/protocol/activity'
import type { ConversationProjection, VoiceProjection } from '../core/protocol/conversation'
import type { BrainProjection } from '../core/brain/brain'
import type { WorkProjection } from '../core/work/projection'
import { CONVERSATION_LIMITS } from '../core/conversation/types'
import { VOICE_LIMITS } from '../core/voice/types'
import { BRAIN_LIMITS } from '../core/brain/types'
import { WORK_LIMITS } from '../core/work/types'

export interface RuntimeInfo {
  version: string
  electron: string
  platform: string
  arch: string
  userData: string
  workspaceFile: string
  dev: boolean
}

/**
 * The entire privileged surface of the Freya desktop host.
 *
 * Four functions and one flag for the workspace, five for the Core, and one
 * flag: `getRuntimeInfo`, `loadWorkspace`, `saveWorkspace`, `onCollect`,
 * `coreSubmit`, `coreStatus`, `onCoreStatus`, `coreActivity`, `onCoreActivity`,
 * and `isDesktop`. No ipcRenderer passthrough, no remote module, no eval, and no
 * way to name an IPC channel from the renderer. A renderer compromise gets an
 * attacker exactly what this file exposes.
 *
 * The Core functions are named individually rather than exposing a channel
 * string, so the renderer cannot invent a command name at the bridge. The
 * command list is checked here as well as in Core: the renderer is the owner's
 * UI, not the authority, and an unrecognised name is refused before it can be
 * serialised into an IPC message.
 */
const api = {
  isDesktop: true as const,
  getRuntimeInfo: (): Promise<RuntimeInfo> => ipcRenderer.invoke('freya:runtime'),
  loadWorkspace: (): Promise<unknown> => ipcRenderer.invoke('freya:workspace:load'),
  saveWorkspace: (payload: unknown): Promise<boolean> =>
    ipcRenderer.invoke('freya:workspace:save', payload),

  /**
   * A dumb relay. The host asks once, as the window is closing, and the
   * renderer answers by saving through the function above — the host has no way
   * to build a layout and the renderer has no way to be asked in time.
   */
  onCollect: (handler: () => unknown): void => {
    ipcRenderer.on('freya:workspace:collect', () => {
      void api.saveWorkspace(handler())
    })
  },

  /**
   * Send one Core command.
   *
   * `requestId` is generated here rather than supplied, so the renderer cannot
   * collide two requests or replay an id it once saw.
   */
  coreSubmit: (command: CoreCommandName, payload?: unknown): Promise<CoreCommandResult> => {
    if (!CORE_COMMANDS.has(command)) {
      return Promise.resolve({
        requestId: 'rejected',
        ok: false,
        refusal: { reason: `unknown command: ${String(command)}` },
      })
    }

    // The context bridge is a capability boundary, not a generic serializer.
    // Rebuild the payload from the small fields each renderer-reachable command
    // actually owns. This prevents a compromised window from attaching a huge
    // ignored blob to an otherwise valid command and making the main process
    // structured-clone it before Core can reject it.
    const bounded = rendererPayload(command, payload)
    if (!bounded.ok) {
      return Promise.resolve({
        requestId: 'rejected',
        ok: false,
        refusal: { reason: bounded.reason },
      })
    }

    const envelope: CoreCommandEnvelope = {
      command,
      requestId: newRequestId(),
      ...(bounded.payload === undefined ? {} : { payload: bounded.payload }),
    }
    return ipcRenderer.invoke('freya:core:submit', envelope)
  },

  coreStatus: (): Promise<CoreStatus> => ipcRenderer.invoke('freya:core:status'),

  /**
   * The activity feed: display-ready rows derived from durable events.
   *
   * Narrow on purpose. There is no generic "read events" call here, and no
   * channel the renderer can name itself — a window cannot ask for a payload, an
   * event id, or the journal. Command text is not in these rows and never will
   * be, which is the same property the journal itself has.
   */
  coreActivity: (): Promise<CoreActivityEvent[]> => ipcRenderer.invoke('freya:core:activity'),

  onCoreActivity: (handler: (activity: CoreActivityEvent[]) => void): (() => void) => {
    const listener = (_event: unknown, activity: CoreActivityEvent[]): void => handler(activity)
    ipcRenderer.on('freya:core:activity', listener)
    return () => {
      ipcRenderer.removeListener('freya:core:activity', listener)
    }
  },

  /**
   * The conversation projection: the transcript, the conversation list, and
   * whether Freya can currently think.
   *
   * Content crosses here, because a transcript has to be rendered somewhere. What
   * does *not* cross is the store, the key, the filesystem path, or any way to ask
   * for a conversation that is not the one on screen. A window can read a
   * conversation; it cannot decrypt one itself, and it holds no key to do so with.
   */
  coreConversation: (): Promise<ConversationProjection | null> =>
    ipcRenderer.invoke('freya:core:conversation'),

  onCoreConversation: (handler: (projection: ConversationProjection) => void): (() => void) => {
    const listener = (_event: unknown, projection: ConversationProjection): void => handler(projection)
    ipcRenderer.on('freya:core:conversation', listener)
    return () => {
      ipcRenderer.removeListener('freya:core:conversation', listener)
    }
  },

  /**
   * Voice status: whether a local speech engine exists, and the capture bounds.
   *
   * A read, never a configuration surface. There is no function here that points
   * Freya at a speech service, because there is no speech service to point it at:
   * voice is local-only, and this exists so the UI can say so rather than showing
   * a microphone button that quietly does nothing.
   */
  coreVoice: (): Promise<VoiceProjection | null> => ipcRenderer.invoke('freya:core:voice'),

  /**
   * The Brain projection: identity, the self-model, counts, recent admissions and
   * known conflicts.
   *
   * Memory *content* does not cross here — the projection carries subjects, ids,
   * source classes and confidences, not what was remembered. Content comes only
   * through an explicit `brain.recall`, which is a question with a query rather
   * than a standing feed, so a window cannot hold a copy of everything Freya knows
   * by simply being open.
   */
  coreBrain: (): Promise<BrainProjection | null> => ipcRenderer.invoke('freya:core:brain'),

  onCoreBrain: (handler: (projection: BrainProjection) => void): (() => void) => {
    const listener = (_event: unknown, projection: BrainProjection): void => handler(projection)
    ipcRenderer.on('freya:core:brain', listener)
    return () => {
      ipcRenderer.removeListener('freya:core:brain', listener)
    }
  },

  /**
   * The Work projection: tasks, runs, steps, approvals and progress.
   *
   * What crosses is exactly what `core/work/projection.ts` says crosses: ids,
   * statuses, counts, measured lengths, and the bounded labels this Core process is
   * holding in memory. What does **not** cross is the substance of the work — no
   * step input, no observation contents, no capability or verifier instance, no
   * plan. A window can see that a step ran and whether it verified; it cannot read
   * what a capability was given or what it returned, and it cannot reach the code
   * that would let it describe its own approval.
   */
  coreWork: (): Promise<WorkProjection | null> => ipcRenderer.invoke('freya:core:work'),

  onCoreWork: (handler: (projection: WorkProjection) => void): (() => void) => {
    const listener = (_event: unknown, projection: WorkProjection): void => handler(projection)
    ipcRenderer.on('freya:core:work', listener)
    return () => {
      ipcRenderer.removeListener('freya:core:work', listener)
    }
  },

  /**
   * Watch Core status. Returns a disposer, which `onCollect` conspicuously
   * lacks: a subscription you cannot cancel is a leak you have to design around,
   * and React effects need one to run cleanup.
   */
  onCoreStatus: (handler: (status: CoreStatus) => void): (() => void) => {
    const listener = (_event: unknown, status: CoreStatus): void => handler(status)
    ipcRenderer.on('freya:core:status', listener)
    return () => {
      ipcRenderer.removeListener('freya:core:status', listener)
    }
  },
}

/**
 * The commands a renderer may name.
 *
 * Deliberately a *subset* of `CoreCommandName`. Core can create and revoke
 * grants, but a window cannot: the bridge refuses those names, so a compromised
 * renderer has no path to grant governance even though the command exists in
 * Core. Adding a name here is a decision to hand a window a capability, and it
 * should read like one.
 *
 * The conversation names are here because chat is the product. Note what is *not*
 * reachable through them: a window may submit text and ask for a conversation, and
 * that is all. It cannot name a grant, choose a model, raise a token ceiling,
 * pick a turn id, or select a provider — and it cannot name `cognition.request`
 * directly, so the only route from a window to a model is a conversation turn,
 * which the Mind shapes and the Governor checks.
 */
const CORE_COMMANDS: ReadonlySet<string> = new Set<CoreCommandName>([
  'core.status.read',
  'core.command.submit',
  'cognition.status.read',
  'security.status.read',
  'security.stopAll',
  'security.resume',
  'conversation.create',
  'conversation.list',
  'conversation.read',
  'conversation.turn.submit',
  'conversation.turn.cancel',
  'voice.status.read',
  'voice.capture.start',
  'voice.capture.end',
  'voice.capture.cancel',
  // The Brain is readable and writable by the owner, because remembering is the
  // product. Note what is *not* reachable through these: a window cannot name a
  // source class, a confidence ceiling or a verification status. It says what it
  // wants remembered, and Core decides how much that is worth — a window that could
  // assert `owner-assertion` for itself would be a window that could launder a web
  // page's contents in as something the owner said.
  'brain.status.read',
  'brain.memory.write',
  'brain.memory.archive',
  'brain.recall',
  // Phase 5 research. The owner may search, read a public page and start research;
  // what it may *not* do is name a provider, a model, a limit, a budget or a
  // capability. Those are Core's, and the payload contracts below rebuild each one
  // from known fields so an ignored field never even reaches the main process.
  'search.web',
  'browser.read',
  'research.start',
  'research.cancel',
  'research.status.read',

  // Work. A window may plan and drive work and decide an approval, and that is the
  // whole list. Note what it still cannot do: it cannot name a capability Core does
  // not have, cannot raise a ceiling above Core's own, cannot declare a step
  // verified, cannot say who decided an approval, and cannot grant itself anything.
  // `work.approval.decide` is reachable here precisely because a window *is* the
  // owner's UI — and Core assigns that identity rather than reading one out of the
  // payload.
  'work.status.read',
  'work.task.create',
  'work.task.update',
  'work.run.create',
  'work.run.start',
  'work.run.pause',
  'work.run.resume',
  'work.run.cancel',
  'work.approval.decide',
])

/**
 * One bounded optional string.
 *
 * `undefined` and `''` are the same thing for an *optional* field: both mean "not
 * supplied". Conflating them matters because an empty recall query is a real
 * request — it asks for Freya's most recent memories — and treating the empty
 * string as malformed made an ordinary button press fail as a bad payload. A
 * *required* field still refuses an empty string, because there a blank value is a
 * mistake rather than an absence.
 */
function readString(
  record: Record<string, unknown> | null,
  key: string,
  max: number,
  required = true,
): string | null | undefined {
  const value = record?.[key]
  if (value === undefined) return required ? null : undefined
  if (typeof value !== 'string') return null
  if (value.length === 0) return required ? null : undefined
  if (value.length > max) return null
  return value
}

type RendererPayloadResult =
  | { ok: true; payload?: unknown }
  | { ok: false; reason: string }

const MAX_ID_CHARS = 256
/** Matches the Searcher's own ceiling, so the bridge and Core agree on the limit. */
const MAX_SEARCH_QUERY_CHARS = 512
const MAX_SOURCE_URL_CHARS = 2_048
const MAX_RESEARCH_QUESTION_CHARS = 4_096
const MAX_STOP_REASON_CHARS = 1_000
const MAX_COMMAND_ORIGIN_CHARS = 128

function rendererPayload(command: CoreCommandName, payload: unknown): RendererPayloadResult {
  const record =
    typeof payload === 'object' && payload !== null
      ? (payload as Record<string, unknown>)
      : null

  const string = (key: string, max: number, required = true): string | null | undefined =>
    readString(record, key, max, required)

  /**
   * The same check, against some other object.
   *
   * A step plan is a list of objects, so its fields cannot be read with the closure
   * above — which reads the command payload. Getting that wrong once already
   * happened here: every step came back "a step key is invalid", because the
   * helper was reading a key from the top level of a command that has none.
   */
  const from = (
    source: Record<string, unknown>,
    key: string,
    max: number,
    required = true,
  ): string | null | undefined => readString(source, key, max, required)

  switch (command) {
    case 'core.status.read':
    case 'cognition.status.read':
    case 'security.status.read':
    case 'security.resume':
    case 'conversation.list':
    case 'voice.status.read':
    case 'voice.capture.start':
    case 'voice.capture.cancel':
    case 'brain.status.read':
    case 'research.status.read':
      return { ok: true }

    case 'work.status.read':
      return { ok: true }

    case 'core.command.submit': {
      const text = string('text', 4_000)
      if (text === null || text === undefined) return { ok: false, reason: 'command text is invalid' }
      const origin = string('origin', MAX_COMMAND_ORIGIN_CHARS, false)
      if (origin === null) return { ok: false, reason: 'command origin is invalid' }
      return { ok: true, payload: { text, ...(origin === undefined ? {} : { origin }) } }
    }

    case 'security.stopAll': {
      const reason = string('reason', MAX_STOP_REASON_CHARS, false)
      if (reason === null) return { ok: false, reason: 'STOP ALL reason is too large or invalid' }
      return { ok: true, payload: reason === undefined ? undefined : { reason } }
    }

    case 'conversation.create': {
      const title = string('title', CONVERSATION_LIMITS.maxTitleCharacters, false)
      if (title === null) return { ok: false, reason: 'conversation title is too large or invalid' }
      return { ok: true, payload: title === undefined ? undefined : { title } }
    }

    case 'conversation.read': {
      const conversationId = string('conversationId', MAX_ID_CHARS)
      if (conversationId === null || conversationId === undefined) {
        return { ok: false, reason: 'conversation id is invalid' }
      }
      return { ok: true, payload: { conversationId } }
    }

    case 'conversation.turn.submit': {
      const conversationId = string('conversationId', MAX_ID_CHARS)
      const text = string('text', CONVERSATION_LIMITS.maxMessageCharacters)
      if (conversationId === null || conversationId === undefined) {
        return { ok: false, reason: 'conversation id is invalid' }
      }
      if (text === null || text === undefined) {
        return { ok: false, reason: 'conversation message is too large or invalid' }
      }
      return { ok: true, payload: { conversationId, text } }
    }

    case 'conversation.turn.cancel': {
      const turnId = string('turnId', MAX_ID_CHARS)
      if (turnId === null || turnId === undefined) {
        return { ok: false, reason: 'turn id is invalid' }
      }
      return { ok: true, payload: { turnId } }
    }

    case 'voice.capture.end': {
      const sessionId = string('sessionId', MAX_ID_CHARS)
      const audio = record?.audio
      const durationMs = record?.durationMs
      const cancelled = record?.cancelled

      if (sessionId === null || sessionId === undefined) {
        return { ok: false, reason: 'voice session id is invalid' }
      }
      if (!(audio instanceof Uint8Array)) {
        return { ok: false, reason: 'voice audio payload is invalid' }
      }
      if (audio.byteLength > VOICE_LIMITS.maxAudioBytes) {
        return { ok: false, reason: 'voice audio payload exceeds the capture limit' }
      }
      if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) {
        return { ok: false, reason: 'voice capture duration is invalid' }
      }
      if (cancelled !== undefined && typeof cancelled !== 'boolean') {
        return { ok: false, reason: 'voice cancellation flag is invalid' }
      }

      return {
        ok: true,
        payload: {
          sessionId,
          audio,
          durationMs,
          ...(cancelled === undefined ? {} : { cancelled }),
        },
      }
    }

    case 'brain.memory.write': {
      // Bounded here rather than only in Core: this bridge is a capability
      // boundary, and a payload large enough to be a denial-of-service belongs to
      // be refused before it is structured-cloned into the main process.
      const content = string('content', BRAIN_LIMITS.maxMemoryContentChars)
      const subject = string('subject', BRAIN_LIMITS.maxMemorySubjectChars, false)
      const kind = string('kind', 40, false)
      if (content === null || content === undefined) {
        return { ok: false, reason: 'memory content is too large or invalid' }
      }
      if (subject === null) return { ok: false, reason: 'memory subject is too large or invalid' }
      if (kind === null) return { ok: false, reason: 'memory kind is invalid' }
      return {
        ok: true,
        payload: {
          content,
          ...(subject === undefined ? {} : { subject }),
          ...(kind === undefined ? {} : { kind }),
        },
      }
    }

    case 'brain.memory.archive': {
      const memoryId = string('memoryId', MAX_ID_CHARS)
      const reason = string('reason', MAX_STOP_REASON_CHARS, false)
      if (memoryId === null || memoryId === undefined) {
        return { ok: false, reason: 'memory id is invalid' }
      }
      if (reason === null) return { ok: false, reason: 'memory archive reason is invalid' }
      return { ok: true, payload: { memoryId, ...(reason === undefined ? {} : { reason }) } }
    }

    case 'brain.recall': {
      const query = string('query', 2_000, false)
      if (query === null) return { ok: false, reason: 'recall query is invalid' }
      // Bounded to the same ceiling Core clamps to, so a window cannot ask for an
      // unbounded pack. `clampBudget` enforces it again inside Core; this is the
      // first of the two, not the only one.
      const limit = record?.limit
      if (limit !== undefined && (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 0)) {
        return { ok: false, reason: 'recall limit is invalid' }
      }
      return {
        ok: true,
        payload: { ...(query === undefined ? {} : { query }), ...(limit === undefined ? {} : { limit }) },
      }
    }

    case 'search.web': {
      // One field. A renderer cannot attach a provenance class, a provider, a result
      // count or a budget; the payload is rebuilt from `query` alone, so a large
      // ignored blob never gets structured-cloned into the main process.
      const query = string('query', MAX_SEARCH_QUERY_CHARS)
      if (query === null || query === undefined) {
        return { ok: false, reason: 'a search query is required' }
      }
      return { ok: true, payload: { query } }
    }

    case 'browser.read': {
      const url = string('url', MAX_SOURCE_URL_CHARS)
      if (url === null || url === undefined) {
        return { ok: false, reason: 'a URL is required' }
      }
      return { ok: true, payload: { url } }
    }

    case 'research.start': {
      const question = string('question', MAX_RESEARCH_QUESTION_CHARS)
      if (question === null || question === undefined) {
        return { ok: false, reason: 'a research question is required' }
      }
      // Nothing else is forwarded. In particular not `modelTurns`, `durationMs`,
      // `maxOutputTokens` or `limits`: research budgets are code-owned, and a window
      // that could raise them would make the whole ceiling advisory.
      return { ok: true, payload: { question } }
    }

    case 'research.cancel': {
      const researchId = string('researchId', MAX_ID_CHARS)
      if (researchId === null || researchId === undefined) {
        return { ok: false, reason: 'a research id is required' }
      }
      return { ok: true, payload: { researchId } }
    }


    case 'work.task.create': {
      const title = string('title', WORK_LIMITS.maxLabelChars)
      if (title === null || title === undefined) {
        return { ok: false, reason: 'task title is too large or invalid' }
      }
      return { ok: true, payload: { title } }
    }

    case 'work.task.update': {
      const taskId = string('taskId', MAX_ID_CHARS)
      const status = string('status', 32)
      if (taskId === null || taskId === undefined) return { ok: false, reason: 'task id is invalid' }
      if (status === null || status === undefined) {
        return { ok: false, reason: 'task status is invalid' }
      }
      return { ok: true, payload: { taskId, status } }
    }

    case 'work.run.create': {
      /**
       * A plan is a request, and this is where its *size* is bounded.
       *
       * Each step is rebuilt from named fields — key, capability, verifier, label,
       * requiresApproval — and `input` is passed as the caller sent it, because the
       * engine's sanitiser is the thing that decides what may reach a capability. A
       * second sanitiser here would be a second set of rules that could disagree with
       * the one that matters.
       *
       * What is dropped is everything else, so a window cannot attach an ignored
       * blob to an otherwise valid plan and make the main process structured-clone
       * it. Note also what a step cannot carry: a verdict. There is no field here
       * for a window to say a step succeeded.
       */
      const rawSteps = record?.steps
      if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
        return { ok: false, reason: 'a run needs at least one step' }
      }
      if (rawSteps.length > WORK_LIMITS.maxRunSteps) {
        return { ok: false, reason: `a plan may hold at most ${WORK_LIMITS.maxRunSteps} steps` }
      }
      const steps: Record<string, unknown>[] = []
      for (const raw of rawSteps) {
        if (typeof raw !== 'object' || raw === null) return { ok: false, reason: 'a step was malformed' }
        const step = raw as Record<string, unknown>
        const key = from(step, 'key', 64)
        const capability = from(step, 'capability', 64)
        const verifier = from(step, 'verifier', 64)
        const label = from(step, 'label', WORK_LIMITS.maxLabelChars)
        if (key === null || key === undefined) return { ok: false, reason: 'a step key is invalid' }
        if (capability === null || capability === undefined) {
          return { ok: false, reason: 'a step capability is invalid' }
        }
        if (verifier === null || verifier === undefined) {
          return { ok: false, reason: 'a step verifier is invalid' }
        }
        if (label === null || label === undefined) return { ok: false, reason: 'a step label is invalid' }
        steps.push({
          key,
          capability,
          verifier,
          label,
          ...(step.input === undefined ? {} : { input: step.input }),
          ...(step.requiresApproval === true ? { requiresApproval: true } : {}),
        })
      }

      const taskId = string('taskId', MAX_ID_CHARS, false)
      if (taskId === null) return { ok: false, reason: 'task id is invalid' }
      const rawLimits = record?.limits
      if (
        rawLimits !== undefined &&
        (typeof rawLimits !== 'object' || rawLimits === null || Array.isArray(rawLimits))
      ) {
        return { ok: false, reason: 'run limits are invalid' }
      }
      return {
        ok: true,
        payload: {
          steps,
          ...(taskId === undefined ? {} : { taskId }),
          ...(rawLimits === undefined ? {} : { limits: rawLimits }),
        },
      }
    }

    case 'work.run.start':
    case 'work.run.pause':
    case 'work.run.resume':
    case 'work.run.cancel': {
      const runId = string('runId', MAX_ID_CHARS)
      if (runId === null || runId === undefined) return { ok: false, reason: 'run id is invalid' }
      if (command === 'work.run.cancel') {
        const reason = string('reason', MAX_STOP_REASON_CHARS, false)
        if (reason === null) return { ok: false, reason: 'cancellation reason is invalid' }
        return { ok: true, payload: reason === undefined ? { runId } : { runId, reason } }
      }
      return { ok: true, payload: { runId } }
    }

    case 'work.approval.decide': {
      // The decision and its subject, and nothing else. There is deliberately no
      // `decidedBy` here to read: identity for an approval is assigned by Core from
      // the principal that reached the command. A window that appended one is
      // ignored, and a window that could name its own approver could approve its own
      // request.
      const approvalId = string('approvalId', MAX_ID_CHARS)
      const decision = string('decision', 16)
      const reason = string('reason', MAX_STOP_REASON_CHARS, false)
      if (approvalId === null || approvalId === undefined) {
        return { ok: false, reason: 'approval id is invalid' }
      }
      if (decision === null || decision === undefined) {
        return { ok: false, reason: 'approval decision is invalid' }
      }
      if (decision !== 'approved' && decision !== 'denied') {
        return { ok: false, reason: 'an approval decision must be approved or denied' }
      }
      if (reason === null) return { ok: false, reason: 'approval reason is invalid' }
      return {
        ok: true,
        payload: {
          approvalId,
          decision,
          ...(reason === undefined ? {} : { reason }),
        },
      }
    }

    // Grant governance is intentionally not in CORE_COMMANDS. Keeping a default
    // refusal here makes that property survive if the command vocabulary grows
    // and someone forgets to add a bounded renderer shape at the same time.
    default:
      return { ok: false, reason: 'command has no renderer payload contract' }
  }
}

/** A request id the renderer cannot choose, so it cannot collide or replay. */
function newRequestId(): string {
  return `r${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

contextBridge.exposeInMainWorld('freyaHost', api)

export type FreyaHost = typeof api
