import { shellStore, useShell } from '../store'
import { openSurface } from '../surfaceActions'
import { Icon, type IconName } from '../icons'
import type { SurfaceType } from '../../core/surfaces/types'

interface NavItem {
  id: string
  label: string
  icon: IconName
  surface?: SurfaceType
}

const MAIN: NavItem[] = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'search', label: 'Search', icon: 'search', surface: 'search' },
  { id: 'work', label: 'Work', icon: 'work', surface: 'work' },
  { id: 'missions', label: 'Missions', icon: 'mission', surface: 'mission' },
  { id: 'vault', label: 'Vault', icon: 'vault', surface: 'vault' },
  { id: 'harness', label: 'Harness', icon: 'harness', surface: 'harness' },
  { id: 'foundry', label: 'Foundry', icon: 'foundry', surface: 'foundry' },
  { id: 'relay', label: 'Relay', icon: 'relay', surface: 'relay' },
  { id: 'team', label: 'Team', icon: 'team', surface: 'team' },
  { id: 'office', label: 'Office', icon: 'office', surface: 'office' },
]

const SYSTEM: NavItem[] = [
  { id: 'security', label: 'Security', icon: 'shield', surface: 'security' },
  { id: 'settings', label: 'Settings', icon: 'settings', surface: 'settings' },
]

export function Navigation() {
  const active = useShell((s) => s.nav)
  const runtime = useShell((s) => s.runtime)

  const select = (item: NavItem) => {
    shellStore.dispatch({ type: 'nav.select', section: item.id })
    if (item.surface) openSurface(item.surface)
  }

  return (
    <nav className="nav" aria-label="Freya systems">
      <ul className="nav-list">
        {MAIN.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              className="nav-item"
              aria-current={active === item.id ? 'page' : undefined}
              onClick={() => select(item)}
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
            </button>
          </li>
        ))}
      </ul>

      <ul className="nav-list nav-system">
        {SYSTEM.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              className="nav-item"
              aria-current={active === item.id ? 'page' : undefined}
              onClick={() => select(item)}
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
            </button>
          </li>
        ))}
      </ul>

      <div className="nav-foot">
        <div className="nav-foot-row">
          <b>Freya</b>
          <small>
            v{runtime.version} · {runtime.dev ? 'dev' : 'local'}
          </small>
        </div>
        <p className="nav-foot-note">Phase 0 · no cognition is running</p>
      </div>
    </nav>
  )
}
