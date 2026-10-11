// Live randomized UI test for Freya Chat. Drives the running app on monitor 1.
// Randomizes queries, types of media requested, and exercises the two new
// composer intent buttons.
import { _electron as electron } from 'playwright-core'
import { existsSync, readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(process.cwd())
const SHOTS = join(ROOT, 'artifacts', 'chat-random')
await (await import('node:fs/promises')).mkdir(SHOTS, { recursive: true })

const file = join(ROOT, 'artifacts', 'acceptance.env')
const fromFile = existsSync(file)
  ? Object.fromEntries(readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#')).map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] }))
  : {}
const key = fromFile.NANOGPT_API_KEY ?? /^NANOGPT_API_KEY=(.+)$/m.exec(readFileSync(join(ROOT, '.env'), 'utf8'))?.[1] ?? ''
const profileDir = mkdtempSync(join(tmpdir(), 'freya-random-'))

const app = await electron.launch({
  args: [ROOT, '--freya-display=1', `--user-data-dir=${profileDir}`],
  env: {
    ...process.env,
    NANOGPT_API_KEY: key,
    NANOGPT_BASE_URL: 'https://nano-gpt.com/api/v1',
    NANOGPT_MODEL: 'qwen/qwen3.8-27b-uncensored',
    FREYA_ALLOW_LIVE_MODEL: '1',
    FREYA_ALLOW_WEB_SEARCH: '1',
    FREYA_SEARXNG_URL: 'http://127.0.0.1:8899',
    // FREYA_LOCAL_UNRESTRICTED=0 documents the strict path at the call site.
    // Unpackaged builds default to strict as of C1-A. This run is a chat prompt
    // smoke and does not exercise the docked browser; the explicit assignment is
    // a record, not a workaround.
    FREYA_LOCAL_UNRESTRICTED: '0',
    FREYA_E2E: '1',
    FREYA_E2E_ALLOW_MULTI_INSTANCE: '1',
    FREYA_E2E_CONVERSATION_KEY: Buffer.alloc(32, 0x5a).toString('base64'),
    FREYA_E2E_BRAIN_KEY: Buffer.alloc(32, 0x2b).toString('base64'),
    FREYA_E2E_MISSION_KEY: Buffer.alloc(32, 0x13).toString('base64'),
    FREYA_E2E_CONTEXT_KEY: Buffer.alloc(32, 0x47).toString('base64'),
    FREYA_E2E_PERSONALITY_KEY: Buffer.alloc(32, 0x7e).toString('base64'),
    FREYA_E2E_SKILL_KEY: Buffer.alloc(32, 0x39).toString('base64'),
    FREYA_E2E_FORGE_KEY: Buffer.alloc(32, 0x52).toString('base64'),
    FREYA_E2E_VAULT_KEY: Buffer.alloc(32, 0x61).toString('base64'),
  },
})

const page = await app.firstWindow()
await page.waitForSelector('.freya-v2.hd-viewport', { timeout: 60_000 })

// Real randomized pools, each picked independently. The user wanted varied
// natural prompts rather than hardcoded "laravel queue" anything.
const SUBJECTS = [
  'saturn at opposition',
  'a future electric truck',
  'the Apollo 11 landing site',
  'aurochs',
  'Mars meteorology',
  'a Berlin history book',
  'Soviet spaceflight',
  'Bach Goldberg Variations',
  'the Voynich manuscript',
  'Permian extinction',
  'a hiking trail in northern Patagonia',
  'raku ceramics',
  'the Petronas towers',
  'neural architecture search',
  'Antikythera mechanism',
  'hurricane structure from orbit',
]
const ADJ = ['a few', 'five', 'several', 'ten']

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)] }

const q = (kind) => {
  const s = pick(SUBJECTS)
  const a = pick(ADJ)
  if (kind === 'image') return `show me ${a} pictures of ${s}`
  if (kind === 'video') return `find videos about ${s}`
  if (kind === 'doc') return `find an official PDF about ${s}`
  if (kind === 'web') return `look up the latest on ${s}`
  return `${s}`
}

const results = []
function check(name, ok, detail = '') {
  results.push({ name, passed: Boolean(ok), detail: String(detail) })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

let step = 0
const shot = async (name) => { await page.screenshot({ path: join(SHOTS, `${String(step).padStart(2,'0')}-${name}.png`) }); step++ }
const settled = async () => page.evaluate(() => [...document.querySelectorAll('.chats-turn[data-role="assistant"]')].filter(r => !r.querySelector('.chats-live-label')).map(r => r.querySelector('.chats-bubble')?.textContent ?? ''))
const waitIdle = async (ms = 600_000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const ok = await page.evaluate(() => !document.querySelector('.chats-live-label') && document.querySelector('.hd-dock')?.getAttribute('data-state') !== 'responding')
    if (ok) return
    await page.waitForTimeout(500)
  }
  throw new Error('timeout waiting for turn to settle')
}

async function freshChat() {
  await page.locator('.hd-place[aria-label="Home"]').click().catch(() => {})
  await page.waitForFunction(() => document.querySelector('.hd-dashboard')?.getAttribute('data-screen') === 'home', { timeout: 10_000 }).catch(() => {})
  await page.locator('.chats-history-title').click()
  await page.waitForFunction(() => document.querySelector('.hd-dashboard')?.getAttribute('data-screen') === 'chat', { timeout: 10_000 })
  await page.waitForSelector('.chats-empty-state', { timeout: 10_000 }).catch(() => {})
}

