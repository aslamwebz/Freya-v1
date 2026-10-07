// Live drive: open a visible Freya window on --freya-display, toggle the
// composer intent switches in the order the user asked, then send the
// "Badulla on ten Sri Lankan news sites" instruction. The window stays open
// afterwards so the user can watch every step land on their display.
//
// Pattern follows scripts/chat-onscreen-acceptance.mjs: a fresh Electron
// launched into a throwaway user-data dir, E2E keys and provider settings
// re-applied, so Core and the model are real, not mocks.
//
//   node scripts/badulla-live.mjs                  # display 1, throwaway profile
//   node scripts/badulla-live.mjs --keep-open      # leave the window open at the end
//   FREYA_DISPLAY=2 node scripts/badulla-live.mjs  # pick another monitor

import { _electron as electron } from 'playwright-core'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ARGS = process.argv.slice(2)
const KEEP_OPEN = ARGS.includes('--keep-open')
const DISPLAY = process.env.FREYA_DISPLAY ?? '1'
const SHOTS = resolve(ROOT, 'artifacts', 'badulla-live')
const PROFILE_DIR = await mkdtemp(join(tmpdir(), 'freya-badulla-live-'))

/* Provider + search settings, mirrored from chat-onscreen-acceptance.mjs. */
function acceptanceSettings() {
  const file = join(ROOT, 'artifacts', 'acceptance.env')
  const fromFile = existsSync(file)
    ? Object.fromEntries(
        readFileSync(file, 'utf8').split(/\r?\n/)
          .map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
          .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] }),
      )
    : {}
  let credential = fromFile.NANOGPT_API_KEY ?? process.env.NANOGPT_API_KEY ?? ''
  if (!credential) {
    try {
      credential = /^NANOGPT_API_KEY=(.+)$/m.exec(readFileSync(join(ROOT, '.env'), 'utf8'))?.[1]?.trim() ?? ''
    } catch { /* Optional local credentials file is absent. */ }
  }
  const read = (k, fb = '') => fromFile[k] ?? process.env[k] ?? fb
  return {
    NANOGPT_API_KEY: credential,
    NANOGPT_BASE_URL: read('NANOGPT_BASE_URL', 'https://nano-gpt.com/api/v1'),
    NANOGPT_MODEL: read('NANOGPT_MODEL'),
    FREYA_ALLOW_LIVE_MODEL: '1',
    FREYA_ALLOW_WEB_SEARCH: '1',
    FREYA_SEARXNG_URL: read('FREYA_SEARXNG_URL', 'http://127.0.0.1:8899'),
  }
}

const E2E_KEYS = {
  FREYA_E2E_CONVERSATION_KEY: Buffer.alloc(32, 0x5a).toString('base64'),
  FREYA_E2E_BRAIN_KEY: Buffer.alloc(32, 0x2b).toString('base64'),
  FREYA_E2E_MISSION_KEY: Buffer.alloc(32, 0x13).toString('base64'),
  FREYA_E2E_CONTEXT_KEY: Buffer.alloc(32, 0x47).toString('base64'),
  FREYA_E2E_PERSONALITY_KEY: Buffer.alloc(32, 0x7e).toString('base64'),
  FREYA_E2E_SKILL_KEY: Buffer.alloc(32, 0x39).toString('base64'),
  FREYA_E2E_FORGE_KEY: Buffer.alloc(32, 0x52).toString('base64'),
  FREYA_E2E_VAULT_KEY: Buffer.alloc(32, 0x61).toString('base64'),
}

const say = (m) => process.stdout.write(String(m) + '\n')
const shot = async (page, label) => {
  await mkdir(SHOTS, { recursive: true })
  const f = join(SHOTS, label + '.png')
  await page.screenshot({ path: f })
  say('  [shot] ' + f)
}

async function launch() {
  const app = await electron.launch({
    args: [ROOT, `--freya-display=${DISPLAY}`, `--user-data-dir=${PROFILE_DIR}`],
    cwd: ROOT,
    env: { ...process.env, ...acceptanceSettings(), NODE_ENV: 'production', FREYA_E2E: '1', FREYA_E2E_ALLOW_MULTI_INSTANCE: '1', ...E2E_KEYS },
  })
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.waitForSelector('.freya-v2.hd-viewport', { timeout: 60_000 })
  await page.waitForTimeout(2500)
  return { app, page }
}

