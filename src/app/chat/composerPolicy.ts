import type { TurnIntentHints } from '../../../core/mind/tool-intent'
import type { ComposerMode } from './modes'

/** Explicit off values must survive routing and transport to the execution gate. */
export function composerPolicy(mode: ComposerMode, hints?: TurnIntentHints): { mode: ComposerMode; intents: TurnIntentHints } {
  return { mode: hints?.webSearch === false && mode !== 'chat' ? 'chat' : mode, intents: { ...hints } }
}