async function ask(text, { useWebButton = false, useBrowserButton = false } = {}) {
  console.log(`\n>>> ${text}`)
  if (useWebButton) {
    await page.locator('button[aria-label*="web search"], button[aria-label*="Web search"]').click()
    await page.waitForTimeout(150)
  }
  if (useBrowserButton) {
    await page.locator('button[aria-label*="browser use"], button[aria-label*="Browser use"]').click()
    await page.waitForTimeout(150)
  }
  await page.locator('form[aria-label="Freya composer"] textarea').fill(text)
  await page.locator('form[aria-label="Freya composer"] button[aria-label="Send message"]').click()
  await waitIdle()
  const ans = (await settled()).at(-1) ?? ''
  console.log(`<<< ${ans.slice(0, 250).replace(/\s+/g, ' ')}`)
  return ans
}

async function mediaState() {
  return page.evaluate(() => ({
    tiles: document.querySelectorAll('.chats-image-tile').length,
    videos: document.querySelectorAll('.chats-video-card').length,
    docs: document.querySelectorAll('.chats-doc-card').length,
    sources: [...document.querySelectorAll('.chats-sources a, .chats-sources button')].length,
  }))
}

try {
  await page.waitForFunction(() => document.querySelector('.hd-dashboard')?.getAttribute('data-screen') === 'home', { timeout: 20_000 })
  await page.locator('.chats-history-title').click()
  await page.waitForFunction(() => document.querySelector('.hd-dashboard')?.getAttribute('data-screen') === 'chat', { timeout: 20_000 })
  await page.waitForSelector('.chats-empty-state', { timeout: 10_000 })

  // Section 1: verify the new composer has BOTH buttons (web search + browser use).
  const buttons = await page.evaluate(() => ({
    webSearch: !!document.querySelector('button[aria-label*="web search"], button[aria-label*="Web search"]'),
    browserUse: !!document.querySelector('button[aria-label*="browser use"], button[aria-label*="Browser use"]'),
    oldBrowserToggle: !!document.querySelector('button[aria-label*="browser workspace"]'),
  }))
  check('the composer has a Web search button', buttons.webSearch)
  check('the composer has a Browser use button', buttons.browserUse)
  check('the old free-floating browser toggle is gone', !buttons.oldBrowserToggle,
    'no "browser workspace" toggle in the composer anymore')

  // Section 2: a randomized image request through the plain composer.
  await freshChat()
  const imgPrompt = q('image')
  await ask(imgPrompt)
  const ms2 = await mediaState()
  check('image tiles appeared from a live SearXNG response', ms2.tiles > 0,
    `tiles=${ms2.tiles} query="${imgPrompt}"`)
  await shot('image-result')

  // Section 3: a randomized video request through the Web search button.
  await freshChat()
  const vidPrompt = q('video')
  await ask(vidPrompt, { useWebButton: true })
  const ms3 = await mediaState()
  check('video cards appeared when Web search was on', ms3.videos > 0,
    `cards=${ms3.videos} query="${vidPrompt}"`)
  await shot('video-result')

  // Section 4: a randomized document request through the Web search button.
  await freshChat()
  const docPrompt = q('doc')
  await ask(docPrompt, { useWebButton: true })
  const ms4 = await mediaState()
  check('document cards appeared when Web search was on', ms4.docs > 0,
    `cards=${ms4.docs} query="${docPrompt}"`)
  await shot('doc-result')

  // Section 5: a randomized plain web lookup WITHOUT the button.
  await freshChat()
  const plainPrompt = q('web')
  await ask(plainPrompt)
  const ans5 = (await settled()).at(-1) ?? ''
  check('a plain web lookup still answers without needing the button', ans5.trim().length > 30,
    `answer length=${ans5.length}`)
  await shot('plain-result')

  // Section 6: another randomized image request this time with BOTH intents.
  await freshChat()
  const bothPrompt = q('image')
  await ask(bothPrompt, { useWebButton: true, useBrowserButton: true })
  const ms6 = await mediaState()
  check('composing both intents still draws images from search', ms6.tiles > 0,
    `tiles=${ms6.tiles}`)
  await shot('both-result')

  // Section 7: tapping a button then tapping it again drops the directive.
  await freshChat()
  await page.locator('button[aria-label*="web search"], button[aria-label*="Web search"]').click()
  const pressed = await page.evaluate(() => document.querySelector('button[aria-label*="web search"], button[aria-label*="Web search"]')?.getAttribute('aria-pressed') === 'true')
  await page.locator('button[aria-label*="web search"], button[aria-label*="Web search"]').click()
  const unpressed = await page.evaluate(() => document.querySelector('button[aria-label*="web search"], button[aria-label*="Web search"]')?.getAttribute('aria-pressed') === 'false')
  check('the Web search button toggles', pressed && unpressed)

  console.log(`\n=== SUMMARY ===`)
  const passed = results.filter(r => r.passed).length
  console.log(`${passed}/${results.length} checks passed`)
  for (const r of results.filter(r => !r.passed)) console.log('  FAIL', r.name, r.detail)
} catch (e) { console.log('ERROR', e.message); await shot('failure') }

await app.close()
console.log('EXIT')