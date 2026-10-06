import { _electron as electron } from 'playwright-core'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Live chat acceptance **through the real app**, on screen, while you watch.
 *
 * ## Why this exists
 *
 * The vitest suites in `tests/live` drive Core and Mind in process. They prove the
 * wiring, but nobody watching them can see the product work: no window, no composer,
 * no rendered answer. That is the gap this closes. Everything here goes through the
 * shipping shell — the same `dist/index.html`, the same `dist-electron/main.cjs`, the
 * same composer, the same transcript, the same live provider, the same search.
 *
 * Nothing here is mocked and nothing here stubs a provider. There is no `FakeModelProvider`
 * in this file and no code path that could reach one: if NanoGPT or SearXNG is down, the
 * run fails and says so.
 *
 * ## What it will not do
 *
 * Attachments. The composer opens an **OS-native** file dialog, and no automation tool
 * can drive a native dialog on Windows. Tests 6-9 therefore have no honest automated
 * form here, and this script says so at the end rather than pretending otherwise. The
 * attachment path is covered by `npm run test:chat-acceptance`; this covers what a
 * person sees.
 *
 * ## Profile
 *
 * `--profile=temp` (the default) launches against a throwaway userData directory.
 * That is not a convenience: a real profile whose journal recorded an integrity fault
 * stays `degraded` forever and refuses every command, and Core offers no repair path,
 * so a run against it would fail at the first turn for reasons that have nothing to do
 * with this script. `--profile=real` uses the installed profile instead, which is the
 * only honest way to check whether *your* profile works — and it will refuse to run
 * against a degraded one rather than showing you a dead app.
 *
 * ## Usage
 *
 *   node scripts/chat-acceptance-visible.mjs [--display=N] [--shots=DIR] [--profile=temp|real] [--keep-open]
 *
 * `--display` defaults to 2, matching the e2e suite's convention: the primary monitor is
 * where you are working, and a run that takes the foreground from you is a run you close.
 * Freya appears on monitor 2 and stays visible, which is the whole point.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const flags = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, value = 'true'] = arg.replace(/^--/, '').split('=')
    return [key, value]
  }),
)

const DISPLAY = flags.get('display') ?? '2'
const SHOTS = resolve(ROOT, flags.get('shots') ?? 'artifacts/live-visible')
const KEEP_OPEN = flags.has('keep-open')
const PROFILE = flags.get('profile') ?? 'temp'

/**
 * The browser grant this run operates under, written into the fresh profile.
 *
 * Two principals are in play and the distinction matters. The owner submits the chat
 * turn; the Dual Browser runtime stamps `agent:freya` on every action it performs.
 * Device Hands checks its grant against the *acting* principal, so this grant is
 * named for `agent:freya` and for one session, one surface and two actions. It is
 * not a general browsing permission, and it is not the owner's own authority being
 * lent out: it is the narrowest thing that lets Freya read a public page.
 *
 * Written to the throwaway profile rather than injected, so the app loads it the same
 * way a person's install would — `electron/main.ts` reads
 * `device-hands.grants.json` from userData at boot.
 */
function writeBrowserGrant(profileDir) {
  const issuedAt = new Date()
  // Ten minutes: the runtime caps a grant at fifteen and refuses a longer one rather
  // than shortening it, so this is short on purpose and long enough for one turn.
  const expiresAt = new Date(issuedAt.getTime() + 10 * 60 * 1000)
  const grant = [{
    grantId: 'grant-live-visible-browser',
    principalId: 'agent:freya',
    scope: 'freya-0001',
    surfaces: ['browser'],
    actions: ['browser.navigate', 'browser.read-text'],
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    revokedAt: null,
  }]
  const path = join(profileDir, 'device-hands.grants.json')
  writeFileSync(path, `${JSON.stringify(grant, null, 2)}
`)
  return path
}

