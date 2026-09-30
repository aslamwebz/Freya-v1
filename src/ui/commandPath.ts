import { shellStore } from './store'
import { coreMirror } from '../platform/coreClient'

/**
 * The command path.
 *
 * ```
 * a surface  ->  this module  ->  typed Core client  ->  core.command.submit
 *             ->  durable command.received  ->  Core's reply  ->  an acknowledgement
 * ```
 *
 * Two rules hold here, and they are the whole point:
 *
 *   - **No optimistic acknowledgement.** Nothing in this module writes a notice
 *     before Core has replied. If Core refuses, the notice says it refused. If
 *     Core is unreachable, the notice says that too. A command that looks
 *     accepted while Core is still deciding is a lie the user cannot check.
 *
 *   - **No cognition.** Submitting a command records it and stops. It does not
 *     ask a model anything, and the acknowledgement says so, because a user who
 *     is told a command was received will otherwise wait for a reply that is
 *     never coming.
 */

/** What the acknowledgement says, whichever way it went. */
export function acknowledgementFor(
  ok: boolean,
  reason: string,
  durableSequence?: number,
): string {
  if (!ok) return `Freya Core refused the command — ${reason}`
  const at = durableSequence === undefined ? '' : ` (event #${durableSequence})`
  return (
    `Freya Core received the command and recorded it${at}. ` +
    'Chat and cognition execution are not connected yet.'
  )
}

/**
 * Send a command to Core and report what it said.
 *
 * Resolves once the acknowledgement has been dispatched. Never rejects: a failed
 * command is a message, not an exception.
 */
export async function submitCommand(text: string, origin: string): Promise<boolean> {
  const value = text.trim()
  if (!value) return false
  try {
    const result = await coreMirror().submit('core.command.submit', { text: value, origin })
    shellStore.dispatch({
      type: 'command.acknowledged',
      ok: result.ok,
      detail: acknowledgementFor(
        result.ok,
        result.refusal?.reason ?? result.error?.message ?? 'no reason given',
        result.durableSequence,
      ),
      durableSequence: result.durableSequence,
    })
    return result.ok
  } catch (error: unknown) {
    shellStore.dispatch({
      type: 'command.acknowledged',
      ok: false,
      detail: `Freya Core could not be reached — ${
        error instanceof Error ? error.message : 'unknown error'
      }`,
    })
    return false
  }
}
