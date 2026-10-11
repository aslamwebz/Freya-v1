import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright-core'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
/* global window, document -- evaluated inside the actual renderer by Playwright */

const root = resolve(import.meta.dirname, '..')
const evidence = join(root, 'artifacts', 'live-visible', 'desktop-shell')
await mkdir(evidence, { recursive: true })
const profile = await mkdtemp(join(tmpdir(), 'freya-desktop-shell-'))
const bootstrap = join(profile, 'bootstrap.cjs')
// Capture the actual native Tray object, with no replacement of its behavior.
// The product exposes no test globals or extra IPC endpoints.
await writeFile(bootstrap, `
const electron = require('electron');
global.__desktopTrays = [];
global.__desktopMenus = [];
global.__taskbarSkipped = new Map();
global.__desktopSubmissions = 0;
global.__writeQuitEvidence = value => require('node:fs').writeFileSync(${JSON.stringify(join(profile, 'quit.json'))}, JSON.stringify(value));
const capturedTray = new Proxy(electron.Tray, {
  construct(Target, args) {
    const tray = new Target(...args);
    const setContextMenu = tray.setContextMenu.bind(tray);
    tray.setContextMenu = menu => {
      global.__desktopMenus.push(menu);
      return setContextMenu(menu);
    };
    global.__desktopTrays.push(tray);
    return tray;
  }
});
const capturedWindow = new Proxy(electron.BrowserWindow, {
  construct(Target, args) {
    const window = new Target(...args);
    global.__taskbarSkipped.set(window.id, Boolean(args[0]?.skipTaskbar));
    const setSkipTaskbar = window.setSkipTaskbar.bind(window);
    window.setSkipTaskbar = skip => {
      setSkipTaskbar(skip);
      global.__taskbarSkipped.set(window.id, skip);
    };
    return window;
  }
});
const Module = require('node:module');
// Pause a real IPC request for the session/send race; release forwards it to
// the unchanged production handler and Core, without synthesizing responses.
const capturedIpc = new Proxy(electron.ipcMain, {
  get(target, key) {
    if (key !== 'handle') return target[key];
    return (channel, handler) => target.handle(channel, async (...args) => {
      if (channel === 'freya:core:submit') {
        if (args[1]?.command === 'conversation.turn.submit') global.__desktopSubmissions++;
        const hold = global.__desktopHold;
        if (hold && args[1]?.command === hold.command) {
          hold.entered = true;
          await hold.promise;
          global.__desktopHold = null;
        }
      }
      return handler(...args);
    });
  }
});
const load = Module._load;
Module._load = function(specifier, ...args) {
  if (specifier === 'electron') return new Proxy(electron, {
    get(target, key) { return key === 'Tray' ? capturedTray : key === 'BrowserWindow' ? capturedWindow : key === 'ipcMain' ? capturedIpc : target[key]; }
  });
  return load.call(this, specifier, ...args);
};
require(${JSON.stringify(join(root, 'dist-electron', 'main.cjs'))});
`)
// FREYA_LOCAL_UNRESTRICTED=0 is set explicitly to document the strict-path assumption at
// the call site, not as a workaround. Unpackaged builds also default to strict as of C1-A
// (electron/localUnrestricted.ts). FREYA_DEVICE_HANDS=0 and FREYA_PUBLIC_BROWSER=0 keep the
// browser seams off; this is a shell smoke, not a browser smoke.
const env = { ...process.env, FREYA_E2E: '1', FREYA_E2E_ALLOW_MULTI_INSTANCE: '0',
  FREYA_LOCAL_UNRESTRICTED: '0', FREYA_DEVICE_HANDS: '0', FREYA_PUBLIC_BROWSER: '0',
  FREYA_DEV_SERVER: '', FREYA_CONTEXT_WINDOW_OBSERVATION: '', FREYA_ALLOW_LIVE_MODEL: '0',
  FREYA_ALLOW_WEB_SEARCH: '0', NANOGPT_API_KEY: '', MINIMAX_API_KEY: '', OPENAI_API_KEY: '',
  LOCAL_MODEL_BASE_URL: '', BRAVE_SEARCH_API_KEY: '', NODE_ENV: 'production', FREYA_DEV_PROVIDER: 'echo' }
