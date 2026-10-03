import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { PreferencesStore, type PreferenceStorage } from '../ui-v2/theme/preferences'
import { createPreviewAdapter } from '../ui-v2/state/preview'
import { createLiveAdapter, isElectron } from '../ui-v2/state/live'
import type { UiAdapter } from '../ui-v2/state/contract'
import '../ui-v2/theme/tokens.css'
import '../ui-v2/primitives/controls.css'
import './cards/cards.css'
import './app.css'

/**
 * The App Mode entry.
 *
 * Same adapter rule as ui-v2: a browser (dev/test) has no Core and uses the
 * labelled preview fixtures; an Electron window uses the live adapter, which
 * reports every resource unavailable rather than falling back to sample data.
 */
let storage: PreferenceStorage | undefined
try {
  storage = window.localStorage
} catch {
  /* in-memory preferences remain available */
}
const root = document.getElementById('root')
if (!root) throw new Error('Freya: root element is missing')
const preferences = new PreferencesStore(storage)
const live = isElectron() ? createLiveAdapter() : null
const adapter: UiAdapter = live ?? createPreviewAdapter()
if (live) void live.attach()

createRoot(root).render(
  <StrictMode>
    <App preferences={preferences} adapter={adapter} />
  </StrictMode>,
)
