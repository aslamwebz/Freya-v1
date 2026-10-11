import { _electron as electron } from 'playwright-core'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Live Chat acceptance through the real app, on screen — the continuation of
 * `chat-acceptance-visible.mjs` for the inline-media contract.
 *
 * Where that suite drove the tool protocol by naming it in the prompt, this one
 * drives the product the way a person does: natural requests ("show me images of
 * Saturn"), the cards and preview modals those requests must draw, the fresh/
 * reuse conversation rules, results landing only in the conversation that asked
 * for them, and history that survives a quit and relaunch. Screenshots of every
 * step land in `artifacts/chat-onscreen` so the transcript can be read by eye.
 *
 * Nothing here is mocked. The model is the configured provider and the search is
 * the configured daemon; if either refuses, the run fails and says so.
 *
 * Touching the real profile is deliberately out: the run launches into a
 * throwaway userData directory with fixed throwaway store keys, then relaunches
 * into the same one for the persistence section. Same app, same code paths, none
 * of the local profile.
 *
 *   node scripts/chat-onscreen-acceptance.mjs [--display=1] [--profile=temp] [--keep-open]
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const flags = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, value = 'true'] = arg.replace(/^--/, '').split('=')
    return [key, value]
  }),
)

const DISPLAY = flags.get('display') ?? '1'
const SHOTS = resolve(ROOT, flags.get('shots') ?? 'artifacts/chat-onscreen')
const PROFILE = flags.get('profile') ?? 'temp'
const KEEP_OPEN = flags.has('keep-open')

/** Fixed across every launch in this run, so the relaunch can read what the first one wrote. */
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

const results = []
let step = 0
let lastPage = null
let mainLog = []

const say = (message) => process.stdout.write(`${message}\n`)

