import { WORKSPACES, type WorkspaceId } from './catalog'
export interface ViewState {
  query: string; filter: string; selected: string; draft: string
  checked: readonly string[]
  pinned: readonly string[]
  replies: readonly { conversation: string; text: string }[]
  conversationDrafts: Readonly<Record<string, string>>
  concepts: readonly string[]
  presentation: 'graph' | 'list'
  visiblePanels: readonly string[]
  panelOrder: readonly string[]
}
export function createViews(): Record<WorkspaceId, ViewState> {
  const views = {} as Record<WorkspaceId, ViewState>
  for (const space of WORKSPACES) views[space.id] = {
    checked: space.id === 'home' ? ['beta'] : [], query: '', filter: 'All', selected: '', draft: '', pinned: [], replies: [], conversationDrafts: {}, concepts: [], presentation: 'graph',
    visiblePanels: space.id === 'home' ? ['focus', 'mission', 'attention', 'people', 'world', 'memory', 'workforce'] : [],
    panelOrder: space.id === 'home' ? ['focus', 'mission', 'attention', 'people', 'world', 'memory', 'workforce'] : [],
  }
  return views
}