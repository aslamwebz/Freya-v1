// @vitest-environment node

/**
 * THE PHASE 9 INTEGRATED CHAIN HARNESS.
 *
 * Shared vocabulary for the two acceptance files, and nothing that invents
 * behaviour. When this lane was written, the step between `ContextStore` and
 * the transport had no production implementation and the harness encoded it as
 * an assumption. PR #27 has since merged, and the chain is now real end to
 * end:
 *
 *   source/admission → ContextStore → `ContextIntegration` (inside Core)
 *     → `Core.context(): ContextProjectionView` → `ContextChannel` /
 *     `toContextProjection` → the window's `ContextProjection`
 *     → `contextMirror()` → `<ContextSurface/>`
 *
 * So the projection builder that used to live here is gone: every projection
 * these tests read is produced by production code (`Core.context()` for Core's
 * vocabulary, `toContextProjection`/`ElectronCoreHost.context()` for the
 * window's). What remains is:
 *
 *  - `CHAIN_SECRET` — the private text that must survive into the store and
 *    appear nowhere else;
 *  - `sendContext` — one way to drive Core's six `context.*` commands through
 *    either door this repository has: a `Core` (`handleCommand`) or the
 *    Electron host (`submit`). Both are the production doors;
 *  - `chainStore` / `admitVia` — the *source adapter* link of the chain
 *    (#26's input contract), which turns a handed-in selection, share or
 *    report into a `ContextAdmission` and then into a held item. It runs
 *    beside the facade rather than through it, because the adapters are the
 *    closed input contracts for sources and the facade is the door a payload
 *    reaches.
 *
 * Nothing here reaches into #29, #30 or #32's territory, and nothing here
 * writes a production file.
 */

import type {
  CoreCommandEnvelope,
  CoreCommandResult,
} from '../../../core/protocol/core-protocol'
import type { ContextCommandOutcome } from '../../../core/protocol/context'
import type { ContextStore, ContextStoreOptions } from '../../../core/context/store'
import type { ContextItem } from '../../../core/context/types'
import type { ContextAdapterResult } from '../../../core/context/adapters/admission'
import { admitOrThrow, sequencedStore } from './fixture'

/** Private text the chain carries. It must survive into the store and nowhere else. */
export const CHAIN_SECRET = 'FREYA_CHAIN_SECRET_33A7'

/** The facade's whole command vocabulary, as `core-protocol.ts` declares it. */
export const CHAIN_CONTEXT_COMMANDS = [
  'context.status.read',
  'context.scope.activate',
  'context.admit',
  'context.revoke',
  'context.revokeScope',
  'context.reference.read',
] as const

export type ContextCommand = (typeof CHAIN_CONTEXT_COMMANDS)[number]

/** One command's answer: the envelope's verdict and the Context slot's outcome. */
export interface ContextAnswer {
  readonly ok: boolean
  readonly refusal: { readonly reason: string } | undefined
  readonly outcome: ContextCommandOutcome
}

/**
 * The two doors a `context.*` command can be sent through.
 *
 * `Core.handleCommand` is what in-process callers use; `ElectronCoreHost.submit`
 * is what `electron/main.ts` puts behind the renderer's command channel. Same
 * envelope, same answer — which is the point of naming both here.
 */
type EnvelopeSender = (envelope: CoreCommandEnvelope) => Promise<CoreCommandResult>
export type ContextDoor = { handleCommand: EnvelopeSender } | { submit: EnvelopeSender }

function sender(door: ContextDoor): EnvelopeSender {
  return 'handleCommand' in door ? door.handleCommand.bind(door) : door.submit.bind(door)
}

/**
 * Send one `context.*` command and return both halves of the answer.
 *
 * Throws when the command produced no Context slot — i.e. when it is not a
 * context command at all — because a test that silently proceeded on an
 * "unknown command" would be asserting nothing about the chain.
 */
export async function sendContext(
  door: ContextDoor,
  command: ContextCommand,
  payload?: unknown,
): Promise<ContextAnswer> {
  const result = await sender(door)({ command, requestId: 'chain-1', payload })
  const outcome = result.context
  if (outcome === undefined) {
    throw new Error(`'${command}' produced no context outcome: ${result.refusal?.reason ?? 'no slot'}`)
  }
  return { ok: result.ok, refusal: result.refusal, outcome }
}

/** A store with readable ids (`t-1`, `t-2`, …) for naming records in assertions. */
export function chainStore(options: ContextStoreOptions = {}): ContextStore {
  return sequencedStore(options)
}

/** An adapter result waiting to become a held item, or the refusal that stopped it. */
export function admitVia(
  store: ContextStore,
  result: ContextAdapterResult,
  now: Date,
): ContextItem {
  if (!result.ok) {
    throw new Error(`chain admission refused at the adapter (${result.code}): ${result.reason}`)
  }
  return admitOrThrow(store, result.admission, now)
}