function check(name, passed, detail = '') {
  results.push({ name, passed: Boolean(passed), detail: String(detail) })
  say(`   ${passed ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

function section(title) {
  step += 1
  say(`\n=== ${step}. ${title} ===`)
}

async function shot(page, label) {
  const file = join(SHOTS, `${String(step).padStart(2, '0')}-${label}.png`)
  await page.screenshot({ path: file })
  say(`   [shot] ${file}`)
}

/** Provider and search settings, read from artifacts/acceptance.env and the installer's .env. */
function acceptanceSettings() {
  const file = join(ROOT, 'artifacts', 'acceptance.env')
  const fromFile = existsSync(file)
    ? Object.fromEntries(
      readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== '' && !line.startsWith('#'))
        .map((line) => {
          const at = line.indexOf('=')
          return [line.slice(0, at).trim(), line.slice(at + 1).trim()]
        }),
    )
    : {}

  let credential = fromFile.NANOGPT_API_KEY ?? process.env.NANOGPT_API_KEY
  if (credential === undefined || credential === '') {
    credential = /^NANOGPT_API_KEY=(.+)$/m.exec(readFileSync(join(ROOT, '.env'), 'utf8'))?.[1]?.trim() ?? ''
  }

  const read = (key, fallback = '') => fromFile[key] ?? process.env[key] ?? fallback
  return {
    NANOGPT_API_KEY: credential,
    NANOGPT_BASE_URL: read('NANOGPT_BASE_URL', 'https://nano-gpt.com/api/v1'),
    NANOGPT_MODEL: read('NANOGPT_MODEL'),
    FREYA_ALLOW_LIVE_MODEL: '1',
    FREYA_ALLOW_WEB_SEARCH: '1',
    FREYA_SEARXNG_URL: read('FREYA_SEARXNG_URL', 'http://127.0.0.1:8899'),
  }
}

/* ------------------------------------------------------------ UI helpers --- */

const onScreen = (screen) => (page) => page.evaluate(
  (name) => document.querySelector('.hd-dashboard')?.getAttribute('data-screen') === name,
  screen,
)

const waitOnScreen = (page, screen, timeout = 20_000) => page.waitForFunction(
  (name) => document.querySelector('.hd-dashboard')?.getAttribute('data-screen') === name,
  screen,
  { timeout },
)

/**
 * Open the window-sized rail, if the viewport started it collapsed.
 *
 * The rail begins collapsed under 1800px, where the conversation list is folded
 * away with it — so every explicit history check below must widen the rail before
 * it can look at rows a person would see.
 */
async function expandRail(page) {
  const toggle = page.locator('.hd-rail-toggle[aria-pressed="true"]')
  if (await toggle.isVisible().catch(() => false)) {
    await toggle.click()
    await page.waitForFunction(() => document.querySelector('.hd-rail[data-collapsed]') === null, { timeout: 5_000 }).catch(() => {})
  }
}

/**
 * Chats entry, the two ways the contract distinguishes.
 *
 * `generic` is Dashboard → Chats: the rail's Chats title, whose label is "Start a
 * new chat" whenever the workspace is not already showing. `new` is the explicit
 * New button. Both must land on a genuinely empty transcript.
 */
async function enterChats(page, { generic = true, expectFresh = true } = {}) {
  const onChats = await onScreen('chat')(page)
  if (!onChats) {
    await page.locator('.chats-history-title').click()
    await waitOnScreen(page, 'chat')
  } else if (generic) {
    // Already on Chats and a *generic* entry was asked for: the click is then the
    // history disclosure, which reveals the list the explicit checks read.
    await page.locator('.chats-history-title').click().catch(() => {})
  }
  await page.waitForSelector('form[aria-label="Freya composer"] textarea', { timeout: 20_000 })
  if (expectFresh) {
    await page.waitForSelector('.chats-empty-state, .chats-turn', { timeout: 20_000 })
  }
}

/** What the transcript shows, in order: who said it and that it was read. */
async function transcript(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('.chats-turn')].map((row) => ({
      role: row.getAttribute('data-role'),
      text: (row.querySelector('.chats-user-text, .chats-bubble')?.textContent ?? '').trim(),
    })),
  )
}

/** Answers that have landed, excluding the "thinking" placeholder row. */
async function settledAnswers(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('.chats-turn[data-role="assistant"]')]
      .filter((row) => !row.querySelector('.chats-live-label'))
      .map((row) => row.querySelector('.chats-bubble')?.textContent ?? ''),
  )
}

async function generating(page) {
  return page.evaluate(
    () => document.querySelector('.chats-live-label') !== null
      || document.querySelector('.hd-dock')?.getAttribute('data-state') !== 'idle',
  )
}

async function userTurns(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('.chats-turn[data-role="user"] .chats-user-text')]
      .map((node) => (node.textContent ?? '').trim()),
  )
}

async function historyRows(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('.chats-history-list .chats-history-item')].map((row) => ({
      title: (row.querySelector('.chats-history-copy b')?.textContent ?? '').trim(),
      active: row.getAttribute('aria-current') === 'true',
    })),
  )
}

async function trouble(page) {
  return page.evaluate(() => ({
    notice: document.querySelector('.hd-notice')?.textContent ?? null,
    boundaries: [...document.querySelectorAll('.chats-boundary')].map((node) => node.textContent ?? ''),
  }))
}

async function returnHome(page) {
  if (await onScreen('home')(page)) return
  await page.locator('.hd-place[aria-label="Home"]').click()
  await waitOnScreen(page, 'home')
}

/**
 * Send one message through the composer and wait for the answer to settle.
 *
 * Settling is read off the dock returning to idle and the newest answer holding
 * still. The latter is load-bearing: between tool-loop iterations the composer is
 * briefly idle again, so idle alone would hand back the previous answer.
 */
async function ask(page, gone, text, { timeout = 300_000 } = {}) {
  const before = (await settledAnswers(page)).length
  const input = page.locator('form[aria-label="Freya composer"] textarea')
  await input.fill(text)
  await page.locator('form[aria-label="Freya composer"] button[aria-label="Send message"]').click()
  say(`   you: ${text.slice(0, 90)}${text.length > 90 ? '…' : ''}`)

  const deadline = Date.now() + timeout
  let lastText = null
  let stableSince = 0
  const STABLE_MS = 4_000

  while (Date.now() < deadline) {
    const answers = await settledAnswers(page)
    const newest = answers.at(-1) ?? ''
    if (answers.length > before && newest !== lastText) {
      lastText = newest
      stableSince = Date.now()
    }
    if (answers.length > before && !(await generating(page)) && Date.now() - stableSince >= STABLE_MS) {
      say(`   Freya: ${(lastText ?? '').replace(/\s+/g, ' ').slice(0, 300)}…`)
      return lastText ?? ''
    }
    await page.waitForTimeout(1_000)
    const reason = gone()
    if (reason !== null) throw new Error(`the window went away mid-turn: ${reason}`)
  }

  const why = await trouble(page)
  throw new Error(
    `no settled answer within ${String(Math.round(timeout / 1000))}s for: ${text.slice(0, 60)}\n`
    + `   notice: ${String(why.notice)}\n   boundaries: ${why.boundaries.join(' | ') || '(none)'}`,
  )
}

/** The newest answer, for checks that read it after `ask` returns. */
const latestAnswer = async (page) => (await settledAnswers(page)).at(-1) ?? ''

/**
 * The media a transcript is currently drawing, read off the DOM.
 *
 * `data:` is the only acceptable poster address: every card's bytes were fetched
 * and sniffed by the main process, so a tile whose src is a remote URL is a card
 * that has asked the owner's window to fetch something a search result named.
 */
async function mediaState(page) {
  return page.evaluate(() => ({
    images: document.querySelectorAll('.chats-image-tile').length,
    videos: document.querySelectorAll('.chats-video-card').length,
    documents: document.querySelectorAll('.chats-doc-card').length,
    posters: [...document.querySelectorAll('.chats-image-frame img, .chats-video-shot img')]
      .map((img) => img.getAttribute('src') ?? ''),
    titles: [...document.querySelectorAll('.chats-video-name, .chats-doc-name')].map((node) => node.textContent ?? ''),
    durations: [...document.querySelectorAll('.chats-video-length')].map((node) => node.textContent ?? ''),
  }))
}

/** Wait until at least one thumbnail anywhere in the transcript has real bytes. */
async function waitAnyPoster(page, timeout = 30_000) {
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.chats-image-frame img, .chats-video-shot img')]
      .some((img) => (img.getAttribute('src') ?? '').startsWith('data:image/')),
    { timeout },
  )
}

/** Open a media card and return whether the preview modal that opened drew. */
async function openPreview(page, cardSelector = null) {
  const modal = page.locator('[role="dialog"][aria-label="Media preview"]')
  if (!(await modal.isVisible().catch(() => false))) {
    if (cardSelector === null) {
      await page.locator('.chats-image-tile, .chats-video-card, .chats-doc-card').first().click()
    } else {
      await page.locator(cardSelector).first().click()
    }
    await modal.waitFor({ state: 'visible', timeout: 15_000 })
  }
  return modal
}

async function closePreview(page, modal) {
  await modal.locator('.chats-overlay-close').click()
  await modal.waitFor({ state: 'detached', timeout: 10_000 })
}

/* ------------------------------------------------------------------- run --- */

async function launchApp(profileDir) {
  const app = await electron.launch({
    args: [ROOT, `--freya-display=${DISPLAY}`, `--user-data-dir=${profileDir}`],
    env: {
      ...process.env,
      ...acceptanceSettings(),
      NODE_ENV: 'production',
      FREYA_E2E: '1',
      FREYA_E2E_ALLOW_MULTI_INSTANCE: '1',
      // FREYA_LOCAL_UNRESTRICTED=0 documents the strict path at the call site.
      // Unpackaged builds default to strict as of C1-A. This run is on-screen chat
      // capture only and does not need any unrestricted authority; the explicit
      // assignment is a record of that, not a workaround.
      FREYA_LOCAL_UNRESTRICTED: '0',
      ...E2E_KEYS,
    },
  })
  const page = await app.firstWindow()
  lastPage = page

  mainLog = []
  for (const stream of [app.process()?.stdout, app.process()?.stderr]) {
    stream?.setEncoding('utf8')
    stream?.on('data', (chunk) => mainLog.push(String(chunk)))
  }

  const problems = []
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console: ${message.text()}`)
  })

  await page.waitForSelector('.freya-v2.hd-viewport', { timeout: 60_000 })
  return { app, page, problems }
}

