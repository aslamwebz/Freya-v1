import type { ResearchCommandOutcome } from '../../../core/protocol/core-protocol'

export type ComposerMode = 'chat' | 'deep-research' | 'eye'

export interface WorkspaceResearchView {
  mode: Exclude<ComposerMode, 'chat'>
  outcome: ResearchCommandOutcome
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