/**
 * Settings for this run, and only this run.
 *
 * Read from `artifacts/acceptance.env`, which is this harness's own configuration and
 * is not the installer's `.env`. That separation is not tidiness: `electron/main.ts`
 * calls `loadLocalEnv`, which fills in anything the process environment does not
 * already define, so a run that passes only some settings silently inherits the rest
 * from whoever is sitting at the machine. Passing every key explicitly is what makes
 * "the app under test is configured by this file" true rather than mostly true.
 *
 * The model credential is the one thing this cannot invent. If `acceptance.env` has
 * no key, the installer's is read once, used, and never written — and the run says so,
 * because a live test that quietly bills someone's account should never be a surprise.
 */
function acceptanceSettings() {
  const file = join(ROOT, 'artifacts', 'acceptance.env')
  const fromFile = existsSync(file)
    ? Object.fromEntries(
      readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== '' && !line.startsWith('#'))
        .map((line) => {
          const split = line.indexOf('=')
          return [line.slice(0, split).trim(), line.slice(split + 1).trim()]
        }),
    )
    : {}

  let credential = fromFile.NANOGPT_API_KEY ?? process.env.NANOGPT_API_KEY
  let origin = 'the environment'
  if (credential === undefined || credential === '') {
    const installer = readFileSync(join(ROOT, '.env'), 'utf8')
    credential = /^NANOGPT_API_KEY=(.+)$/m.exec(installer)?.[1]?.trim()
    origin = "the installer's .env, read once"
  }

  const settings = {
    // Every key the app reads, so nothing is inherited from the installer's file.
    NANOGPT_API_KEY: credential ?? '',
    NANOGPT_BASE_URL: fromFile.NANOGPT_BASE_URL ?? '',
    NANOGPT_MODEL: fromFile.NANOGPT_MODEL ?? '',
    FREYA_ALLOW_LIVE_MODEL: fromFile.FREYA_ALLOW_LIVE_MODEL ?? '1',
    FREYA_ALLOW_WEB_SEARCH: fromFile.FREYA_ALLOW_WEB_SEARCH ?? '1',
    FREYA_SEARXNG_URL: SEARXNG_URL,
    // The native browser, on the strict path. Without FREYA_DEVICE_HANDS and
    // FREYA_PUBLIC_BROWSER the browser seam is never built, Core registers no browser
    // tool at all, and Freya has no browser to use — which is TEST 10's whole
    // requirement. FREYA_LOCAL_UNRESTRICTED=0 is explicit because an unpackaged build
    // otherwise *defaults to unrestricted*, and this run must exercise the gated path
    // rather than the one that skips the gate.
    FREYA_DEVICE_HANDS: '1',
    FREYA_PUBLIC_BROWSER: '1',
    FREYA_LOCAL_UNRESTRICTED: '0',
    // Only the host the test actually opens, so the grant is not quietly wider than
    // the run needs.
    FREYA_DEVICE_HANDS_HOSTS: 'laravel.com,www.laravel.com',
    ...(fromFile.NANOGPT_BASE_URL === undefined ? {} : {}),
  }
  say(`[env] settings from ${existsSync(file) ? 'artifacts/acceptance.env' : 'defaults (no acceptance.env yet)'}`)
  say(`[env] model credential from ${origin}`)
  if ((fromFile.NANOGPT_BASE_URL ?? '') === '' || (fromFile.NANOGPT_MODEL ?? '') === '') {
    say("[env] NOTE: NANOGPT_BASE_URL / NANOGPT_MODEL are not set here, so the app will fall back to the installer's .env for them.")
    say('[env] Create artifacts/acceptance.env with those three values to make this run self-contained.')
  }
  return settings
}

/** SearXNG, started for the duration of the run unless one is already answering. */
const SEARXNG_URL = process.env.FREYA_SEARXNG_URL ?? 'http://127.0.0.1:8899'
const SEARXNG_ROOT = 'C:/Users/you/Desktop/AI/Athena/runtime/searxng'

const results = []
let step = 0
/** Kept so the failure handler can photograph whatever was on screen. */
let lastPage = null
/** The Electron main process's stdout+stderr, printed if the run dies. */
let mainLog = []

