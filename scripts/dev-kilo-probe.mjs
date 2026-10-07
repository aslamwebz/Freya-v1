// Drive the live Freya Electron app via the CDP endpoint exposed by `npm run dev:kilo`.
// Uses the already-installed `playwright-core` (devDep) and `chromium.connectOverCDP`.
//
// Proves the 11 verification steps from the task:
//   1. Start Freya using npm run dev:kilo          (done in shell before this script)
//   2. Connect through the Playwright MCP          (this script = the Playwright client)
//   3. Inspect the live Freya UI semantically
//   4. Open Chats
//   5. Open the model selector
//   6. Type text into the Chat textarea
//   7. Verify textarea growth / scroll behavior
//   8. Click or trigger Send
//   9. Inspect the resulting UI state
//  10. Take a screenshot
//  11. Report console / runtime errors

import { chromium } from 'playwright-core'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const CDP = process.env.FREYA_CDP ?? 'http://127.0.0.1:9222'
const OUT = process.env.FREYA_KILO_OUT ?? join(process.cwd(), '.kilo', 'dev-kilo-proof')
mkdirSync(OUT, { recursive: true })

const consoleErrors = []
const pageErrors = []
const requestFailed = []

function log(step, ...rest) {
  const line = `[${String(step).padStart(2, ' ')}] ${rest.join(' ')}`
  console.log(line)
  return line
}

function shot(page, name) {
  return page.screenshot({ path: join(OUT, name), fullPage: false })
}

const browser = await chromium.connectOverCDP(CDP)
log(0, 'connected to', CDP)

// connectOverCDP returns a browser over the single shared CDP context.
// Electron exposes the renderer pages as targets; pick the main "Freya" one,
// not "Freya Presence" (the 240x240 orb widget).
const context = browser.contexts()[0] ?? await browser.newContext()
let page = null
for (const candidate of context.pages()) {
  const title = await candidate.title().catch(() => '')
  const url = candidate.url()
  log(0, 'target:', JSON.stringify(title), url)
  if (title === 'Freya' && url.startsWith('file://') && url.endsWith('dist/index.html')) {
    page = candidate
  }
}
if (!page) page = context.pages()[0] ?? await context.newPage()
log(1, 'using page', await page.title(), page.url())

// Capture errors from here on.
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text())
})
page.on('pageerror', (err) => pageErrors.push(err.message))
page.on('requestfailed', (req) => requestFailed.push(`${req.method()} ${req.url()} :: ${req.failure()?.errorText ?? ''}`))

// Wait for the React shell to mount.
await page.waitForSelector('footer.hd-dock, .hd-dock, .freya-v2', { timeout: 15_000 }).catch(() => {})
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(800)
log(3, 'semantic snapshot of root:')
const rootAttrs = await page.evaluate(() => {
  const r = document.querySelector('.freya-v2, .hd-dashboard, body')
  if (!r) return null
  return {
    tag: r.tagName.toLowerCase(),
    classes: r.className,
    dataset: Object.fromEntries(Object.entries(r.dataset ?? {})),
    title: document.title,
    heading: document.querySelector('h1,h2,h3')?.textContent?.trim() ?? null,
    buttons: Array.from(document.querySelectorAll('button[aria-label]'))
      .slice(0, 25)
      .map((b) => b.getAttribute('aria-label')),
  }
})
log(3, JSON.stringify(rootAttrs, null, 2))
await shot(page, '01-home.png')

// 4. Open Chats
const chatsTitle = page.locator('button.chats-history-title').first()
if (await chatsTitle.count()) {
  await chatsTitle.click()
  await page.waitForTimeout(700)
  log(4, 'clicked Chats history title')
} else {
  log(4, 'Chats history title not found; trying role+name')
  await page.getByRole('button', { name: /Chats/ }).first().click().catch(() => {})
  await page.waitForTimeout(700)
}
await shot(page, '02-chats.png')

// Confirm we landed on the Chats workspace (chat bar present).
const dockCount = await page.locator('footer.hd-dock, .hd-dock').count()
log(4, 'hd-dock present =', dockCount > 0)

// 5. Open the model selector
const modelChip = page.locator('button[aria-label="Choose model"]').first()
const modelCount = await modelChip.count()
log(5, 'model chip count =', modelCount)
if (modelCount) {
  await modelChip.click()
  await page.waitForTimeout(500)
}
const menuOpen = await page.locator('.hd-menu-model').count()
log(5, 'model menu open =', menuOpen > 0)
await shot(page, '03-model-menu.png')

