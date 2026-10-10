export type Destination = 'home' | 'chat' | 'missions' | 'library' | 'office' | 'settings'

export const PRIMARY_DESTINATIONS = [
  ['home', 'Home', 'home'], ['chat', 'Chats', 'chat'], ['missions', 'Missions', 'mission'],
  ['library', 'Library', 'memory'], ['office', 'Office', 'workforce'], ['settings', 'Settings', 'settings'],
] as const

export const MISSION_SECTIONS = ['goals', 'missions', 'runs', 'chats', 'files', 'heartbeat'] as const
export const LIBRARY_SECTIONS = ['mind', 'people', 'world', 'files', 'search'] as const
export const OFFICE_SECTIONS = ['agents', 'scene'] as const
export const SETTINGS_SECTIONS = ['appearance', 'provider', 'voice', 'privacy', 'spending', 'about'] as const
export const ADVANCED_SECTIONS = ['foundry', 'relay', 'harness', 'context', 'security', 'diagnostics'] as const

const aliases: Readonly<Record<string, string>> = {
  chats: 'chat', missions: 'missions/missions', goals: 'missions/goals', work: 'missions/runs', runs: 'missions/runs',
  library: 'library/mind', mind: 'library/mind', focus: 'library/mind/focus', memory: 'library/mind/memory',
  people: 'library/people', world: 'library/world', life: 'library/mind/memory', files: 'library/files', search: 'library/search',
  office: 'office/agents', workforce: 'office/agents', settings: 'settings/appearance',
  create: 'settings/advanced/foundry', foundry: 'settings/advanced/foundry', relay: 'settings/advanced/relay',
  harness: 'settings/advanced/harness', context: 'settings/advanced/context', security: 'settings/advanced/security', diagnostics: 'settings/advanced/diagnostics',
}
const valid = new Set<string>([
  'home', 'chat', ...MISSION_SECTIONS.map(id => `missions/${id}`),
  ...LIBRARY_SECTIONS.map(id => `library/${id}`), 'library/mind/focus', 'library/mind/memory',
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
