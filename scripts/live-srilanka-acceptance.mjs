// Ten-site acceptance, phase by phase, driven through the visible Chat UI.
//
// Phase 1  Web search on  â€” discover 10 Sri Lankan websites, collect real URLs.
// Phase 2  Same chat, browser on, web search off â€” open those URLs in ten tabs.
// Phase 3  Each tab: scroll to bottom, find Contact, click it, verify where it landed.
//
// Every phase runs in ONE conversation. That is the point: phase 2 has to be
// able to read phase 1's answer out of the transcript and act on it, which is the
// "research-to-browser continuation" the system is supposed to support.
//
//   node scripts/live-srilanka-acceptance.mjs 1
//   node scripts/live-srilanka-acceptance.mjs 1 2 3
import { chromium } from 'playwright-core'
import { mkdirSync, writeFileSync } from 'node:fs'

const SITES = Number(process.env.FREYA_SITES ?? 10)
const browser = await chromium.connectOverCDP(process.env.FREYA_CDP ?? 'http://127.0.0.1:9234', { timeout: 8000 })
const page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes('/dist/index.html'))
if (!page) throw new Error('Freya app page missing')
page.setDefaultTimeout(6000)
mkdirSync('.kilo/live-shots', { recursive: true })

const composer = page.locator('textarea[placeholder="Ask Freya..."]')
const send = page.locator('button[aria-label="Send message"]')
const webSwitch = page.getByRole('switch', { name: 'Web search' })
const browserSwitch = page.getByRole('switch', { name: 'Browser' })
const transcript = page.locator('section[aria-label="Conversation"]')

const tail = async (n = 2600) => (await transcript.innerText()).slice(-n)
/** Screenshots are evidence, not the deliverable â€” a failed one must not lose the run. */
const shot = async n => { try { await page.screenshot({ path: `.kilo/live-shots/${n}.png`, timeout: 20000 }) } catch { /* app busy rendering */ } }

/**
 * Which conversation this run is talking to.
 *
 * This has to be held explicitly, not assumed. Phase 2 has to act on phase 1's
 * answer, so "the current conversation" is only meaningful if it is still the one
 * phase 1 wrote to â€” and it silently is not. Asking the model to open "those 10
 * websites you just listed" in whatever conversation happens to be in front
 * produces a turn that confidently reasons about a list it has never seen, and
 * the failure is indistinguishable from a model defect until you read it.
 *
 * Conversations are titled after their first message and the list offers an
 * `Open <title>` button for each, so the run pins by that exact aria-label and
 * every phase re-focuses it before asking anything.
 */
const PHASE1_ASK_PREFIX = `Find ${SITES} Sri Lankan websites.`

async function conversationButton() {
  const list = page.locator('section[aria-label="Saved conversations"]')
  const opens = list.locator(`button[aria-label^="Find ${SITES} Sri Lankan websites."]`).filter({ hasNot: page.locator('[aria-label^="Rename"]') })
  void opens
  return page.locator(`button[aria-label^="${PHASE1_ASK_PREFIX}"]`).filter({ hasText: '' })
}

/** Puts the pinned conversation back in front, and says so if it cannot. */
async function focusPinnedConversation() {
  const list = page.locator('section[aria-label="Saved conversations"]')
  if (!(await list.count())) return true
  const named = await conversationButton()
  const exact = named.first()
  if (!(await exact.count())) {
    const titles = await list.locator('button').evaluateAll(bs => bs.map(b => b.getAttribute('aria-label') || '').filter(l => l && !/^(Rename|Close|Hide)/.test(l)).slice(0, 8))
    console.log(`   !! no conversation named "${PHASE1_ASK_PREFIX}â€¦" in the list. Present: ${JSON.stringify(titles)}`)
    return false
  }
  // Already in front? Clicking again is harmless and removes the need to guess.
  await exact.click()
  await page.waitForTimeout(1200)
  return true
}

async function cancelIfBusy() {
  const busy = page.locator('button.hd-send-busy')
  if (await busy.count()) { await busy.first().click(); await page.waitForTimeout(900) }
}

async function waitForTurn(timeoutMs = 900_000) {
  const busy = page.locator('button.hd-send-busy')
  // The attach window has to be generous. A turn is six provider calls at up to
  // 2730 output tokens each, which on a reasoning model is minutes, not seconds.
  // Waiting too briefly for the busy indicator and then for its disappearance
  // returns immediately when it has not appeared yet â€” which silently lets the
  // next phase submit into a conversation whose previous turn is still running.
  try { await busy.first().waitFor({ state: 'attached', timeout: 180000 }) } catch { /* fast turn */ }
  await busy.first().waitFor({ state: 'detached', timeout: timeoutMs })
  await composer.waitFor({ state: 'visible', timeout: 60000 })
  await page.waitForTimeout(2500)
}