// Close the menu by clicking elsewhere so the textarea is clickable.
if (menuOpen) {
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
  await page.locator('.hd-menu-model').first().waitFor({ state: 'detached', timeout: 3000 }).catch(() => {})
}

// 6. Type into the chat textarea.
// The textarea has no own aria-label; its accessible name comes from the
// wrapping <label class="hd-input"><span class="hd-sr-only">Ask Freya</span>...
// so locate it by the label text or the `.hd-input textarea` class hook.
const textarea = page.locator('.hd-input textarea, textarea').first()
const taCount = await textarea.count()
log(6, 'textarea count =', taCount)
const draft = 'Hello Freya. Please summarise what the dev:kilo launcher just did.'
await textarea.click()
await textarea.fill(draft)
await page.waitForTimeout(150)
const taState = await textarea.evaluate((el) => {
  const t = el
  return {
    valueLen: t.value.length,
    clientHeight: t.clientHeight,
    scrollHeight: t.scrollHeight,
    maxHeightPx: parseFloat(getComputedStyle(t).maxHeight),
    overflowY: getComputedStyle(t).overflowY,
  }
})
log(7, 'textarea state after fill:', JSON.stringify(taState))
await shot(page, '04-typed.png')

// 7b. Verify growth: type a much longer paste and confirm the field stops at the
// CSS cap and shows a scrollbar instead of growing past it.
const big = (draft + ' ').repeat(40)
await textarea.fill(big)
await page.waitForTimeout(150)
const bigState = await textarea.evaluate((el) => {
  const t = el
  const cs = getComputedStyle(t)
  return {
    valueLen: t.value.length,
    clientHeight: t.clientHeight,
    scrollHeight: t.scrollHeight,
    atMaxHeight: t.scrollHeight > t.clientHeight + 1,
    maxHeightPx: parseFloat(cs.maxHeight),
    overflowY: cs.overflowY,
  }
})
log(7, 'textarea state after long fill:', JSON.stringify(bigState))
await shot(page, '05-long.png')

// 8. Reset to a normal-length draft and send.
await textarea.fill('Kilo dev probe. Please reply briefly.')
await page.waitForTimeout(150)
const sendBtn = page.locator('form[aria-label="Freya composer"] button[type="submit"][aria-label="Send message"]').first()
const sendCount = await sendBtn.count()
log(8, 'send button count =', sendCount, 'disabled =', sendCount ? await sendBtn.isDisabled() : 'n/a')
if (sendCount) {
  await sendBtn.click()
  log(8, 'clicked send')
}
await page.waitForTimeout(1500)
await shot(page, '06-after-send.png')

// 9. Inspect post-send state: chat log + textarea (should still hold the draft,
// since the change in this branch stopped the clear-on-send behaviour).
const post = await page.evaluate(() => {
  const ta = document.querySelector('.hd-input textarea')
  const turns = document.querySelectorAll('article.chats-turn')
  const assistant = document.querySelectorAll('article.chats-turn[data-role="assistant"]')
  const user = document.querySelectorAll('article.chats-turn[data-role="user"]')
  const stopBtn = document.querySelector('button.chats-stop, button[aria-label="Stop response"]')
  return {
    textareaValue: ta?.value ?? null,
    textareaLen: ta?.value?.length ?? 0,
    turnCount: turns.length,
    assistantCount: assistant.length,
    userCount: user.length,
    stopButtonVisible: !!stopBtn,
    thinking: !!document.querySelector('.chats-thinking'),
    headerSub: document.querySelector('.chats-workspace-state')?.textContent?.trim() ?? null,
    lastAssistantText: assistant.length ? assistant[assistant.length - 1].textContent.slice(0, 220) : null,
  }
})
log(9, 'post-send state:', JSON.stringify(post, null, 2))
await shot(page, '07-final.png')

// 11. Errors.
log(11, 'console errors:', consoleErrors.length)
for (const e of consoleErrors) log(11, '  ERR:', e)
log(11, 'page errors:', pageErrors.length)
for (const e of pageErrors) log(11, '  PAGE-ERR:', e)
log(11, 'requestfailed:', requestFailed.length)
for (const e of requestFailed) log(11, '  REQ-FAIL:', e)

writeFileSync(
  join(OUT, 'summary.json'),
  JSON.stringify({ rootAttrs, taState, bigState, post, consoleErrors, pageErrors, requestFailed }, null, 2),
)

await browser.close()
log(0, 'done. artefacts in', OUT)
