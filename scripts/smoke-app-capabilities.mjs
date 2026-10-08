/* global window, document -- Browser globals inside Playwright renderer callbacks. */
import { _electron as electron } from 'playwright-core'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const root = resolve(import.meta.dirname, '..')
const profile = await mkdtemp(join(tmpdir(), 'freya-capabilities-app-'))
let app
try {
  const launchOptions = { args: [root, `--user-data-dir=${profile}`, '--freya-display=2'], env: { ...process.env, NODE_ENV: 'production', FREYA_E2E: '1', FREYA_E2E_ALLOW_MULTI_INSTANCE: '1', FREYA_ALLOW_LIVE_MODEL: '1', FREYA_ALLOW_WEB_SEARCH: '0', MINIMAX_API_KEY: 'offline-metadata-fixture', NANOGPT_API_KEY: '', OPENAI_API_KEY: '', BRAVE_SEARCH_API_KEY: '', LOCAL_MODEL_BASE_URL: 'http://127.0.0.1:11434/v1', LOCAL_MODEL_MODEL: 'test-local', FREYA_DEV_PROVIDER: '', FREYA_LOCAL_UNRESTRICTED: '0' } }
  app = await electron.launch(launchOptions)
  const page = await app.firstWindow()
  page.setDefaultTimeout(10000)
  await page.locator('[data-app-shell="app"][data-ui-mode="live"]').waitFor({ state: 'attached', timeout: 30000 })
  assert.equal(new URL(page.url()).searchParams.get('ui'), null, 'shipping App Mode, no older UI query')
  await page.getByRole('button', { name: 'Open your account menu' }).click()
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click()
  await page.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name: 'Provider', exact: true }).click()
  const selector = page.getByLabel('Conversation brain preferred provider')
  await selector.waitFor({ state: 'visible' })
  assert.equal(await selector.inputValue(), 'minimax')
  await selector.selectOption('nanogpt')
  await page.waitForFunction(() => document.querySelector('.st-capabilities .st-notice')?.textContent, { timeout: 10000 })
  const diagnostics = await page.evaluate(async () => { const notices = Array.from(document.querySelectorAll('.st-capabilities .st-notice')).map(element => element.textContent); try { const registry = await window.freyaHost.getCapabilitySettings(); return { notices, preferred: registry.chat.providers[0], methods: [typeof window.freyaHost.getCapabilitySettings, typeof window.freyaHost.setCapabilitySettings] } } catch (error) { return { notices, error: error.message } } })
  console.log(JSON.stringify(diagnostics))

  assert.deepEqual(diagnostics.notices, ['Preference saved. It applies to the next request.'])
  assert.equal(await selector.inputValue(), 'nanogpt')
  const stored = JSON.parse(await readFile(join(profile, 'capabilities.json'), 'utf8'))
  assert.equal(stored.preferences.chat[0], 'nanogpt')
  assert.equal(await page.evaluate(async () => (await window.freyaHost.getCapabilitySettings()).chat.providers[0]), 'nanogpt')
  await selector.selectOption('local')
  await page.waitForFunction(() => document.querySelector('[aria-label="Conversation brain preferred provider"]')?.value === 'local')
  await page.waitForFunction(() => document.querySelector('[aria-label="Choose model"]')?.textContent?.includes('test-local'))
  await selector.selectOption('nanogpt')
  await page.waitForFunction(() => document.querySelector('[aria-label="Conversation brain preferred provider"]')?.value === 'nanogpt')
  // NanoGPT is unconfigured in this fixture: the next saved provider is still Local.
  await page.waitForFunction(() => document.querySelector('[aria-label="Choose model"]')?.textContent?.includes('test-local'))
  await selector.selectOption('minimax')
  await page.waitForFunction(() => document.querySelector('[aria-label="Conversation brain preferred provider"]')?.value === 'minimax')
  await page.waitForFunction(() => document.querySelector('[aria-label="Choose model"]')?.textContent?.includes('MiniMax-M3'))
  await selector.selectOption('nanogpt')
  await page.waitForFunction(() => document.querySelector('[aria-label="Conversation brain preferred provider"]')?.value === 'nanogpt')
  await page.reload()
  await page.locator('[data-app-shell="app"][data-ui-mode="live"]').waitFor({ state: 'attached' })
  // Settings remains selected through the actual saved layout or is reopened explicitly.
  if (!await page.getByRole('navigation', { name: 'Settings categories' }).isVisible()) {
    await page.getByRole('button', { name: 'Open your account menu' }).click()
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click()
  }
  await page.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name: 'Provider', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('[aria-label="Conversation brain preferred provider"]')?.value === 'nanogpt')
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  await page.getByRole('button', { name: 'Choose model', exact: true }).click()
  await page.getByRole('button', { name: 'test-local Local small model', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Add MiniMax-M3 (MiniMax) to favorites', exact: true }).click()
  await page.getByRole('textbox', { name: 'Search models', exact: true }).fill('Local')
  assert.ok(await page.getByRole('button', { name: 'MiniMax-M3 MiniMax', exact: true }).isVisible(), 'favorite stays visible during provider search')
  await page.getByRole('button', { name: 'test-local Local small model', exact: true }).click()
  await page.waitForFunction(async () => (await window.freyaHost.coreStatus()).modelSelection?.providerId === 'local')
  await page.reload()
  await page.getByRole('button', { name: 'Choose model', exact: true }).waitFor()
  await page.waitForFunction(() => document.querySelector('[aria-label="Choose model"]')?.textContent?.includes('test-local'))
  await page.getByRole('button', { name: 'Choose model', exact: true }).click()
  await page.getByRole('button', { name: 'Remove MiniMax-M3 (MiniMax) from favorites', exact: true }).waitFor()
  assert.equal((await page.evaluate(async () => (await window.freyaHost.coreStatus()).sessionUsage)).calls, 0)
  await app.close()
  app = await electron.launch(launchOptions)
  const reopened = await app.firstWindow()
  reopened.setDefaultTimeout(10000)
  await reopened.locator('[data-app-shell="app"][data-ui-mode="live"]').waitFor({ state: 'attached', timeout: 30000 })
  assert.equal(await reopened.evaluate(async () => (await window.freyaHost.getCapabilitySettings()).chat.providers[0]), 'nanogpt')
  await reopened.getByRole('button', { name: 'Choose model', exact: true }).click()
  await reopened.getByRole('button', { name: 'Remove MiniMax-M3 (MiniMax) from favorites', exact: true }).waitFor()
  assert.equal((await reopened.evaluate(async () => (await window.freyaHost.coreStatus()).sessionUsage)).calls, 0)
  console.log('PASS current App Mode: preferences save through real IPC; defaults update immediately; all setup providers appear; favorites persist during search; preferences and favorites survive reload and full restart; explicit model/provider reaches Core; zero inference calls.')
} finally {
  await app?.close()
  assert.equal(dirname(profile), tmpdir())
  await rm(profile, { recursive: true, force: true })
}