async function expandRail(page) {
  const collapsed = await page.locator('.hd-rail').getAttribute('data-collapsed')
  if (collapsed !== null) {
    await page.locator('.hd-rail-toggle').click()
    await page.waitForTimeout(400)
  }
}

async function goToChat(page) {
  await page.locator('.chats-history-title').first().click()
  await page.waitForTimeout(900)
  await page.waitForSelector('form[aria-label="Freya composer"] textarea', { timeout: 20_000 })
}

async function checkSwitch(page, selector) {
  const pressed = await page.locator(selector).getAttribute('aria-pressed')
  const checked = await page.locator(selector).getAttribute('aria-checked')
  return pressed === 'true' || checked === 'true'
}

async function toggleSwitch(page, selector) {
  const before = await checkSwitch(page, selector)
  await page.locator(selector).click()
  await page.waitForTimeout(250)
  const after = await checkSwitch(page, selector)
  return { before, after }
}

async function main() {
  say('[badulla] display=' + DISPLAY + ' profile=' + PROFILE_DIR)
  const { app, page } = await launch()
  const problems = []
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message))
  page.on('console', (m) => { if (m.type() === 'error') problems.push('console: ' + m.text()) })

  try {
    /* 1. Make sure the rail is open and we are on the chat workspace. */
    await expandRail(page)
    await goToChat(page)
    await shot(page, '01-chat-ready')

    /* 2. Web search toggle: ON, then OFF. */
    const webSelector = '.hd-tool-search'
    const webOn = await toggleSwitch(page, webSelector)
    say('[badulla] web search: ' + webOn.before + ' -> ' + webOn.after)
    await shot(page, '02-web-search-on')
    const webOff = await toggleSwitch(page, webSelector)
    say('[badulla] web search: ' + webOff.before + ' -> ' + webOff.after)
    await shot(page, '03-web-search-off')

    /* 3. Browser use toggle: ON. */
    const browserSelector = '.hd-tool-browser'
    const browserOn = await toggleSwitch(page, browserSelector)
    say('[badulla] browser use: ' + browserOn.before + ' -> ' + browserOn.after)
    await shot(page, '04-browser-on')

    /* 4. The instruction. */
    const instruction = [
      'Open a browser tab for each of these ten Sri Lankan news sites and search',
      'for the latest "Badulla" news on each. For each site give me the top headline,',
      'the URL, and the publication date. Then, in the same screen, scroll each',
      'site to the bottom, click Contact, and share the newsroom address.',
      '',
      'Sites: dailynews.lk, dailymirror.lk, island.lk, sundaytimes.lk, adaderana.lk,',
      'hirunews.lk, newsfirst.lk, ft.lk, economynext.com, themorning.lk.',
    ].join(' ')
    const ta = page.locator('form[aria-label="Freya composer"] textarea')
    await ta.click()
    await ta.fill(instruction)
    await shot(page, '05-instruction-typed')

    /* 5. Send and let the turn run. */
    await page.locator('form[aria-label="Freya composer"] button[aria-label="Send message"]').click()
    await page.waitForTimeout(3000)
    await shot(page, '06-turn-running')

    /* 6. Wait up to ~90s for the thinking row to clear. */
    let settled = false
    for (let i = 0; i < 90; i++) {
      await page.waitForTimeout(1000)
      const live = await page.locator('.chats-turn[data-role="assistant"][aria-live]').count()
      if (live === 0) { settled = true; break }
    }
    say('[badulla] turn settled: ' + settled)
    await shot(page, '07-turn-done')

    /* 7. The issue drawer, if any. */
    const issueCount = await page.locator('.chats-issue').count()
    if (issueCount) {
      const txt = await page.locator('.chats-issue p').allInnerTexts()
      say('[badulla] issue drawer: ' + JSON.stringify(txt))
      await shot(page, '08-issue-drawer')
    }

    say('[badulla] done. problems=' + problems.length)
    if (problems.length) for (const p of problems.slice(0, 10)) say('  ' + p)

    if (!KEEP_OPEN) await app.close()
    else say('[badulla] window left open (--keep-open). Close it by hand.')
  } catch (err) {
    say('[badulla] FAIL ' + (err && err.stack ? err.stack : err))
    try { await shot(page, '99-fail') } catch { /* The page may already be closed. */ }
    if (!KEEP_OPEN) await app.close()
    process.exit(1)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
