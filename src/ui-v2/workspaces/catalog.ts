export const WORKSPACES = [
  { id: 'home', label: 'Home', symbol: 'home', description: 'A little clarity. A wider possibility.' },
  { id: 'mind', label: 'Mind', symbol: 'mind', description: 'Understand the moment. See what matters.' },
  { id: 'mission', label: 'Mission', symbol: 'mission', description: 'From intention to meaningful progress.' },
  { id: 'forge', label: 'Forge', symbol: 'forge', description: 'From possibility to capability.' },
  { id: 'world', label: 'World', symbol: 'world', description: 'A more connected world.' },
  { id: 'life', label: 'Life', symbol: 'life', description: 'A record of experience, connection and growth.' },
  { id: 'relay', label: 'Relay', symbol: 'relay', description: 'People at the centre of progress.' },
  { id: 'workforce', label: 'Workforce', symbol: 'workforce', description: 'People, ideas and execution in alignment.' },
  { id: 'widgets', label: 'Widgets', symbol: 'widgets', description: 'Keep what matters close.' },
  { id: 'brain-core', label: 'Brain / Core', symbol: 'core', description: 'The connections behind the intelligence.' },
] as const
export type WorkspaceId = (typeof WORKSPACES)[number]['id']
export function isWorkspaceId(value: unknown): value is WorkspaceId {
  return WORKSPACES.some((space) => space.id === value)
}
export function workspaceLabel(id: WorkspaceId): string {
  return WORKSPACES.find((space) => space.id === id)?.label ?? id
}