/** Presses the switch only when it is not already in the wanted position. */
async function setSwitch(locator, want) {
  if (((await locator.getAttribute('aria-checked')) === 'true') !== want) await locator.click()
  await page.waitForTimeout(200)
}

/**
 * Presses a switch twice so it ends where it started but *marked as touched*.
 * An untouched switch means "no opinion"; a touched-off switch means "do not".
 */
async function markDenied(locator) {
  const on = (await locator.getAttribute('aria-checked')) === 'true'
  if (on) await locator.click()
  await page.waitForTimeout(150)
  // Touch it once so the state reads as "deliberately off" rather than "no opinion",
  // then return it to off if the touch turned it on.
  if ((await locator.getAttribute('aria-checked')) === 'false') await locator.click()
  await page.waitForTimeout(150)
  if ((await locator.getAttribute('aria-checked')) === 'true') await locator.click()
  await page.waitForTimeout(200)
}

async function ask(question) {
  await composer.waitFor({ state: 'visible', timeout: 30000 })
  await composer.fill(question)
  await send.click()
  await waitForTurn()
}

const phases = process.argv.slice(2).map(Number)
const wanted = n => phases.length === 0 || phases.includes(n)

await cancelIfBusy()
if (!(await page.locator('body').innerText()).includes('FREYA Â· CHAT')) {
  const open = page.locator('button[aria-label="Open Chats"]')
  if (await open.count()) await open.click()
}
// A fresh conversation is only correct when phase 1 is part of this run. Phases
// 2 and 3 must continue the conversation phase 1 wrote, because "open the sites
// you just listed" only means anything against that turn's own answer.
if (wanted(1)) {
  await page.locator('button[aria-label="Start a new conversation"]').click()
  await page.waitForTimeout(1500)
}

console.log(`# Sri Lanka acceptance â€” ${new Date().toISOString()} â€” target ${SITES} sites\n`)

if (wanted(1)) {
  await setSwitch(webSwitch, true)
  await setSwitch(browserSwitch, false)
  console.log('## phase 1 â€” discover', SITES, 'Sri Lankan websites')
  console.log(`   wire: web=${await webSwitch.getAttribute('data-sent')} browser=${await browserSwitch.getAttribute('data-sent')}`)
  await ask(`Find ${SITES} Sri Lankan websites. Give me the exact working URL for each one, as a numbered list. Real Sri Lankan businesses and organisations only â€” no directories, no listicles.`)
  await shot('phase1')
  const text = await tail(3200)
  console.log(text.split('\n').map(l => '   ' + l).join('\n'))
  const urls = [...new Set((text.match(/https?:\/\/[^\s\)\]"'<>]+/g) ?? []))]
  writeFileSync('.kilo/live-shots/phase1-urls.json', JSON.stringify(urls, null, 2))
  console.log(`\n   urls found: ${urls.length}`)
  urls.slice(0, SITES).forEach((u, i) => console.log(`   ${String(i + 1).padStart(2)}. ${u}`))
  console.log('')
}

if (wanted(2)) {
  if (!(await focusPinnedConversation())) console.log('   !! continuing in the WRONG conversation')
  await markDenied(webSwitch)
  await setSwitch(browserSwitch, true)
  console.log('## phase 2 — open the same', SITES, 'sites as separate browser tabs')
  console.log(`   wire: web=${await webSwitch.getAttribute('data-sent')} browser=${await browserSwitch.getAttribute('data-sent')}`)
  await ask(`Open those ${SITES} Sri Lankan websites you just listed, each one in its own browser tab. Open them all now.`)
  await shot('phase2')
  const text = await tail(3200)
  console.log(text.split('\n').map(l => '   ' + l).join('\n'))
  console.log('')
}

if (wanted(3)) {
  if (!(await focusPinnedConversation())) console.log('   !! phase 3 is in the WRONG conversation')
  console.log('## phase 3 — per tab: scroll to the bottom, find Contact, click it')
  for (let i = 1; i <= SITES; i++) {
    console.log(`   [${i}/${SITES}]`)
    try {
      await ask(`In tab number ${i}, scroll to the bottom of the page, find the Contact or Contact Us link, click it, and tell me the page title and URL you land on.`)
      await shot(`phase3-${String(i).padStart(2, '0')}`)
      console.log((await tail(1100)).split('\n').filter(Boolean).map(l => '      ' + l).join('\n'))
    } catch (error) {
      console.log(`      FAILED: ${error.message}`)
    }
  }
}

await browser.close()