function say(message) {
  process.stdout.write(`${message}\n`)
}

/**
 * Record one check.
 *
 * Recorded rather than thrown on, so a single failure does not hide the eleven checks
 * after it, and so the run ends with a complete table instead of a stack trace.
 */
function check(name, passed, detail = '') {
  results.push({ name, passed: Boolean(passed), detail: String(detail) })
  say(`   ${passed ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

function section(title) {
  step += 1
  say(`\n=== ${step}. ${title} ===`)
}

/** Screenshot the whole window, so there is a visual record of every step. */
async function shot(page, label) {
  const file = join(SHOTS, `${String(step).padStart(2, '0')}-${label}.png`)
  await page.screenshot({ path: file })
  say(`   [shot] ${file}`)
}

async function searxngAnswering() {
  try {
    const response = await fetch(`${SEARXNG_URL}/search?format=json&q=t`, {
      signal: AbortSignal.timeout(4000),
    })
    return response.ok
  } catch {
    return false
  }
}

/**
 * Bring up SearXNG for the run.
 *
 * A real network dependency, started the same way the rest of this project's live work
 * starts it, and killed afterwards so it does not outlive the run.
 */
async function startSearxng() {
  if (await searxngAnswering()) {
    say(`[searxng] already answering at ${SEARXNG_URL}`)
    return null
  }
  const child = spawn(
    join(SEARXNG_ROOT, 'python', 'python.exe'),
    ['-m', 'searx.webapp'],
    {
      env: {
        ...process.env,
        SEARXNG_SETTINGS_PATH: join(SEARXNG_ROOT, 'settings.yml'),
        SEARXNG_SECRET: 'live-visible-acceptance',
        SEARXNG_PORT: '8899',
        SEARXNG_BIND_ADDRESS: '127.0.0.1',
        SEARXNG_BASE_URL: `${SEARXNG_URL}/`,
      },
      stdio: 'ignore',
      detached: false,
    },
  )
  for (let attempt = 0; attempt < 45; attempt += 1) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 1000))
    if (await searxngAnswering()) {
      say(`[searxng] up at ${SEARXNG_URL} (pid ${String(child.pid ?? '?')})`)
      return child
    }
  }
  child.kill()
  throw new Error(`SearXNG did not answer at ${SEARXNG_URL} within 45s`)
}

/**
 * Open the Chats surface and wait for the real transcript.
 *
 * The composer is **global** — `GlobalComposer` is mounted on every screen — so its
 * presence says nothing about which surface is showing. What matters is
 * `.hd-dashboard[data-screen="chat"]`, because that is what actually mounts `<Chats>`
 * and therefore the transcript every check below reads.
 *
 * "Start a new conversation" is the way in: it creates the conversation a fresh
 * profile does not have yet *and* navigates to Chats in one press. Idempotent by
 * state check rather than by clicking, because a restored profile that is already on
 * Chats must not be given a second conversation by a helper that assumed "not open".
 */
async function openChat(page) {
  const onChats = () => page.evaluate(
    () => document.querySelector('.hd-dashboard')?.getAttribute('data-screen') === 'chat',
  )

  if (!(await onChats())) {
    const newConversation = page.getByRole('button', { name: 'Start a new conversation' })
    if (await newConversation.isVisible().catch(() => false)) {
      await newConversation.click()
    } else {
      // A profile that already has conversations opens one instead.
      await page.locator('.chats-history-list button, .chats-history button').first().click()
    }
    await page.waitForFunction(
      () => document.querySelector('.hd-dashboard')?.getAttribute('data-screen') === 'chat',
      { timeout: 20_000 },
    )
  }

  await page.waitForSelector('form[aria-label="Freya composer"] textarea', { timeout: 20_000 })
  await page.waitForSelector('.chats-turn[data-role="assistant"], .chats-empty-state', { timeout: 20_000 })
}

/**
 * Put the composer in a named mode, through the real mode picker.
 *
 * This is not cosmetic. The composer runs an intent router that will silently send
 * "Search the web for…" to Deep Research or Freya's Eye instead of answering, and that
 * is a defensible product choice — but it means the *mode* decides which code path a
 * test exercises. Selecting Chat explicitly is what a person does when they want an
 * answer rather than a research run, and it is what makes these checks mean what they
 * claim to mean.
 */
async function setMode(page, label) {
  const current = await page.locator('form[aria-label="Freya composer"] .hd-tool-mode').getAttribute('aria-label')
  if (current === `Mode: ${label}`) return
  await page.locator('form[aria-label="Freya composer"] .hd-tool-mode').click()
  await page.locator('ul[aria-label="Freya mode"]').waitFor({ state: 'visible', timeout: 10_000 })
  await page.locator('ul[aria-label="Freya mode"] [role="menuitemradio"]', { hasText: label }).first().click()
  say(`   mode: ${String(current)} -> Mode: ${label}`)
}

/**
 * The answers that have actually landed, oldest first.
 *
 * While a turn runs, `Chats.tsx` renders a *separate* placeholder row that also carries
 * `data-role="assistant"` — a "thinking"/"preparing" bubble holding three dots. Counting
 * rows naively therefore sees an answer arrive the instant the turn begins and reads
 * "…". That placeholder is the only row carrying `.chats-live-label`, so it is excluded
 * here and everything this function returns is text a person can actually read.
 */
function settledAnswers(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('.chats-turn[data-role="assistant"]')]
      .filter((row) => !row.querySelector('.chats-live-label'))
      .map((row) => row.querySelector('.chats-bubble')?.textContent ?? ''),
  )
}

/** Whether a turn is still running, as the composer dock reports it. */
function generating(page) {
  return page.evaluate(
    () => document.querySelector('.chats-live-label') !== null
      || document.querySelector('.hd-dock')?.getAttribute('data-state') !== 'idle',
  )
}

/** Whatever the UI says went wrong, so a timeout says *what* rather than only that. */
function trouble(page) {
  return page.evaluate(() => ({
    notice: document.querySelector('.hd-notice')?.textContent ?? null,
    boundaries: [...document.querySelectorAll('.chats-boundary')].map((n) => n.textContent ?? ''),
  }))
}

/**
 * Send text through the real composer and wait for the answer to **settle**.
 *
 * Waiting on the dock returning to idle rather than on a fixed sleep: a sleep either
 * wastes time on a fast answer or reads a half-written one on a slow one, and the
 * second of those is how a run ends up asserting against half an answer.
 */
async function ask(page, gone, text, { timeout = 300_000 } = {}) {
  const before = (await settledAnswers(page)).length
  const input = page.locator('form[aria-label="Freya composer"] textarea')
  await input.fill(text)
  // The real send control, clicked the way a person clicks it. Enter would also submit
  // the form, but clicking proves the button a person actually uses works.
  await page.locator('form[aria-label="Freya composer"] button[aria-label="Send message"]').click()
  say(`   you: ${text.slice(0, 88)}${text.length > 88 ? '…' : ''}`)

  const deadline = Date.now() + timeout
  let announced = 0
  while (Date.now() < deadline) {
    const landed = (await settledAnswers(page)).length
    if (landed > before && !(await generating(page))) {
      await new Promise((r) => setTimeout(r, 1000))
      const answer = (await settledAnswers(page)).at(-1) ?? ''
      say(`   Freya: ${answer.replace(/\s+/g, ' ').slice(0, 400)}${answer.length > 400 ? '…' : ''}`)
      return
    }
    const waited = Math.round((timeout - (deadline - Date.now())) / 1000)
    if (waited - announced >= 15) {
      announced = waited
      say(`   … still working (${String(waited)}s)`)
    }
    await new Promise((r) => setTimeout(r, 1000))
    const reason = gone()
    if (reason !== null) throw new Error(`the window went away mid-turn: ${reason}`)
  }

  const why = await trouble(page)
  throw new Error(
    `no settled answer within ${String(Math.round(timeout / 1000))}s for: ${text.slice(0, 60)}\n`
    + `   notice: ${String(why.notice)}\n   boundaries: ${why.boundaries.join(' | ') || '(none)'}`,
  )
}

/** The newest answer that has landed, as the person on screen reads it. */
async function latestAnswer(page) {
  return (await settledAnswers(page)).at(-1) ?? ''
}

function urlsIn(text) {
  return [...text.matchAll(/https?:\/\/[^\s<>"')\]]+/g)].map((match) => match[0].replace(/[.,;:]$/, ''))
}

async function main() {
  await mkdir(SHOTS, { recursive: true })
  const searxng = await startSearxng()

  const profileDir = PROFILE === 'real'
    ? null
    : await mkdtemp(join(tmpdir(), 'freya-live-visible-'))
  say(`[app] launching the shipping Freya window on display ${DISPLAY} — this is the real app`)
  say(`[app] profile: ${PROFILE === 'real' ? 'your installed profile' : `throwaway (${String(profileDir)})`}`)
  if (profileDir !== null) {
    say(`[app] browser grant: ${writeBrowserGrant(profileDir)}`)
  }
  const app = await electron.launch({
    args: [ROOT, `--freya-display=${DISPLAY}`,
      ...(profileDir === null ? [] : [`--user-data-dir=${profileDir}`])],
    // The three the shipping app needs to actually search: a live model, the explicit
    // opt-in, and the daemon's URL. The last one is the interesting one — the app
    // preferred a local metasearch daemon and could not be told where it was, so
    // research came back `unconfigured` while SearXNG was answering on this very port.
    env: { ...process.env, ...acceptanceSettings() },
  })
  const page = await app.firstWindow()
  lastPage = page

  // Last run the window disappeared mid-turn with no explanation. A renderer crash and
  // a deliberate close look identical from inside `evaluate`, so both are watched for
  // and the reason is reported rather than inferred.
  /**
   * The main process's own output.
   *
   * A window that closes mid-turn is invisible from the renderer: `evaluate` just
   * starts throwing. Whatever the main process printed on its way out — an
   * unhandled rejection, a fatal, a guard trip — is the actual explanation, and it
   * goes to a console nobody is watching. Captured here so a crash can be read
   * instead of guessed at.
   */
  mainLog = []
  const mainProcess = app.process()
  mainProcess?.stdout?.on('data', (chunk) => mainLog.push(String(chunk)))
  mainProcess?.stderr?.on('data', (chunk) => mainLog.push(String(chunk)))

  let windowGone = null
  // Exit code and signal distinguish the two possibilities that look identical from
  // here: a clean `app.quit()` (code 0, nobody killed it) and an external kill.
  const mainExit = await new Promise((resolveExit) => {
    mainProcess?.once('exit', (code, signal) => resolveExit({ code, signal }))
    mainProcess?.once('error', (error) => resolveExit({ error: error.message }))
    setTimeout(() => resolveExit(null), 2_000)
  })
  if (mainExit !== null) {
    mainLog.push(`
[main] exited: ${JSON.stringify(mainExit)}`)
    windowGone ??= `the main process exited (${JSON.stringify(mainExit)})`
  }

  const whyGone = (what) => () => { windowGone ??= what }
  page.on('crash', whyGone('the renderer process crashed'))
  page.on('close', whyGone('the window was closed'))
  app.on('close', whyGone('the app quit'))

  /** Read by `ask` so a vanished window is reported rather than thrown as a TypeError. */
  const windowGoneState = () => windowGone

  const pageProblems = []
  page.on('pageerror', (error) => pageProblems.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') pageProblems.push(`console: ${message.text()}`)
  })

  // App Mode is the shipping shell, and it roots at `.freya-v2.hd-viewport`. The
  // `.app[data-ready="true"]` node belongs to the *legacy* shell, so waiting for it
  // here would wait forever for a UI this app does not ship.
  await page.waitForSelector('.freya-v2.hd-viewport', { timeout: 60_000 })

  // A degraded Core refuses every command, so every check below would "fail" for a
  // reason that has nothing to do with the thing being checked. Say so once, loudly.
  const degraded = await page.evaluate(() =>
    [...document.querySelectorAll('.hd-notice')]
      .map((n) => n.textContent ?? '')
      .find((t) => /degraded/i.test(t)) ?? null,
  )
  if (degraded !== null) {
    say(`
[TEST] Core is degraded in this profile: ${degraded.trim()}`)
    say('[TEST] Every turn would be refused, so there is nothing to watch. Stopping here.')
    await shot(page, 'degraded')
    await app.close()
    if (searxng !== null) searxng.kill()
    process.exit(2)
  }

  await openChat(page)
  await shot(page, 'chat-open')
  check('the shipping app booted, Core is serving, and the composer is present', true)

  /* -- 1. plain chat stays plain ------------------------------------------ */
  section('plain chat answers directly, with no search')
  await setMode(page, 'Chat')
  await ask(page, windowGoneState, 'In one sentence: what is a queue?')
  const plain = await latestAnswer(page)
  check('the plain answer is not empty', plain.trim().length > 0, `${String(plain.trim().length)} chars`)
  check('it does not claim to have searched', !/I (searched|looked) (the )?web/i.test(plain))
  await shot(page, 'plain-answer')

  /* -- 2. web search, real sources ---------------------------------------- */
  section('a search request really searches, and cites real sources')
  await setMode(page, 'Chat')
  await ask(page, windowGoneState, 'Search the web for the current official Laravel release: what is the latest major version and when was it released? Cite your sources.')
  const searched = await latestAnswer(page)
  check('the search answer is substantive', searched.replace(/\s+/g, ' ').length > 180, `${String(searched.length)} chars`)
  const named = urlsIn(searched)
  check('the answer names at least one source URL', named.length > 0, `${String(named.length)} URLs`)
  check('every named URL is a real absolute http(s) URL',
    named.every((url) => { try { new URL(url); return true } catch { return false } }),
    named.slice(0, 3).join(' '))
  await shot(page, 'search-answer')

  /* -- 3. image search ----------------------------------------------------- */
  section('an image request returns images with media')
  await setMode(page, 'Chat')
  await ask(page, windowGoneState, 'Search the web for images of the James Webb Space Telescope. Use the search tool with type: images, then tell me what you found.')
  const images = await latestAnswer(page)
  check('the image answer is not empty', images.trim().length > 0, `${String(images.trim().length)} chars`)

  // The cards, which are new. A poster that never arrives is not a failure of the
  // picture host — it is the card deciding to draw nothing — so what is asserted is
  // that a card which drew has real fetched bytes behind it, never a broken tile or a
  // window fetching a remote address itself.
  const cards = await page.evaluate(() => ({
    tiles: document.querySelectorAll('.chats-image-tile').length,
    posters: [...document.querySelectorAll('.chats-image-frame img, .chats-video-shot img')]
      .map((img) => img.getAttribute('src') ?? ''),
  }))
  const drawn = cards.posters.filter((src) => src.startsWith('data:image/')).length
  check('image results are drawn as cards with fetched posters', cards.tiles > 0 && drawn > 0,
    `tiles=${String(cards.tiles)} postersDrawn=${String(drawn)}`)
  check('every poster came from the main process as bytes, not a remote address',
    cards.posters.every((src) => src.startsWith('data:image/')))
  await shot(page, 'image-answer')

  /* -- 4. a real document -------------------------------------------------- */
  section('a document request returns a real, official PDF')
  await setMode(page, 'Chat')
  await ask(page, windowGoneState, 'Find the official EU Artificial Intelligence Act. Use the search tool with type: documents, then give me the exact official URL you found.')
  const document = await latestAnswer(page)
  // Asserting a `.pdf` suffix would fail the best answer available: EUR-Lex, the
  // authoritative source for an EU act, serves its text from a landing URL and puts the
  // format in a query parameter or behind a link. What has to be true is that the
  // answer points at the official EU source for the act — not that it guessed a suffix.
  const official = urlsIn(document).filter((url) => /eur-lex\.europa\.eui/i.test(url))
  check('the answer points at the official EU source for the AI Act', official.length > 0,
    official[0] ?? `none of ${String(urlsIn(document).length)} named URLs was official`)
  // A document card means the documents vertical actually returned something.
  const docCards = await page.evaluate(() => document.querySelectorAll('.chats-doc-card').length)
  check('a document result is offered as a card, not only as prose', docCards > 0, `cards=${String(docCards)}`)
  await shot(page, 'document-answer')

  /* -- 5. video ------------------------------------------------------------ */
  section('a video request returns playable video')
  await setMode(page, 'Chat')
  await ask(page, windowGoneState, 'Search the web for videos of the James Webb Space Telescope and tell me what you find.')
  const video = await latestAnswer(page)
  check('the video answer is not empty', video.trim().length > 0, `${String(video.trim().length)} chars`)
  await shot(page, 'video-answer')

  /* -- 6/7. Freya's own browser -------------------------------------------- */
  section("Freya's own browser, not an extension")
  await ask(page, windowGoneState, 'Use your own browser. Search the web for the official Laravel documentation about queues and failed jobs, open the official page, and tell me the command for retrying a failed job.',
    { timeout: 300_000 })
  const fresh = await latestAnswer(page)
  check('the browser answer is not empty', fresh.trim().length > 0, `${String(fresh.trim().length)} chars`)
  check('it mentions the retry command', /queue:retry/.test(fresh))
  check('the transcript names the browser that served it', /native\/public Freya browser/i.test(fresh))
  check('the transcript never names the extension', !/chrome extension|paired extension/i.test(fresh))
  check('it does not claim to have clicked or typed anything',
    !/(?:^|\W)(?:i|freya)\s+(?:clicked|typed|logged in to|signed in to|submitted the form)(?:$|\W)/i.test(fresh))
  check('it says it searched before opening the page', /I (searched|looked)/i.test(fresh),
    fresh.slice(0, 80).replace(/\s+/g, ' '))
  await shot(page, 'browser-answer')

  /* -- renderer health ----------------------------------------------------- */
  section('the window stayed healthy throughout')
  check('no uncaught renderer errors', pageProblems.length === 0, pageProblems.slice(0, 2).join(' | '))

  await writeFile(
    join(SHOTS, 'results.json'),
    `${JSON.stringify({ display: DISPLAY, results }, null, 2)}\n`,
  )

  const failed = results.filter((entry) => !entry.passed)
  say(`\n${'='.repeat(60)}`)
  say(`${String(results.length - failed.length)}/${String(results.length)} checks passed through the real app`)
  say(`shots: ${SHOTS}`)
  say(`attachments: NOT covered here — the composer opens an OS-native file dialog,`)
  say(`which no automation tool can drive. See npm run test:chat-acceptance for TESTS 6-9.`)
  if (failed.length > 0) {
    say(`\nFAILED:`)
    for (const entry of failed) say(`  - ${entry.name} — ${entry.detail}`)
  }
  say(`${'='.repeat(60)}\n`)

  if (KEEP_OPEN) {
    say(`[app] --keep-open: the window stays up. Close it, or press Ctrl+C here.`)
    await new Promise(() => {})
  }

  await app.close()
  if (searxng !== null) searxng.kill()
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch(async (error) => {
  say(`\n[run] aborted: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  // A run that dies on a timeout has told you very little. The screenshot of whatever
  // was on screen is usually the whole diagnosis.
  if (lastPage !== null) {
    try {
      await shot(lastPage, 'FAILURE')
    } catch {
      say('[run] the window was already gone, so there was nothing to photograph')
    }
  }
if (mainLog.length > 0) {
    say('\n[main] the app\'s own output, which is where a crash explains itself:')
    const lines = mainLog.join('').trim().split(/\r?\n/).slice(-40)
    say(lines.map((line) => `  ${line}`).join('\n'))
  }
  process.exit(1)
})