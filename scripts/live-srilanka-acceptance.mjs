// Ten-site acceptance, phase by phase, driven through the visible Chat UI.
//
// Phase 1  Web search on  — discover 10 Sri Lankan websites, collect real URLs.
// Phase 2  Same chat, web search off, browser on — open those URLs in ten tabs.
// Phase 3  Each tab: scroll to bottom, find Contact, click it, verify where it landed.
//
// Every phase runs in ONE conversation. That is the point: phase 2 has to read
// phase 1's answer out of the transcript and act on it, which is the
// "research-to-browser continuation" the system is supposed to support.
//
//   node scripts/live-srilanka-acceptance.mjs 1
//   node scripts/live-srilanka-acceptance.mjs 2 3
//   node scripts/live-srilanka-acceptance.mjs 1 2 3
import { chromium } from 'playwright-core'
import { mkdirSync, writeFileSync } from 'node:fs'

const SITES = Number(process.env.FREYA_SITES ?? 10)
const PHASE1_PREFIX = `Find ${SITES} Sri Lankan websites.`

const browser = await chromium.connectOverCDP(process.env.FREYA_CDP ?? 'http://127.0.0.1:9234', { timeout: 8000 })
const page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes('/dist/index.html'))
if (!page) throw new Error('Freya app page missing')
page.setDefaultTimeout(8000)
mkdirSync('.kilo/live-shots', { recursive: true })

const composer = page.locator('textarea[placeholder="Ask Freya..."]')
const send = page.locator('button[aria-label="Send message"]')
const webSwitch = page.getByRole('switch', { name: 'Web search' })
const browserSwitch = page.getByRole('switch', { name: 'Browser' })
const transcript = page.locator('section[aria-label="Conversation"]')

const tail = async (n = 2600) => (await transcript.innerText()).slice(-n)

/** Screenshots are evidence, not the deliverable — a failed one must not lose the run. */
const shot = async n => {
  try { await page.screenshot({ path: `.kilo/live-shots/${n}.png`, timeout: 20000 }) } catch { /* app busy rendering */ }
}

async function cancelIfBusy() {
  const busy = page.locator('button.hd-send-busy')
  if (await busy.count()) {
    await busy.first().click()
    await page.waitForTimeout(900)
  }
}

/**
 * Waits for the turn to actually finish.
 *
 * The attach window has to be generous. A turn is six provider calls at 2730
 * output tokens each, which on a reasoning model is minutes rather than seconds.
 * Waiting briefly for the busy indicator and then for its disappearance returns
 * immediately when it has not appeared yet — which silently lets the next phase
 * submit into a conversation whose previous turn is still running.
 */
async function waitForTurn(timeoutMs = 900_000) {
  const busy = page.locator('button.hd-send-busy')
  try { await busy.first().waitFor({ state: 'attached', timeout: 180000 }) } catch { /* fast turn */ }
  await busy.first().waitFor({ state: 'detached', timeout: timeoutMs })
  await composer.waitFor({ state: 'visible', timeout: 60000 })
  await page.waitForTimeout(2500)
}

/** Presses the switch only when it is not already in the wanted position. */
async function setSwitch(locator, want) {
  if (((await locator.getAttribute('aria-checked')) === 'true') !== want) await locator.click()
  await page.waitForTimeout(250)
}

/**
 * Presses a switch and returns it to off, so it ends *marked as touched*.
 *
 * An untouched switch means "no opinion"; a touched-off switch means "do not".
 * That distinction is the whole point of the three-state intent contract.
 */
async function markDenied(locator) {
  for (let i = 0; i < 3; i++) {
    if ((await locator.getAttribute('aria-checked')) === 'true') { await locator.click(); await page.waitForTimeout(200) }
  }
  await locator.click()
  await page.waitForTimeout(200)
  if ((await locator.getAttribute('aria-checked')) === 'true') { await locator.click(); await page.waitForTimeout(200) }
}

/**
 * Puts the pinned conversation back in front, and says so if it cannot.
 *
 * Matching on aria-label does not work here, and it cost three runs: the
 * conversation buttons carry an *empty* aria-label — only "Rename …" and
 * "Close …" are labelled — so a `^=` selector matched nothing while the script
 * cheerfully carried on in whatever conversation happened to be open. The title
 * is the button's text.
 *
 * Several conversations share a title, so this takes the first, which is the most
 * recent and therefore the one this run created.
 */
