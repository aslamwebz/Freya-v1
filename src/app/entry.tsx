import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { PreferencesStore, type PreferenceStorage } from '../ui-v2/theme/preferences'
import { DressingStore } from './dressing/store'
import { createPreviewAdapter } from '../ui-v2/state/preview'
import { createLiveAdapter, isElectron } from '../ui-v2/state/live'
import type { UiAdapter } from '../ui-v2/state/contract'
import '../ui-v2/theme/tokens.css'
import '../ui-v2/primitives/controls.css'
import './cards/cards.css'
import './chat/chat.css'
import './dressing/dressing.css'
import './screens/screens.css'
import './app.css'
import './shell-chrome.css'

let storage: PreferenceStorage | undefined
try {
  storage = window.localStorage
} catch {
  /* in-memory preferences remain available */
}
const root = document.getElementById('root')
if (!root) throw new Error('Freya: root element is missing')

/**
 * Which adapter this window gets, decided by *where* it runs — not by whether a bridge
 * happens to be present.
 *
 * A browser (`npm run dev`, a test, a build preview) has no Core and never will, so it
 * uses the preview fixtures, which are labelled as sample data everywhere they appear.
 *
 * An Electron `file://` window is a real desktop window. If its preload injected a
 * bridge, it projects Core; if the preload is missing or the bridge is absent, it still
 * uses the *live* adapter, which reports every resource `unavailable` with the reason
 * rather than silently falling back to sample data. A desktop window showing preview
 * fixtures would be the exact lie this seam exists to prevent — the composition would
 * look finished while every number in it was invented.
 */
const live = isElectron() ? createLiveAdapter() : null
const adapter: UiAdapter = live ?? createPreviewAdapter()
// Attaching is idempotent and window-scoped: the mirrors keep Core's subscription, and
// the first status arrives through them rather than being fetched here.
if (live) void live.attach()

const preferences = new PreferencesStore(storage)
const dressing = new DressingStore(storage)

createRoot(root).render(
  <StrictMode>
    <App preferences={preferences} dressing={dressing} adapter={adapter} />
  </StrictMode>,
)
