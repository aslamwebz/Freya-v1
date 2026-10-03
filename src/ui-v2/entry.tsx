import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { PreferencesStore, type PreferenceStorage } from './theme/preferences'
import { WindowsStore } from './windows/model'
import { createPreviewAdapter } from './state/preview'
import { createLiveAdapter, liveAvailable } from './state/live'
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
 * A window with a Core bridge projects the real thing; a browser does not.
 *
 * `npm run dev`, a test and a build preview have no bridge, so asking Core there would
 * leave the UI loading forever and read as broken. The preview fixtures exist for
 * exactly those cases, and they are labelled as sample data everywhere they appear.
 */
const live = liveAvailable() ? createLiveAdapter() : null
const adapter: UiAdapter = live ?? createPreviewAdapter()
// Attaching is idempotent and window-scoped: the mirrors keep Core's subscription, and
// the first status arrives through them rather than being fetched here.
if (live) void live.attach()

createRoot(root).render(<StrictMode><App preferences={preferences} windows={windows} adapter={adapter} /></StrictMode>)