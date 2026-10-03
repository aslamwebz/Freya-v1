import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { PreferencesStore, type PreferenceStorage } from '../ui-v2/theme/preferences'
import { DressingStore } from './dressing/store'
import { createPreviewAdapter } from '../ui-v2/state/preview'
import type { UiAdapter } from '../ui-v2/state/contract'
import '../ui-v2/theme/tokens.css'
import '../ui-v2/primitives/controls.css'
import './cards/cards.css'
import './dressing/dressing.css'
import './app.css'

/**
 * Design phase: the App renders the labelled preview fixtures so the composition
 * matches the reference while each screen is built. The live adapter stays behind
 * the same seam and is switched back on once the screens are done.
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
const dressing = new DressingStore(storage)
const adapter: UiAdapter = createPreviewAdapter()

createRoot(root).render(
  <StrictMode>
    <App preferences={preferences} dressing={dressing} adapter={adapter} />
  </StrictMode>,
)