for (const [index, domain] of ['CONVERSATION', 'BRAIN', 'MISSION', 'CONTEXT', 'PERSONALITY', 'SKILL', 'FORGE', 'VAULT'].entries()) {
  env[`FREYA_E2E_${domain}_KEY`] = Buffer.alloc(32, index + 1).toString('base64')
}
const desktop = await electron.launch({ args: [bootstrap, `--user-data-dir=${profile}`, '--freya-display=1', '--freya-no-focus'], cwd: root, env })
const failures = []
desktop.process().stderr.on('data', data => failures.push(data.toString()))
let exited = false
desktop.process().on('exit', () => { exited = true })
try {
  const dashboard = await desktop.firstWindow()
  await dashboard.locator('.hd-dashboard').waitFor({ state: 'visible', timeout: 25000 })
  const orb = await dashboard.locator('.hd-presence').boundingBox()
  const baselineFile = join(evidence, 'baseline.json')
  if (process.argv.includes('--baseline')) {
    await writeFile(baselineFile, JSON.stringify(orb, null, 2))
    await dashboard.screenshot({ path: join(evidence, 'dashboard-before.png') })
    console.log('Baseline dashboard and orb bounds recorded.')
  } else {
    assert.equal(await desktop.evaluate(() => global.__desktopTrays.length), 1, 'one native tray exists')
    assert.equal(await desktop.evaluate(() => global.__desktopTrays[0].isDestroyed()), false)
    const trayBounds = await desktop.evaluate(() => global.__desktopTrays[0].getBounds())
    if (process.platform === 'win32') assert.ok(trayBounds.width > 0 && trayBounds.height > 0, 'Windows allocated native tray bounds')
    const labels = await desktop.evaluate(() => global.__desktopMenus.at(-1).items.map(item => item.label).filter(Boolean))
    assert.deepEqual(labels, ['Show Adult Freya', 'Open Dashboard', 'Quit Freya'])
    const clickMenu = async label => desktop.evaluate(({ BrowserWindow }, label) => {
      const item = global.__desktopMenus.at(-1).items.find(item => item.label === label)
      if (!item) throw new Error(`Missing tray action: ${label}`)
      item.click(item, BrowserWindow.getFocusedWindow(), {})
    }, label)
    assert.equal((await desktop.windows()).length, 1, 'no automatic animated companion')
    const chibi = dashboard.getByRole('img', { name: 'Chibi Freya — temporary placeholder' })
    assert.equal(await chibi.evaluate(img => img.complete && img.naturalWidth > 0), true, 'Chibi asset loads')
    const chibiBox = await chibi.boundingBox()
    assert.ok(chibiBox.x + chibiBox.width <= orb.x, 'Chibi stays left of orb')
    const baseline = await readFile(baselineFile, 'utf8').then(JSON.parse, error => {
      if (error.code !== 'ENOENT') throw error
      return null
    })
    if (baseline) assert.deepEqual(orb, baseline, 'orb bounds unchanged from before implementation')
    await dashboard.screenshot({ path: join(evidence, 'dashboard-after.png') })
    await desktop.evaluate(() => global.__desktopTrays[0].emit('click'))
    assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1, 'single tray click does not show Adult')
    const adultOpened = desktop.waitForEvent('window')
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => win.getTitle() === 'Freya').close())
    const adult = await adultOpened
    assert.ok(adult, 'closing dashboard automatically creates Adult window')
    const portrait = adult.getByRole('img', { name: 'Adult Freya' })
    await portrait.waitFor({ state: 'visible' })
    await portrait.evaluate(img => img.decode())
    assert.equal(await portrait.evaluate(img => img.naturalWidth > 0), true)
    assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => win.getTitle() === 'Freya').isVisible()), false, 'Adult mode hides dashboard')
    assert.equal(await desktop.evaluate(({ BrowserWindow }) => global.__taskbarSkipped.get(BrowserWindow.getAllWindows().find(win => win.getTitle() === 'Freya').id)), true, 'Adult mode removes dashboard taskbar entry')
    await adult.screenshot({ path: join(evidence, 'adult.png'), omitBackground: true })
    const adultId = await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => win.getTitle() === 'Adult Freya').id)
    assert.equal(await desktop.evaluate((_, id) => global.__taskbarSkipped.get(id), adultId), true, 'Adult always skips taskbar')
    assert.equal(await desktop.evaluate(({ BrowserWindow, screen }, id) => screen.getDisplayMatching(BrowserWindow.fromId(id).getBounds()).id === screen.getPrimaryDisplay().id, adultId), true, 'Adult stays on monitor 1')
    assert.equal(await desktop.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).isResizable() || BrowserWindow.fromId(id).isMovable(), adultId), false, 'Adult has no resizing or moving')
    assert.equal(await desktop.evaluate(() => global.__desktopMenus.at(-1).items[0].label), 'Hide Adult Freya', 'visible Adult offers right-click Hide')
    await clickMenu('Hide Adult Freya')
    assert.equal(await desktop.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).isVisible(), adultId), false, 'right-click Hide hides Adult')
    await desktop.evaluate(() => global.__desktopTrays[0].emit('click'))
    assert.equal(await desktop.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).isVisible(), adultId), false, 'single tray click preserves hidden Adult')
    await clickMenu('Show Adult Freya')
    await desktop.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).close(), adultId)
    assert.equal(await desktop.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).isVisible(), adultId), false, 'Adult close hides')
    await clickMenu('Show Adult Freya')
    assert.equal(await desktop.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).isVisible(), adultId), true, 'Adult menu restores')
    await desktop.evaluate(() => global.__desktopTrays[0].emit('click'))
    assert.equal(await desktop.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).isVisible(), adultId), true, 'single tray click preserves visible Adult')
    await desktop.evaluate(({ app }) => app.emit('second-instance'))
    assert.equal(await desktop.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).isVisible(), adultId), false, 'second launch selects dashboard and hides Adult')
    await clickMenu('Show Adult Freya')
    await promisify(execFile)(process.execPath, [join(root, 'bin', 'freya.mjs'), 'focus', '--json'], { env: { ...env, FREYA_USER_DATA: profile } })
    assert.equal(await desktop.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).isVisible(), adultId), false, 'existing control focus selects dashboard and hides Adult')
    await clickMenu('Open Dashboard')
    assert.equal(await desktop.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).isVisible(), adultId), false, 'dashboard mode hides Adult image')
    await dashboard.getByRole('button', { name: 'Home', exact: true }).click()
    const dashboardId = await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => win.getTitle() === 'Freya').id)
    assert.equal(await desktop.evaluate((_, id) => global.__taskbarSkipped.get(id), dashboardId), false, 'dashboard mode restores taskbar entry')
    await desktop.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).close(), dashboardId)
    await new Promise(resolve => setTimeout(resolve, 700))
    assert.equal(await desktop.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).isVisible(), dashboardId), false, 'dashboard close hides')
    assert.equal(await desktop.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).isVisible(), adultId), true, 'closing dashboard shows existing Adult')
    await desktop.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).close(), adultId)
    assert.equal(await desktop.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).isVisible(), adultId), false, 'both windows are hidden together')
    assert.equal(exited, false, 'process survives both window closes')
    assert.equal(await desktop.evaluate(() => global.__desktopTrays[0].isDestroyed()), false, 'tray survives with both windows hidden')
    await clickMenu('Open Dashboard')
    assert.equal(await desktop.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).isVisible(), dashboardId), true, 'dashboard menu restores same window')
    await dashboard.getByRole('button', { name: 'Mind', exact: true }).click()
    assert.equal(await dashboard.locator('.hd-dashboard').getAttribute('data-screen'), 'mind', 'dashboard navigation works')
    await desktop.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).close(), dashboardId)
    await clickMenu('Open Dashboard')
    assert.equal(await dashboard.locator('.hd-dashboard').getAttribute('data-screen'), 'mind', 'close/restore retains dashboard state')
    await dashboard.getByRole('button', { name: 'Home', exact: true }).click()
    assert.deepEqual(await dashboard.locator('.hd-presence').boundingBox(), orb, 'restoring dashboard preserves orb geometry')
    await clickMenu('Show Adult Freya')
    assert.equal(await desktop.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).isVisible(), dashboardId), false, 'switching to existing Adult hides dashboard')
    await clickMenu('Open Dashboard')
    assert.equal(await desktop.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).isVisible(), adultId), false, 'repeated dashboard switch hides Adult')
    await desktop.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).minimize(), dashboardId)
    await clickMenu('Open Dashboard')
    assert.equal(await desktop.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).isMinimized(), dashboardId), false, 'minimized dashboard restores')
    assert.equal((await desktop.windows()).length, 2, 'exactly two windows after repeated actions')
    // Switch back before a newly created Adult renderer is ready. Its load
    // completion must not show it over the selected dashboard mode.
    const replacementOpened = desktop.waitForEvent('window')
    await desktop.evaluate(({ app, BrowserWindow }, id) => {
      BrowserWindow.fromId(id).destroy()
      global.__adultReady = new Promise(resolve => app.once('browser-window-created', (_, window) => window.once('ready-to-show', () => resolve())))
      global.__desktopMenus.at(-1).items.find(item => item.label === 'Show Adult Freya').click()
      const item = global.__desktopMenus.at(-1).items.find(item => item.label === 'Open Dashboard')
      item.click(item, null, {})
    }, adultId)
    const replacement = await replacementOpened
    await replacement.getByRole('img', { name: 'Adult Freya' }).evaluate(img => img.decode())
    await desktop.evaluate(() => global.__adultReady)
    assert.deepEqual(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({ title: window.getTitle(), visible: window.isVisible() })).sort((a, b) => a.title.localeCompare(b.title))), [
      { title: 'Adult Freya', visible: false }, { title: 'Freya', visible: true },
    ], 'late Adult ready-to-show respects dashboard mode')
    // Home's existing style hides this entry point. Exercise the retained
    // modal state through its existing React handler without changing styling.
    await dashboard.getByRole('button', { name: 'Dressing table', exact: true, includeHidden: true }).evaluate(button => button.click())
    await dashboard.getByRole('dialog', { name: 'Dressing table', exact: true }).waitFor({ state: 'visible' })
    await desktop.evaluate(() => global.__desktopTrays[0].emit('double-click'))
    await dashboard.waitForFunction(() => window.innerHeight < 200)
    const miniWindow = await desktop.evaluate(({ BrowserWindow }, id) => {
      const window = BrowserWindow.fromId(id)
      return { bounds: window.getBounds(), fullscreen: window.isFullScreen(), maximized: window.isMaximized(), resizable: window.isResizable(), minimum: window.getMinimumSize() }
    }, dashboardId)
    assert.ok(miniWindow.bounds.height < 200, 'double-click opens only a compact chat bar')
    assert.equal(miniWindow.resizable, false, 'mini bar has no resizing controls')
    assert.equal(await desktop.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).isAlwaysOnTop(), dashboardId), false, 'mini chat does not stay above other windows')
    assert.equal(await desktop.evaluate(({ BrowserWindow, screen }, id) => screen.getDisplayMatching(BrowserWindow.fromId(id).getBounds()).id === screen.getPrimaryDisplay().id, dashboardId), true, 'mini bar stays on monitor 1')
    assert.equal(await desktop.evaluate((_, id) => global.__taskbarSkipped.get(id), dashboardId), true, 'mini bar stays out of taskbar')
    await dashboard.locator('[data-desktop-view="mini-chat"]').waitFor({ state: 'visible' })
    assert.equal(await dashboard.locator('.hd-top').isVisible(), false, 'mini chat hides dashboard chrome')
    assert.equal(await dashboard.getByRole('dialog', { name: 'Dressing table', exact: true }).isVisible(), false, 'existing dialog does not cover mini chat')
    assert.equal(await dashboard.getByRole('textbox', { name: 'Ask Freya' }).isVisible(), true, 'mini chat reuses existing composer')
    const sessionSelector = dashboard.getByRole('combobox', { name: 'Chat session', exact: true })
    await sessionSelector.waitFor({ state: 'visible' })
    let originalSession = await sessionSelector.inputValue()
    if (!originalSession) {
      assert.equal(await sessionSelector.locator('option').first().textContent(), 'Select a session', 'empty history does not create a session automatically')
      await dashboard.getByRole('button', { name: 'New session', exact: true }).click()
      await dashboard.waitForFunction(() => Boolean(document.querySelector('select[aria-label="Chat session"]')?.value))
      originalSession = await sessionSelector.inputValue()
    }
    assert.ok(originalSession, 'selector shows the active session')
    await dashboard.getByRole('textbox', { name: 'Ask Freya' }).fill('Saved mini session draft')
    await dashboard.getByRole('button', { name: 'New session', exact: true }).click()
    await dashboard.waitForFunction(previous => document.querySelector('select[aria-label="Chat session"]')?.value !== previous, originalSession)
    const newSession = await sessionSelector.inputValue()
    assert.ok(newSession && newSession !== originalSession, 'New session creates a different session')
    assert.equal(await dashboard.getByRole('textbox', { name: 'Ask Freya' }).inputValue(), '', 'new session has an empty draft')
    await dashboard.getByRole('textbox', { name: 'Ask Freya' }).fill('New mini session draft')
    await desktop.evaluate(() => {
      global.__desktopHold = { command: 'conversation.read', entered: false }
      global.__desktopHold.promise = new Promise(resolve => { global.__desktopHold.release = resolve })
    })
    await sessionSelector.selectOption(originalSession)
    await dashboard.waitForFunction(() => document.querySelector('select[aria-label="Chat session"]')?.disabled === true)
    assert.equal(await desktop.evaluate(() => global.__desktopHold.entered), true, 'real session read is pending')
    assert.equal(await dashboard.getByRole('button', { name: 'Send message', exact: true }).isDisabled(), true, 'pending session switch disables Send')
    const submissions = await desktop.evaluate(() => global.__desktopSubmissions)
    await dashboard.getByRole('form', { name: 'Freya composer' }).evaluate(form => form.requestSubmit())
    assert.equal(await desktop.evaluate(() => global.__desktopSubmissions), submissions, 'pending switch cannot submit into old session')
    await desktop.evaluate(() => global.__desktopHold.release())
    await dashboard.waitForFunction(() => document.querySelector('textarea[aria-label="Ask Freya"]')?.value === 'Saved mini session draft')
    await sessionSelector.selectOption(newSession)
    await dashboard.waitForFunction(() => document.querySelector('textarea[aria-label="Ask Freya"]')?.value === 'New mini session draft')
    await dashboard.getByRole('textbox', { name: 'Ask Freya' }).fill('')
    await dashboard.getByRole('textbox', { name: 'Ask Freya' }).evaluate(input => {
      const event = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      event.preventDefault()
      input.dispatchEvent(event)
    })
    assert.equal(await desktop.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).isVisible(), dashboardId), true, 'handled Escape preserves mini bar')
    await dashboard.screenshot({ path: join(evidence, 'mini-chat.png') })
    await dashboard.getByRole('textbox', { name: 'Ask Freya' }).fill('Mini chat draft')
    await clickMenu('Open Dashboard')
    await dashboard.locator('[data-desktop-view="dashboard"]').waitFor({ state: 'visible' })
    await dashboard.getByRole('button', { name: 'Close the dressing table', exact: true }).click()
    assert.equal(await dashboard.getByRole('textbox', { name: 'Ask Freya' }).inputValue(), 'Mini chat draft', 'mini bar and dashboard share composer state')
    await dashboard.getByRole('textbox', { name: 'Ask Freya' }).fill('')
    assert.equal(await desktop.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).isFullScreen(), dashboardId), true, 'full dashboard restores after mini bar')
    assert.deepEqual(await dashboard.locator('.hd-presence').boundingBox(), orb, 'mini bar restore leaves orb unchanged')
    await desktop.evaluate(() => global.__desktopTrays[0].emit('double-click'))
    await dashboard.waitForFunction(() => window.innerHeight < 200)
    await dashboard.getByRole('textbox', { name: 'Ask Freya' }).fill('Mini bar acceptance message')
    await desktop.evaluate(() => {
      global.__desktopHold = { command: 'conversation.turn.submit', entered: false }
      global.__desktopHold.promise = new Promise(resolve => { global.__desktopHold.release = resolve })
    })
    await dashboard.getByRole('button', { name: 'Send message', exact: true }).click()
    assert.equal(await sessionSelector.isDisabled(), true, 'submitting disables session selection before Core projection arrives')
    assert.equal(await dashboard.getByRole('button', { name: 'New session', exact: true }).isDisabled(), true, 'submitting disables New session')
    await desktop.evaluate(() => global.__desktopHold.release())
    await dashboard.waitForFunction(() => document.querySelector('textarea[aria-label="Ask Freya"]')?.value === '')
    await dashboard.getByRole('textbox', { name: 'Ask Freya' }).press('Escape')
    assert.equal(await desktop.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).isVisible(), dashboardId), false, 'Escape hides mini bar')
    assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.getTitle() === 'Adult Freya').isVisible()), true, 'dismissing mini bar shows Adult')
    await clickMenu('Hide Adult Freya')
    await desktop.evaluate(() => global.__desktopTrays[0].emit('double-click'))
    await dashboard.waitForFunction(() => window.innerHeight < 200)
    assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.getTitle() === 'Adult Freya').isVisible()), false, 'mini bar preserves explicitly hidden Adult')
    assert.equal(await sessionSelector.inputValue(), newSession, 'reopening mini bar retains selected session')
    await dashboard.getByRole('button', { name: 'Close mini chat', exact: true }).click()
    assert.equal(await desktop.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).isVisible(), dashboardId), false, 'close button hides mini chat')
    assert.equal(await desktop.evaluate(() => global.__desktopTrays[0].isDestroyed()), false, 'close button preserves tray')
    await clickMenu('Open Dashboard')
    await dashboard.locator('[data-desktop-view="dashboard"]').waitFor({ state: 'visible' })
    if (await dashboard.locator('.hd-dashboard').getAttribute('data-screen') !== 'chat') {
      await dashboard.getByRole('button', { name: 'Open Chats', exact: true }).click()
    }
    await dashboard.getByText('Mini bar acceptance message', { exact: true }).first().waitFor({ state: 'visible' })
    await dashboard.getByText(/developer echo provider/).first().waitFor({ state: 'visible' })
    await dashboard.getByRole('button', { name: 'Home', exact: true }).click()
    await desktop.evaluate(() => {
      const tray = global.__desktopTrays[0]
      tray.emit('double-click')
      global.__desktopMenus.at(-1).items.find(item => item.label === 'Open Dashboard').click()
      tray.emit('double-click')
    })
    await dashboard.waitForFunction(() => window.innerHeight < 200)
    await dashboard.waitForTimeout(150)
    assert.ok(await desktop.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).getBounds().height < 200, dashboardId), 'rapid mini/dashboard/mini ends in compact bar')
    await clickMenu('Open Dashboard')
    if (process.argv.includes('--pause')) {
      await writeFile(join(evidence, 'ready.json'), JSON.stringify({ pid: desktop.process().pid, profile }))
      console.log('Paused for native tray inspection; create continue.txt in evidence directory to continue.')
      for (let attempt = 0; attempt < 240; attempt++) {
        if (await readFile(join(evidence, 'continue.txt')).then(() => true, () => false)) break
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
    }
    const closed = new Promise(resolve => desktop.process().once('exit', code => resolve(code)))
    await desktop.evaluate(({ app, BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(win => win.getTitle() === 'Freya')
      const send = window.webContents.send.bind(window.webContents)
      let collections = 0
      window.webContents.send = (channel, ...args) => {
        if (channel === 'freya:workspace:collect') collections++
        return send(channel, ...args)
      }
      app.once('will-quit', () => global.__writeQuitEvidence({ collections }))
      const item = global.__desktopMenus.at(-1).items.find(item => item.label === 'Quit Freya')
      item.click(item, window, {})
      item.click(item, window, {})
    })
    const code = await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error('Quit timed out')), 15000))])
    assert.equal(code, 0, 'Quit exits cleanly')
    assert.deepEqual(JSON.parse(await readFile(join(profile, 'quit.json'), 'utf8')), { collections: 1 }, 'repeated Quit uses one shutdown collection')
    await writeFile(join(evidence, 'results.json'), JSON.stringify({ passed: true, nativeMouseVerified: false, taskbarAppearanceManuallyVerified: false, baselineChecked: baseline !== null, trayBounds, profile, checks: ['native tray/menu', 'dashboard close shows Adult', 'right-click Show/Hide Adult', 'single click preserves Adult visibility', 'double-click opens mini chat', 'mini bar composer sends into existing conversation', 'Escape dismisses mini bar', 'mini bar preserves hidden Adult', 'mini bar restores full dashboard and draft', 'native taskbar API options', 'Adult loads', 'Chibi loads', 'orb geometry unchanged', 'both windows hide together', 'restore/focus', 'dashboard state retained', 'navigation', 'clean quit'] }, null, 2))
    console.log('PASS: real Electron tray, mini chat, images, lifecycle, unchanged orb, and clean Quit.')
  }
} catch (error) {
  console.error(failures.join('').slice(-4000))
  throw error
} finally {
  if (!exited) await desktop.close()
}
