// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { ElectronFreyaBrowserPage } from '../../../electron/browser/freyaWindow'

vi.mock('electron', () => ({
  BrowserWindow: class {},
  WebContentsView: class {},
  session: { fromPartition: vi.fn() },
}))

describe('Electron browser audio follows visible dock ownership', () => {
  it('mutes and attempts to pause a page when hidden, and unmutes only in the foreground', async () => {
    const contents = {
      isDestroyed: vi.fn(() => false),
      setAudioMuted: vi.fn(),
      executeJavaScript: vi.fn(async (_script: string, _userGesture?: boolean) => undefined),
    }
    const view = { webContents: contents, setBounds: vi.fn() }
    const host = {
      isDestroyed: vi.fn(() => false),
      contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
    }
    const page = new ElectronFreyaBrowserPage(
      'audio-test', 'freya-public-audio-test',
      { hostWindow: () => host as never },
    )
    ;(page as unknown as { view?: unknown }).view = view

    page.setDock({ x: 0, y: 90, width: 840, height: 550 })
    expect(contents.setAudioMuted).toHaveBeenLastCalledWith(false)
    expect(host.contentView.addChildView).toHaveBeenCalledTimes(1)

    // Merely resizing the same visible tab must not temporarily mute it.
    contents.setAudioMuted.mockClear()
    page.setDock({ x: 0, y: 90, width: 900, height: 550 })
    expect(contents.setAudioMuted).not.toHaveBeenCalled()
    expect(host.contentView.addChildView).toHaveBeenCalledTimes(1)
    expect(view.setBounds).toHaveBeenCalledTimes(2)

    page.setDock(null)
    expect(contents.setAudioMuted).toHaveBeenLastCalledWith(true)
    expect(host.contentView.removeChildView).toHaveBeenCalledTimes(1)
    expect(contents.executeJavaScript).toHaveBeenCalledTimes(1)
    const pauseScript = contents.executeJavaScript.mock.calls[0]?.[0]
    expect(pauseScript).toContain('media.pause()')

    // A repeat background notification stays muted without issuing extra JS.
    page.setDock(null)
    expect(contents.setAudioMuted).toHaveBeenLastCalledWith(true)
    expect(contents.executeJavaScript).toHaveBeenCalledTimes(1)

    page.setDock({ x: 0, y: 90, width: 900, height: 550 })
    expect(contents.setAudioMuted).toHaveBeenLastCalledWith(false)
    expect(host.contentView.addChildView).toHaveBeenCalledTimes(2)
  })
})