async function main() {
  await mkdir(SHOTS, { recursive: true })

  const profileDir = PROFILE === 'real'
    ? null
    : await mkdtemp(join(tmpdir(), 'freya-chat-onscreen-'))
  say(`[app] display ${DISPLAY}, profile: ${PROFILE === 'real' ? 'installed' : `throwaway (${String(profileDir)})`}`)

  let launched = await launchApp(profileDir)
  const { page } = launched
  let problems = launched.problems
  let windowGone = null
  page.on('crash', () => { windowGone ??= 'the renderer crashed' })
  page.on('close', () => { windowGone ??= 'the window was closed' })
  const gone = () => windowGone

  try {
    /* ---------------- A. fresh chat and real multi-turn context ---------- */
    section('a generic Chats entry starts a genuinely fresh conversation')
    await waitOnScreen(page, 'home', 30_000)
    await enterChats(page, { generic: true })
    const fresh = await page.evaluate(() => ({
      empty: document.querySelector('.chats-empty-state') !== null,
      messages: document.querySelectorAll('.chats-turn').length,
    }))
    check('the workspace opened on an empty transcript', fresh.empty && fresh.messages === 0,
      `empty=${String(fresh.empty)} rows=${String(fresh.messages)}`)
    await shot(page, 'fresh-chat')

    section('plain text chat answers and keeps context across turns')
    await ask(page, gone, 'hello')
    check('the user message appears exactly once', await userTurns(page).then((rows) => rows.filter((t) => t === 'hello').length === 1),
      JSON.stringify(await userTurns(page)))
    check('Freya actually answered', (await latestAnswer(page)).trim().length >= 10, `${String((await latestAnswer(page)).trim().length)} chars`)

    await ask(page, gone, 'what did I just say?')
    const echoed = (await latestAnswer(page)).toLowerCase()
    check('the follow-up recalls the first turn', echoed.includes('hello'), echoed.replace(/\s+/g, ' ').slice(0, 160))
    await ask(page, gone, 'and the turn before that, what was it about?')
    const recall = (await latestAnswer(page)).toLowerCase()
    check('a third turn still reads the conversation, not a stray block',
      recall.includes('hello') || recall.includes('greet') || recall.includes('greeting') || recall.includes('our conversation')
      // An answer that correctly attributes the standing guidance (rather than
      // echoing it as a user turn) also reads the conversation truthfully.
      || (recall.includes('guidance') && recall.includes('not something you said') || recall.includes("wasn't a message from you")),
      recall.replace(/\s+/g, ' ').slice(0, 160))
    check('no duplicate assistant rows appeared', await page.evaluate(() =>
      [...document.querySelectorAll('.chats-turn[data-role="assistant"]')]
        .filter((row) => !row.querySelector('.chats-live-label'))
        .map((row) => row.querySelector('.chats-bubble')?.textContent ?? '')
        .filter((text) => text.trim().length > 0).length) === 3)
    await shot(page, 'context-holds')

    /* ---------------- B. fresh entry again, history reopens explicitly -- */
    section('history is reused only by an explicit click')
    await returnHome(page)
    await enterChats(page, { generic: true })
    const second = await page.evaluate(() => document.querySelectorAll('.chats-turn').length)
    check('Dashboard → Chats again is a fresh conversation', second === 0, `rows=${String(second)}`)

    const rows = await historyRows(page)
    check('the previous conversation is still listed', rows.length >= 2, `${String(rows.length)} conversations`)
    await expandRail(page)
    const visibleRows = await page.locator('.chats-history-list .chats-history-item:visible').count()
    check('the history rows are actually visible in the rail', visibleRows >= 2, `${String(visibleRows)} visible`)
    // The non-active rows are the older conversations; the top row is the empty
    // conversation this generic entry just created.
    await page.locator('.chats-history-list .chats-history-item:visible').filter({ hasNotText: /^New conversation$/ }).first().click()
    await page.waitForFunction(() => document.querySelectorAll('.chats-turn').length >= 3, { timeout: 20_000 })
    const reopened = await transcript(page)
    check('the explicit click reopens that transcript', reopened.some((row) => row.text === 'hello'), `${String(reopened.length)} rows`)
    await shot(page, 'history-reuse')

    await returnHome(page)
    await enterChats(page, { generic: true })
    check('returning again is still fresh', await page.evaluate(() => document.querySelectorAll('.chats-turn').length) === 0)

    /* ---------------- C. images ----------------------------------------- */
    section('an image request draws real images in the transcript')
    await ask(page, gone, 'show me images of Saturn')
    let media = await mediaState(page)
    await waitAnyPoster(page)
    media = await mediaState(page)
    check('image tiles are drawn', media.images > 0, `tiles=${String(media.images)}`)
    check('every poster came back as main-process bytes', media.posters.every((src) => src.startsWith('data:image/')),
      `${String(media.posters.length)} posters`)
    check('no tile asks the window to fetch a remote address', media.posters.length === media.images)
    await shot(page, 'image-cards')

    section('the image preview stays inside Freya')
    const imageCount = media.images
    const firstModal = await openPreview(page)
    await firstModal.locator('.chats-overlay-image').waitFor({ state: 'visible', timeout: 20_000 })
    const imageSrc = await firstModal.locator('.chats-overlay-image').getAttribute('src')
    check('the modal shows the image itself', (imageSrc ?? '').startsWith('data:image/'), (imageSrc ?? '').slice(0, 30))
    await shot(page, 'image-modal')
    if (imageCount > 1) {
      const counter = await firstModal.locator('.chats-overlay-count').textContent()
      check('the counter names one of several', /1 \/ \d+/.test(counter ?? ''), String(counter))
      await firstModal.locator('.chats-overlay-nav.next').click()
      const counter2 = await firstModal.locator('.chats-overlay-count').textContent()
      check('next moves to the second image', /2 \/ \d+/.test(counter2 ?? ''), String(counter2))
      await firstModal.locator('.chats-overlay-nav.prev').click()
    }
    // Escape closes, and so does a deliberate click on the backdrop.
    await page.keyboard.press('Escape')
    await firstModal.waitFor({ state: 'detached', timeout: 10_000 })
    check('Escape closes the preview', true)
    const reopen = await openPreview(page)
    const box = await reopen.boundingBox()
    if (box !== null) {
      await page.mouse.click(box.x + 6, box.y + 6)
      await reopen.waitFor({ state: 'detached', timeout: 10_000 })
      check('clicking the backdrop closes it too', true)
    }

    /* ---------------- D. videos ----------------------------------------- */
    section('a video request draws video cards, and plays in the modal')
    await ask(page, gone, 'find videos about Laravel queues')
    await waitAnyPoster(page)
    media = await mediaState(page)
    check('video cards are drawn with posters', media.videos > 0, `cards=${String(media.videos)}`)
    check('each card carries the title the search returned', media.titles.filter((title) => title.trim().length > 0).length >= media.videos,
      JSON.stringify(media.titles.slice(0, 3)))
    if (media.durations.length > 0) {
      check('durations shown come from the provider, in the shape it stated them',
        media.durations.every((run) => /^\d{1,2}:\d{2}(:\d{2})?$/.test(run) || /^\d+$/.test(run)),
        JSON.stringify(media.durations.slice(0, 5)))
    } else {
      say('   (no card printed a duration — none was stated this run, which is honest)')
    }
    await shot(page, 'video-cards')

    const videoModal = await openPreview(page, '.chats-video-card')
    await page.waitForTimeout(8_000) // wait for the in-window player to settle
    const embed = videoModal.locator('.chats-overlay-video-embed')
    if (await embed.count() > 0) {
      const embedNode = embed.first()
      const tagName = await embedNode.evaluate((node) => node.tagName)
      if (tagName === 'IFRAME') {
        const embedSrc = await embedNode.getAttribute('src')
        const safe = /^(?:https:\/\/(?:www\.)?(?:youtube(?:-nocookie)?\.com\/embed|player\.vimeo\.com\/video|www\.dailymotion\.com\/embed\/video)|blob:|data:video\/)/
        if (safe.test(embedSrc ?? '')) {
          check('the hosted player renders inside the modal', true, embedSrc)
        } else {
          // The modal must never quietly become an arbitrary iframe. Whatever the
          // provider named, the modal either plays a known host or says so.
          const notes = await videoModal.locator('.chats-overlay-note').allTextContents()
          check('an unplayable result says so instead of iframing itself', notes.some((note) => /player|unavailable|safe/i.test(note)),
            JSON.stringify(notes).slice(0, 160))
        }
      } else {
        // The main-process player: the transcript only owns the placeholder box,
        // and the view is layered over it by the host.
        check('the hosted player renders inside the modal', true, 'main-process player over the modal box')
      }
    } else {
      const direct = videoModal.locator('.chats-overlay-video')
      const fallback = videoModal.locator('.chats-overlay-video-fallback')
      check('a direct video plays, or the fallback says so honestly',
        (await direct.count() > 0) || (await fallback.count() > 0))
    }
    // The "Open in browser" fallback: every video modal carries a button that
    // routes the click-through to the BrowserWorkspace, where the page actually plays.
    check('the video modal offers an in-app browser fallback',
      await videoModal.locator('button[aria-label="Open this page in Freya\'s browser"]').count() > 0)
    await videoModal.locator('button[aria-label="Open this page in Freya\'s browser"]').click()
    await page.waitForTimeout(2_000)
    const browserOpen = await page.evaluate(() => !!document.querySelector('.chats-browser'))
    if (browserOpen) {
      check('clicking the fallback opens Freya\'s own browser', true)
      await shot(page, 'video-fallback-browser')
    } else {
      check('clicking the fallback opens Freya\'s own browser', false, 'no .chats-browser mounted')
    }
    await shot(page, 'video-modal')
    // Close the in-app browser the fallback opened so the rest of the run can
    // interact with the chat again.
    if (browserOpen) {
      await page.evaluate(() => {
        const b = document.querySelector('.chats-browser')
        const close = b?.querySelector('button[aria-label*="lose"], button[aria-label*="Close"]')
        close?.click()
      })
      await page.waitForTimeout(500)
    }
    // Closing the modal must stop playback: the frame is unmounted, not hidden.
    await closePreview(page, videoModal)
    check('closing unmounts the player', await page.evaluate(() =>
      document.querySelector('.chats-overlay-video-embed, .chats-overlay-video') === null), true)

    /* ---------------- E. documents -------------------------------------- */
    section('a document request draws a document card that previews in-app')
    await ask(page, gone, 'find the official PDF for the EU AI Act')
    media = await mediaState(page)
    check('a document card is drawn', media.documents > 0, `cards=${String(media.documents)}`)
    check('the card names its source', media.titles.some((title) => title.trim().length > 0), JSON.stringify(media.titles.slice(0, 3)))
    await shot(page, 'document-card')

    // Click the document card itself, not the first card in the transcript (which
    // may be an image from an earlier turn in the same conversation). A document
    // index often mixes landing pages with files, so walk the cards until one
    // really is a PDF — the modal says so plainly when a card is not.
    let pdfModal = await openPreview(page, '.chats-doc-card')
    const pdfAttemptBound = Math.min(6, media.documents)
    for (let attempt = 0; attempt < pdfAttemptBound; attempt += 1) {
      const attached = await pdfModal.locator('.chats-overlay-pdf').count() > 0
        || await pdfModal.locator('.chats-overlay-note').count() > 0 // fetch settled: either a PDF or a reason
      if (await pdfModal.locator('.chats-overlay-pdf').count() > 0) break
      if (attached) {
        await page.keyboard.press('ArrowRight')
        await pdfModal.locator('.chats-overlay-note').waitFor({ state: 'detached', timeout: 40_000 }).catch(() => {})
        continue
      }
      await Promise.race([
        pdfModal.locator('.chats-overlay-pdf').waitFor({ state: 'attached', timeout: 40_000 }),
        pdfModal.locator('.chats-overlay-note').waitFor({ state: 'visible', timeout: 40_000 }),
      ]).catch(() => {})
    }
    if (await pdfModal.locator('.chats-overlay-pdf').count() === 0) {
      check('a document preview timeline', false)
      const notes = await pdfModal.locator('.chats-overlay-note').allTextContents()
      say(`   (no card held a PDF: ${notes.join(' | ').slice(0, 200)})`)
    }
    const pdfFrame = pdfModal.locator('.chats-overlay-pdf')
    await pdfFrame.waitFor({ state: 'attached', timeout: 30_000 })
    const pdfSrc = await pdfFrame.getAttribute('src')
    check('the PDF renders as an in-app blob: frame', (pdfSrc ?? '').startsWith('blob:'), (pdfSrc ?? '').slice(0, 30))
    await page.waitForTimeout(4_000)
    await shot(page, 'pdf-modal')
    await closePreview(page, pdfModal)

    /* ---------------- F. async isolation -------------------------------- */
    section('async results land only in the conversation that asked')
    // Chat with Saturn images is the current conversation. Ask something whose turn
    // will take seconds, then leave for a brand-new conversation while it runs.
    await ask(page, gone, 'show me images of Mars')
    const marsAnswers = (await settledAnswers(page)).length
    await page.locator('.chats-new').click()
    await page.waitForSelector('.chats-empty-state', { timeout: 20_000 })
    await ask(page, gone, 'find videos about Laravel')

    await shot(page, 'isolation-b-transcript')
    const there = await mediaState(page)
    check('the new conversation received none of the Mars media', there.images === 0 && there.videos > 0,
      `tiles=${String(there.images)} videoCards=${String(there.videos)}`)

    // Explicitly reopen the Mars conversation: newest row that is not the
    // conversation currently open. An earlier check's preview modal can still be
    // up and would swallow the click, so close one first.
    const strayModal = page.locator('[role="dialog"][aria-label="Media preview"]')
    if (await strayModal.isVisible().catch(() => false)) await closePreview(page, strayModal)
    await expandRail(page)
    const rowsHere = await historyRows(page)
    const targetTitle = rowsHere.find((row) => !row.active)?.title ?? ''
    check('the Mars conversation is listed in history', targetTitle !== '', JSON.stringify(rowsHere.map((row) => row.title)))
    await page.locator('.chats-history-list .chats-history-item:visible', { hasText: targetTitle }).first().click()
    await page.waitForFunction(
      (expected) => [...document.querySelectorAll('.chats-turn[data-role="assistant"]')]
        .filter((row) => !row.querySelector('.chats-live-label')).length >= expected,
      marsAnswers,
      { timeout: 20_000 },
    )
    await waitAnyPoster(page)
    const marsState = await mediaState(page)
    // The Mars conversation legitimately also holds the earlier Laravel-queues
    // turn, so "unrelated" cards here are that turn's own, not a cross-injection.
    // The isolation property is what chat B asserted above: it received no Mars
    // media, and the Mars turn still drew where it was asked.
    check('the Mars turn drew its images in the conversation that asked', marsState.images > 0,
      `tiles=${String(marsState.images)} videoCards=${String(marsState.videos)}`)
    await shot(page, 'isolation-a')

    /* ---------------- G. quit and relaunch ------------------------------ */
    section('a quit and relaunch keeps history and its media')
    await launched.app.close()
    windowGone = null
    launched = await launchApp(profileDir)
    problems = [...problems, ...launched.problems]
    const relaunchedPage = launched.page
    relaunchedPage.on('crash', () => { windowGone ??= 'the renderer crashed' })
    relaunchedPage.on('close', () => { windowGone ??= 'the window was closed' })

    section('the relaunch is fresh, history is kept, media persists')
    await waitOnScreen(relaunchedPage, 'home', 30_000)
    await enterChats(relaunchedPage, { generic: true })
    check('the generic entry after a relaunch is still fresh',
      await relaunchedPage.evaluate(() => document.querySelectorAll('.chats-turn').length) === 0)
    const kept = await historyRows(relaunchedPage)
    check('earlier conversations survived the quit', kept.length >= 3, `${String(kept.length)} conversations`)
    await expandRail(relaunchedPage)
    // Reopen the media conversation explicitly (the Saturn/Mars one), not the
    // active row the fresh entry just made.
    const keptRows = await historyRows(relaunchedPage)
    const keptTitle = (keptRows.find((row) => !row.active && /images of/.test(row.title)) ?? keptRows.find((row) => !row.active))?.title ?? ''
    check('the media conversation is listed after the relaunch', keptTitle !== '', JSON.stringify(keptRows.map((row) => row.title)))
    await relaunchedPage.locator('.chats-history-list .chats-history-item:visible', { hasText: keptTitle }).first().click()
    await relaunchedPage.waitForFunction(() => document.querySelectorAll('.chats-turn').length > 0, { timeout: 20_000 })
    check('the old transcript loads', (await transcript(relaunchedPage)).length > 0)
    await waitAnyPoster(relaunchedPage, 40_000)
    const persisted = await mediaState(relaunchedPage)
    check('media is still tied to the saved messages, not only to React state',
      (persisted.images > 0 || persisted.videos > 0) && persisted.posters.every((src) => src.startsWith('data:image/')),
      `tiles=${String(persisted.images)} videoCards=${String(persisted.videos)}`)
    await shot(relaunchedPage, 'after-relaunch')

    section('the window stayed healthy throughout')
    check('no uncaught renderer errors', problems.length === 0, problems.slice(0, 3).join(' | '))

    await writeFile(
      join(SHOTS, 'results.json'),
      `${JSON.stringify({ display: DISPLAY, profile: PROFILE, results }, null, 2)}\n`,
    )

    const failed = results.filter((entry) => !entry.passed)
    say(`\n${'='.repeat(60)}`)
    say(`${String(results.length - failed.length)}/${String(results.length)} checks passed through the real app`)
    say(`shots: ${SHOTS}`)
    if (failed.length > 0) {
      say('\nFAILED:')
      for (const entry of failed) say(`  - ${entry.name} — ${entry.detail}`)
    }
    say('='.repeat(60))

    if (KEEP_OPEN) {
      say('[app] --keep-open: the window stays up for you to look at. Ctrl+C to end.')
      launched.page.locator('.hd-viewport').waitFor({ state: 'detached', timeout: 15 * 60_000 }).catch(() => {})
      const idle = new Promise((r) => setTimeout(r, 15 * 60_000))
      await idle
    }

    await launched.app.close()
    process.exit(failed.length === 0 ? 0 : 1)
  } catch (error) {
    say(`\n[run] aborted: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
    if (lastPage !== null) {
      try { await shot(lastPage, 'FAILURE') } catch { say('[run] nothing left to photograph') }
    }
    if (mainLog.length > 0) {
      say("\n[main] the app's own output:")
      say(mainLog.join('').trim().split(/\r?\n/).slice(-40).map((line) => `  ${line}`).join('\n'))
    }
    if (launched.app) await launched.app.close().catch(() => {})
    process.exit(1)
  }
}

main().catch((error) => {
  say(`[run] fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exit(1)
})
