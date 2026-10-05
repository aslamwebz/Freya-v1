import type { ResearchCommandOutcome } from '../../../core/protocol/core-protocol'

export type ComposerMode = 'chat' | 'deep-research' | 'eye'

export interface WorkspaceResearchView {
  mode: Exclude<ComposerMode, 'chat'>
  outcome: ResearchCommandOutcome
}

export type EyePromptRoute =
  | { kind: 'create'; text: string }
  | { kind: 'follow-up'; sessionId: string; text: string }

/**
 * Route an Eye composer prompt without guessing that ordinary verbs mean
 * "throw away the current search".
 *
 * Once a session exists, natural corrections stay on that session and Core's
 * patchFollowUp parser decides whether they are clear enough to apply. A new
 * session is created only when the owner says so explicitly.
 */
export function routeEyePrompt(activeSessionId: string | null, text: string): EyePromptRoute {
  const value = text.trim()
  if (activeSessionId === null) return { kind: 'create', text: value }

  const newSearchPrefixes = [
    /^(?:please\s+)?(?:start|begin)\s+(?:a\s+)?new\s+(?:search|eye)(?:\s*[:,-]\s*|\s+for\s+|\s+)/i,
    /^(?:please\s+)?new\s+(?:search|eye)(?:\s*[:,-]\s*|\s+for\s+|\s+)/i,
  ] as const

  for (const prefix of newSearchPrefixes) {
    const request = value.replace(prefix, '').trim()
    if (request !== value && request.length > 0) return { kind: 'create', text: request }
  }

  return { kind: 'follow-up', sessionId: activeSessionId, text: value }
}

export const COMPOSER_MODES: readonly {
  id: ComposerMode
  label: string
  shortLabel: string
  description: string
  icon: string
}[] = [
  {
    id: 'chat',
    label: 'Chat',
    shortLabel: 'Chat',
    description: 'Conversation and everyday work',
    icon: 'chat',
  },
  {
    id: 'deep-research',
    label: 'Deep Research',
    shortLabel: 'Research',
    description: 'Multi-angle research with sources',
    icon: 'mind',
  },
  {
    id: 'eye',
    label: "Freya's Eye",
    shortLabel: 'Eye',
    description: 'Find videos, images, files and sources',
    icon: 'focus',
  },
]
