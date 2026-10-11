// Live acceptance for the Chat loop, driven through the real visible UI.
//
// This is not a unit test and does not import anything from `core/`. It clicks
// the composer's own controls and reads what the app actually rendered, which is
// the only way to find out whether a turn looked something up or answered from
// memory — the difference the loop was fixed to make.
//
//   node scripts/live-chat-behaviour.mjs                     # all scenarios
//   node scripts/live-chat-behaviour.mjs search no-tools     # selected ones
//
// Requires a running Freya with CDP on 9234.
import { chromium } from 'playwright-core'

const CDP = process.env.FREYA_CDP ?? 'http://127.0.0.1:9234'
const browser = await chromium.connectOverCDP(CDP, { timeout: 8000 })
const page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes('/dist/index.html'))
if (!page) throw new Error('Freya app page missing')
page.setDefaultTimeout(5000)

const body = () => page.locator('body').innerText()
const composer = page.locator('textarea[placeholder="Ask Freya..."]')
const send = page.locator('button[aria-label="Send message"]')
const webSwitch = page.getByRole('switch', { name: 'Web search' })
const browserSwitch = page.getByRole('switch', { name: 'Browser' })

/**
 * The transcript, and nothing else.
 *
 * Reading `body` picks up the sources rail and the right-hand workspace, which
 * after a search is several thousand characters of video previews that have
 * nothing to do with what Freya said. Scoping to the conversation section is the
 * difference between reading an answer and reading a page.
 */
const transcript = page.locator('section[aria-label="Conversation"]')
async function tail() {
  const text = await transcript.innerText()
  return text.slice(-2200)
}

async function openChat() {
  if (!(await body()).includes('FREYA · CHAT')) {
    const open = page.locator('button[aria-label="Open Chats"]')
    if (await open.count()) await open.click()
  }
  await page.waitForTimeout(500)
}

/** Drive the switch to a known state through its own click, not by setting state. */
async function setSwitch(locator, want) {
  const current = (await locator.getAttribute('aria-checked')) === 'true'
  if (current !== want) await locator.click()
  await page.waitForTimeout(150)
  return (await locator.getAttribute('aria-checked')) === 'true'
}

/**
 * Waits for the turn to actually finish.
 *
 * There are two buttons labelled "Stop response" while a turn is running — the
 * composer's busy state and the active-turn tracker's — so the locator has to
 * name the composer's own, and has to tolerate there being none of them if the
 * turn was faster than the first wait.
 */
async function waitForTurn(timeoutMs = 180_000) {
  const busy = page.locator('button.hd-send-busy')
  try { await busy.first().waitFor({ state: 'attached', timeout: 20000 }) } catch { /* too fast to catch */ }
  await busy.first().waitFor({ state: 'detached', timeout: timeoutMs })
  await composer.waitFor({ state: 'visible', timeout: 20000 })
  await page.waitForTimeout(800)
}

/** Cancels anything still running from an earlier run, so we start from a clean transcript. */
async function cancelIfBusy() {
  const busy = page.locator('button.hd-send-busy')
  if (await busy.count()) {
    await busy.first().click()
    await page.waitForTimeout(800)
  }
}

async function ask(question) {
  await composer.waitFor({ state: 'visible', timeout: 30000 })
  await composer.fill(question)
  await send.click()
  await waitForTurn()
  return tail()
}

const SCENARIOS = {
  'no-tools': {
    question: 'What is the capital of Australia? Reply in one short sentence and do not use tools.',
    expect: 'one call, no lookup',
    web: false,
    browser: false,
  },
  search: {
    question: 'What is the latest stable version of Node.js right now? Find out and tell me, with sources.',
    expect: 'a lookup it did not have to be told to make',
    web: false,
    browser: false,
  },
  'search-forced': {
    question: 'What is the latest stable version of Node.js right now? Find out and tell me, with sources.',
    expect: 'same question, Web search switched on',
    web: true,
    browser: false,
  },
  'search-blocked': {
    question: 'What is the latest stable version of Node.js right now? Find out and tell me, with sources.',
    expect: 'same question, Web search deliberately off — must refuse rather than look',
    web: false,
    browser: false,
    block: true,
  },
  browser: {
    question: 'Use your browser to open https://example.com and tell me what the page says.',
    expect: 'a real browser action, not a description of one',
    web: false,
    browser: true,
  },
}

const wanted = process.argv.slice(2)
const names = wanted.length ? wanted : Object.keys(SCENARIOS)

await openChat()
await cancelIfBusy()
// Each run starts from an empty conversation, so the transcript is only what this
// run produced and no earlier turn can be mistaken for evidence.
await page.locator('button[aria-label="Start a new conversation"]').click()
await page.waitForTimeout(1200)
console.log(`# Freya live chat behaviour — ${new Date().toISOString()}`)
console.log(`# toggles on arrival: web=${await webSwitch.getAttribute('aria-checked')} browser=${await browserSwitch.getAttribute('aria-checked')}\n`)

for (const name of names) {
  const s = SCENARIOS[name]
  if (!s) { console.log(`## ${name} — UNKNOWN SCENARIO\n`); continue }

  await setSwitch(webSwitch, s.web)
  await setSwitch(browserSwitch, s.browser)
  if (s.block) {
    // Web search is already off by default; pressing it twice returns it to "off"
    // but *touched*, which is the distinction the transport used to drop.
    await webSwitch.click(); await page.waitForTimeout(120)
    await webSwitch.click(); await page.waitForTimeout(120)
  }

  console.log(`## ${name}`)
  console.log(`   expects: ${s.expect}`)
  // `data-sent` is what the composer will actually put on the wire: defer means
  // untouched (Core decides), allow means on, deny means a deliberate off. The
  // visible On/Off label cannot tell those apart, which is why this exists.
  console.log(`   wire:    web=${await webSwitch.getAttribute('data-sent')} browser=${await browserSwitch.getAttribute('data-sent')}`)
  console.log(`   label:   web=${await webSwitch.getAttribute('aria-checked')} browser=${await browserSwitch.getAttribute('aria-checked')}`)
  console.log(`   asked:   ${s.question}`)
  try {
    await ask(s.question)
    console.log(`   --- rendered tail ---`)
    console.log((await tail()).split('\n').map(l => '   ' + l).join('\n'))
  } catch (error) {
    console.log(`   FAILED: ${error.message}`)
  }
  console.log('')
}

await browser.close()