async function focusPinnedConversation() {
  const list = page.locator('section[aria-label="Saved conversations"]')
  if (!(await list.count())) return true
  const target = list.locator('button').filter({ hasText: PHASE1_PREFIX }).first()
  if (!(await target.count())) {
    const titles = await list.locator('button').allInnerTexts()
    console.log(`   !! no conversation titled "${PHASE1_PREFIX}…" — titles: ${JSON.stringify(titles.filter(Boolean).slice(0, 6))}`)
    return false
  }
  await target.click()
  await page.waitForTimeout(1800)
  // Check the whole transcript, not its tail. The pinned conversation is titled
  // after its first message, which by phase 2 is far above the end of the text —
  // asserting on the tail reported a mis-click for a correct one.
  const whole = await transcript.innerText()
  if (!whole.includes(PHASE1_PREFIX)) {
    console.log('   !! clicked the pinned conversation but it is not in front')
    return false
  }
  return true
}

async function ask(question) {
  await composer.waitFor({ state: 'visible', timeout: 60000 })
  await composer.fill(question)
  await send.click()
  await waitForTurn()
}

const phases = process.argv.slice(2).map(Number)
const wanted = n => phases.length === 0 || phases.includes(n)

await cancelIfBusy()
if (!(await page.locator('body').innerText()).includes('FREYA · CHAT')) {
  const open = page.locator('button[aria-label="Open Chats"]')
  if (await open.count()) await open.click()
}

// A fresh conversation is only correct when phase 1 is part of this run. Phases 2
// and 3 must continue the conversation phase 1 wrote.
if (wanted(1)) {
  await page.locator('button[aria-label="Start a new conversation"]').click()
  await page.waitForTimeout(1800)
}

console.log(`# Sri Lanka acceptance — ${new Date().toISOString()} — target ${SITES} sites\n`)

if (wanted(1)) {
  await setSwitch(webSwitch, true)
  await setSwitch(browserSwitch, false)
  console.log(`## phase 1 — discover ${SITES} Sri Lankan websites`)
  console.log(`   wire: web=${await webSwitch.getAttribute('data-sent')} browser=${await browserSwitch.getAttribute('data-sent')}`)
  await ask(`Find ${SITES} Sri Lankan websites. Give me the exact working URL for each one, as a numbered list. Real Sri Lankan businesses and organisations only — no directories, no listicles.`)
  await shot('phase1')
  const text = await tail(3400)
  console.log(text.split('\n').map(l => '   ' + l).join('\n'))
  const urls = [...new Set(text.match(/https?:\/\/[^\s)\]"'<>]+/g) ?? [])]
  writeFileSync('.kilo/live-shots/phase1-urls.json', JSON.stringify(urls, null, 2))
  console.log(`\n   urls found: ${urls.length}`)
  urls.slice(0, SITES).forEach((u, i) => console.log(`   ${String(i + 1).padStart(2)}. ${u}`))
  console.log('')
}

if (wanted(2)) {
  if (!(await focusPinnedConversation())) console.log('   !! phase 2 is in the WRONG conversation')
  await markDenied(webSwitch)
  await setSwitch(browserSwitch, true)
  console.log(`## phase 2 — open the same ${SITES} sites as separate browser tabs`)
  console.log(`   wire: web=${await webSwitch.getAttribute('data-sent')} browser=${await browserSwitch.getAttribute('data-sent')}`)
  await ask(`Open those ${SITES} Sri Lankan websites you just listed, each one in its own browser tab. Open them all now.`)
  await shot('phase2')
  console.log((await tail(3400)).split('\n').map(l => '   ' + l).join('\n'))
  console.log('')
}

if (wanted(3)) {
  if (!(await focusPinnedConversation())) console.log('   !! phase 3 is in the WRONG conversation')
  console.log(`## phase 3 — all ${SITES} tabs in ONE turn: scroll to the bottom, find Contact, click it`)
  // One turn for all ten, not one turn per tab.
  //
  // Ten separate turns is not how an agentic browser works, and it is not how
  // Comet works: a single request becomes a single planned multi-step job across
  // every tab, with results collected and one answer at the end. Ten turns means
  // ten separate re-plannings, ten chances to narrate instead of act, and ten
  // owner round-trips for work that was one instruction.
  await setSwitch(browserSwitch, true)
  console.log(`   wire: browser=${await browserSwitch.getAttribute('data-sent')}`)
  try {
    await ask(`All ${SITES} sites are open in browser tabs. For every one of them: scroll to the bottom of the page, find the Contact or Contact Us link, click it, and note the page title and URL you land on. Work through all ${SITES} tabs, then give me one list of all ${SITES} results.`)
    await shot('phase3')
    console.log((await tail(3000)).split('\n').map(l => '   ' + l).join('\n'))
  } catch (error) {
    console.log(`   FAILED: ${error.message}`)
  }
}

// Disconnect, never close. Opening ten browser tabs adds CDP targets, and
// `close()` on a connected browser tears down the app's own pages — which is how
// a run died mid-wait with "Target page, context or browser has been closed".
await page.context().browser()?.close?.().catch?.(() => {}) ?? process.exit(0)