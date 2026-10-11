// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { App } from '../../../src/app/App'
import { DressingStore } from '../../../src/app/dressing/store'
import { PreferencesStore } from '../../../src/ui-v2/theme/preferences'
import { createPreviewAdapter } from '../../../src/ui-v2/state/preview'
import { ABSENT_BROWSER_STATE } from '../../../src/platform/browserClient'
import { resetConversationMirror } from '../../../src/platform/conversationClient'
import { sharedDockedBrowserStore } from '../../../src/app/chat/BrowserWorkspace'
import type { DockedTabOrigin } from '../../../src/app/chat/BrowserWorkspace'

// Keep the real App handoff and browser request consumer; replace only the large
// dashboard presentation so this test does not depend on unrelated 3D workspaces.
vi.mock('../../../src/app/screens/HomeDashboard', async () => {
  const { DockedBrowser } = await import('../../../src/app/chat/BrowserWorkspace')
  return { HomeDashboard: (props: {
    browserOpen: boolean; browserRequestedUrl: string | null;
    onBrowserOpenUrl: (url: string, origin: DockedTabOrigin) => void;
    onBrowserRequestedUrlHandled: () => void; onBrowserClose: () => void;
  }) => <>
    <button onClick={() => props.onBrowserOpenUrl('https://example.org/article', { kind: 'link', from: 'citation', ownerText: 'Find an article' })}>Open source</button>
    {props.browserOpen ? <DockedBrowser requestedUrl={props.browserRequestedUrl} onRequestedUrlHandled={props.onBrowserRequestedUrlHandled} onClose={props.onBrowserClose} /> : null}
  </> }
})
vi.mock('../../../src/app/voice/useVoiceDock', () => ({ useVoiceDock: () => ({ view: {}, press: () => {}, release: () => {} }) }))

afterEach(() => { cleanup(); resetConversationMirror(); sharedDockedBrowserStore().reset(); delete window.freyaHost })

it('opens one browser tab for one chat source click and preserves source provenance', async () => {
  const requests: unknown[] = []
  window.freyaHost = {
    isDesktop: true,
    browserState: async () => ABSENT_BROWSER_STATE,
    browserCommand: async (request: unknown) => { requests.push(request); return { ok: true, op: 'open', data: { tabId: `tab-${requests.length}` }, reason: null } },
    browserDock: async () => false,
  } as unknown as typeof window.freyaHost
  render(<App preferences={new PreferencesStore()} dressing={new DressingStore()} adapter={createPreviewAdapter()} />)
  fireEvent.click(screen.getByRole('button', { name: 'Open source' }))
  await waitFor(() => expect(screen.getByRole('complementary', { name: 'Browsed tabs workspace' })).toBeInTheDocument())
  expect(requests).toEqual([{ op: 'open', url: 'https://example.org/article', origin: { kind: 'link', from: 'citation', ownerText: 'Find an article' }, createdBy: 'user' }])
})
