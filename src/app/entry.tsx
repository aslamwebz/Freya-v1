import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { PreferencesStore, type PreferenceStorage } from '../ui-v2/theme/preferences'
import { DressingStore } from './dressing/store'
import { createLiveAdapter } from '../ui-v2/state/live'
import type { UiAdapter } from '../ui-v2/state/contract'
import { attachAppOps } from './state/ops'
import { armAppWorkspace, loadAppLayout, setAppLayout, type AppLayout } from './state/workspace'
import { restoreConversationSelection } from '../platform/conversationClient'
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
 * The shipping app always projects the live adapter. A window without a Core
 * bridge shows unavailable resources instead of substituting design fixtures.
 */
const live = createLiveAdapter()
const adapter: UiAdapter = live
// Attaching is idempotent and window-scoped: the mirrors keep Core's subscription, and
// the first status arrives through them rather than being fetched here.
if (live) void live.attach()

// App Mode answers the host's closing-time layout request through the one workspace
// mechanism, so a close resolves immediately instead of waiting out the timeout.
armAppWorkspace()

const preferences = new PreferencesStore(storage)
const dressing = new DressingStore(storage)

/**
 * Restore the saved conversation before input becomes available. Cold launch still
 * lands on Home; opening Chat then shows the thread the owner last selected.
 */
async function start(): Promise<void> {
  let initialLayout: AppLayout | null = null
  if (live) {
    try {
      initialLayout = await loadAppLayout()
    } catch {
      initialLayout = null
    }
    if (initialLayout) setAppLayout(initialLayout)
    await restoreConversationSelection(initialLayout?.conversationId ?? null)
    void attachAppOps()
  }
  if (root === null) throw new Error('Freya: #root is missing from the document')
  createRoot(root).render(
    <StrictMode>
      <App preferences={preferences} dressing={dressing} adapter={adapter} initialLayout={initialLayout} />
    </StrictMode>,
  )
  // The static boot screen in index.html has covered the time before this
  // render. React has now committed the live BootScreen, so that cover is
  // removed here rather than left hiding a shell that failed to mount.
  document.getElementById('boot-static')?.remove()
}

void start()
