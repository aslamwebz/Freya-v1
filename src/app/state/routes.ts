export type Destination = 'home' | 'chat' | 'mind' | 'missions' | 'workflows' | 'world' | 'library' | 'office' | 'settings'

export const PRIMARY_DESTINATIONS = [
  ['home', 'Home', 'home'], ['chat', 'Chats', 'chat'], ['mind', 'Mind', 'mind'], ['missions', 'Missions', 'mission'],
  ['workflows', 'Workflows', 'widgets'], ['world', 'World', 'world'], ['library', 'Library', 'memory'], ['office', 'Office', 'workforce'], ['settings', 'Settings', 'settings'],
] as const

export const MIND_SECTIONS = ['overview', 'focus', 'memory', 'self'] as const
export const MISSION_SECTIONS = ['missions', 'goals', 'runs', 'activity'] as const
export const WORKFLOW_SECTIONS = ['tasks', 'running', 'scheduling', 'workflows'] as const
export const WORLD_SECTIONS = ['digest', 'events', 'tech', 'research', 'sources'] as const
export const LIBRARY_SECTIONS = ['knowledge', 'people', 'files', 'search'] as const
export const OFFICE_SECTIONS = ['scene', 'agents'] as const
export const SETTINGS_SECTIONS = ['appearance', 'provider', 'voice', 'privacy', 'security', 'spending', 'about'] as const
export const ADVANCED_SECTIONS = ['foundry', 'relay', 'harness', 'context', 'diagnostics'] as const

const aliases: Readonly<Record<string, string>> = {
  chats: 'chat', missions: 'missions/missions', goals: 'missions/goals', work: 'missions/runs', runs: 'missions/runs',
  mind: 'mind/overview', focus: 'mind/focus', memory: 'mind/memory', life: 'mind/memory',
  workflows: 'workflows/tasks',
  'library/mind': 'mind/overview', 'library/mind/focus': 'mind/focus', 'library/mind/memory': 'mind/memory',
  library: 'library/knowledge', people: 'library/people', world: 'world/digest', 'library/world': 'world/digest', files: 'library/files', search: 'library/search',
  activity: 'missions/activity', 'missions/chats': 'missions/missions', 'missions/files': 'missions/missions', 'missions/heartbeat': 'missions/missions',
  office: 'office/scene', workforce: 'office/agents', settings: 'settings/appearance',
  create: 'settings/advanced/foundry', foundry: 'settings/advanced/foundry', relay: 'settings/advanced/relay',
  harness: 'settings/advanced/harness', context: 'settings/advanced/context', security: 'settings/security', 'settings/advanced/security': 'settings/security', diagnostics: 'settings/advanced/diagnostics',
}
const valid = new Set<string>([
  'home', 'chat', ...MIND_SECTIONS.map(id => `mind/${id}`), ...MISSION_SECTIONS.map(id => `missions/${id}`), ...WORKFLOW_SECTIONS.map(id => `workflows/${id}`),
  ...LIBRARY_SECTIONS.map(id => `library/${id}`),
  ...WORLD_SECTIONS.map(id => `world/${id}`),
  ...OFFICE_SECTIONS.map(id => `office/${id}`), ...SETTINGS_SECTIONS.map(id => `settings/${id}`),
  ...ADVANCED_SECTIONS.map(id => `settings/advanced/${id}`),
])

/** One route vocabulary for navigation, old shortcuts and saved layout. */
export function resolveRoute(value: string): { path: string; destination: Destination; section: string } {
  const candidate = aliases[value] ?? value
  const path = valid.has(candidate) ? candidate : 'home'
  const [destination, ...parts] = path.split('/')
  return { path, destination: destination as Destination, section: parts.join('/') }
}
