import { useEffect } from 'react'
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

/**
 * The systems rail.
 *
 * Folds to icons. Every item already has its own icon, so the collapsed rail is
 * not a set of generic glyphs: each system keeps its own mark, and the label
 * moves to a tooltip and the accessible name rather than disappearing. A rail of
 * identical shapes would be a rail nobody can read.
 */
export function Navigation() {
  const active = useShell((s) => s.nav)
  const collapsed = useShell((s) => s.navCollapsed)
  const runtime = useShell((s) => s.runtime)

  // The grid track follows the rail, so folding it shifts the dashboard rather
  // than squeezing the panels. One source of truth: this state flag, applied as
  // an effect because writing to the DOM is not something render may do.
  useEffect(() => {
    const shell = document.querySelector<HTMLElement>('.shell')
    if (!shell) return
    if (collapsed) shell.style.setProperty('--rail', '60px')
    else shell.style.removeProperty('--rail')
  }, [collapsed])

  const select = (item: NavItem) => {
    shellStore.dispatch({ type: 'nav.select', section: item.id })
    if (item.surface) openSurface(item.surface)
  }

  return (
    <nav
      className="nav"
      data-collapsed={collapsed}
      aria-label="Freya systems"
    >
      <button
        type="button"
        className="nav-fold"
        aria-expanded={!collapsed}
        aria-label={collapsed ? 'Expand the systems rail' : 'Collapse the systems rail'}
        title={collapsed ? 'Expand the systems rail' : 'Collapse to icons'}
        onClick={() => shellStore.dispatch({ type: 'nav.collapse', collapsed: !collapsed })}
      >
        <Icon name={collapsed ? 'expand' : 'minus'} />
        {!collapsed ? <span>Collapse</span> : null}
      </button>
      <ul className="nav-list">
        {MAIN.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              className="nav-item"
              aria-current={active === item.id ? 'page' : undefined}
              // With the rail folded the label is not on screen, so the icon has
              // to carry the name itself.
              title={collapsed ? item.label : undefined}
              onClick={() => select(item)}
            >
              <Icon name={item.icon} />
              <span className="nav-label">{item.label}</span>
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
              title={collapsed ? item.label : undefined}
              onClick={() => select(item)}
            >
              <Icon name={item.icon} />
              <span className="nav-label">{item.label}</span>
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
        <p className="nav-foot-note">Core ready · no cognition is running</p>
      </div>
    </nav>
  )
}
