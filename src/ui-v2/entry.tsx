import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { PreferencesStore, type PreferenceStorage } from './theme/preferences'
import { WindowsStore } from './windows/model'
import { createPreviewAdapter } from './state/preview'
import { createLiveAdapter, isElectron } from './state/live'
import type { UiAdapter } from './state/contract'
import './theme/tokens.css'
import './primitives/controls.css'
import './windows/windows.css'
import './shell.css'
import './home-motion.css'
let storage: PreferenceStorage | undefined
try { storage = window.localStorage } catch { /* In-memory settings remain available. */ }
const root = document.getElementById('root')
if (!root) throw new Error('Freya: root element is missing')
const preferences = new PreferencesStore(storage)
const windows = new WindowsStore({ width: Math.max(320, window.innerWidth - 180), height: Math.max(400, window.innerHeight - 240) }, storage)

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
 * rather than silently falling back to sample data. A desktop window that showed preview
 * fixtures would be the exact lie this phase exists to prevent.
 */
const live = isElectron() ? createLiveAdapter() : null
const adapter: UiAdapter = live ?? createPreviewAdapter()
// Attaching is idempotent and window-scoped: the mirrors keep Core's subscription, and
// the first status arrives through them rather than being fetched here.
if (live) void live.attach()

createRoot(root).render(<StrictMode><App preferences={preferences} windows={windows} adapter={adapter} /></StrictMode>)