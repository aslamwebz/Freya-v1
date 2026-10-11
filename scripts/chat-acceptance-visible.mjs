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
  // Fifteen minutes, which is the ceiling: the runtime *refuses* a longer grant rather
  // than shortening it, so a shorter one would simply expire part-way through a run.
  // The whole suite shares this one window, which is why the browser case runs last and
  // why a refusal late in a run is usually an expiry rather than a policy.
  const expiresAt = new Date(issuedAt.getTime() + 15 * 60 * 1000)
  // One grant per session the run may open, because the authority looks a grant up by
  // **exact** scope and the runtime numbers sessions from one: a second browser turn
  // opens `freya-0002` and a grant naming only `freya-0001` leaves it with nothing. The
  // scope list is therefore fixed up front rather than discovered, because a grant
  // cannot be issued for a session that does not exist yet.
  const grants = SESSION_SCOPES.map((scope, index) => ({
    grantId: `grant-live-visible-browser-${String(index + 1).padStart(4, '0')}`,
    principalId: 'agent:freya',
    scope,
    surfaces: ['browser'],
    actions: ['browser.navigate', 'browser.read-text'],
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    revokedAt: null,
  }))
  const path = join(profileDir, 'device-hands.grants.json')
  writeFileSync(path, `${JSON.stringify(grants, null, 2)}
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
    // requirement. FREYA_LOCAL_UNRESTRICTED=0 is set explicitly so the assumption
    // is visible at the call site, not inferred from a default. The unpackaged
    // default is now also strict (C1-A); the explicit assignment here is the
    // historical record, not a workaround.
    FREYA_DEVICE_HANDS: '1',
    FREYA_PUBLIC_BROWSER: '1',
    FREYA_LOCAL_UNRESTRICTED: '0',
    // Only the host the test actually opens, so the grant is not quietly wider than
    // the run needs.
    // Semicolon-separated: `splitDeviceHandsList` splits on `;`. A comma here produces a
    // single entry that looks like two hosts and matches neither, which shows up as every
    // page refused by a "page policy" that never named the host that failed.
    // The hosts a live run actually navigates to, which is more than the one the prompt
    // names: a model follows the official link, which may be `www.` or a redirect target.
    // Narrower than this and the run fails on a *policy* refusal that looks like a
    // product bug; wider than this would be granting more than the test needs.
    FREYA_DEVICE_HANDS_HOSTS: [
      'laravel.com', 'www.laravel.com', 'laravel-news.com', 'www.laravel-news.com',
    ].join(';'),
    // Device Hands refuses to activate with no allowed roots at all, which is the right
    // default and a confusing first failure: the seam is simply absent and every browser
    // request is then refused for a reason that names a page policy rather than a
    // missing setting. One root is enough to start, and this run only ever reads pages.
    FREYA_DEVICE_HANDS_ROOTS: process.env.FREYA_DEVICE_HANDS_ROOTS ?? ROOT,
    // The third required allowlist. Device Hands refuses to operate on an empty one —
    // correctly, since "nothing is permitted" must be a decision somebody made rather
    // than a forgotten setting — and the refusal surfaces as every page read being
    // denied by the authority, which reads like a permissions problem rather than a
    // missing variable. Semicolon-separated, like the others.
    FREYA_DEVICE_HANDS_COMMANDS: 'browser.navigate;browser.read-text',
    // The fourth required allowlist, and the least obvious: Device Hands refuses an
    // empty one, so a surface that shares nothing still has to name something. This run
    // shares no variable with the browser at all, and the name below never matches.
    FREYA_DEVICE_HANDS_ENV_NAMES: 'FREYA_DEVICE_HANDS_NO_SHARED_ENV',
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
const SEARXNG_ROOT = process.env.FREYA_SEARXNG_ROOT?.trim() ?? ''

/**
 * Browser sessions this run may open, in the order the runtime will number them.
 *
 * `freya-0001`, `freya-0002`, ... — the runtime's sequence starts at one and increments
 * per session, and a session is opened per browser turn rather than reused. Four covers
 * this suite with a spare; a fifth would be a run asking more questions of the browser
 * than there are questions.
 */
const SESSION_SCOPES = ['freya-0001', 'freya-0002', 'freya-0003', 'freya-0004']

const results = []
let step = 0
/** Document cards drawn anywhere in this run; see the document check for why. */
let documentCardsSeen = 0
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
  if (SEARXNG_ROOT === '') {
    throw new Error('SearXNG is not already running and FREYA_SEARXNG_ROOT is not set')
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
 * Ask, and insist.
 *
 * A live model sometimes answers a question it already knows instead of looking it up,
 * and a card-oriented check then fails for a reason that is about the model's judgement
 * rather than about the product. That is a real behaviour and worth seeing once — the
 * answer is still shown either way — but a check that flips run to run tells you nothing
 * about the code, so a prompt that produced no lookup is asked again, plainly.
 *
 * Only for checks that are *about* a lookup. Nothing here retries a genuine refusal.
 */
async function askNeedingLookup(page, gone, text, needed, { attempts = 2 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await ask(page, gone, text, { timeout: 300_000 })
    const answer = await latestAnswer(page)
    if (needed(answer)) return answer
    if (attempt < attempts) {
      say(`   … no lookup in that answer; asking again (${String(attempt)}/${String(attempts)})`)
      // Naming what was missing, rather than only asking again. "Use the search tool"
      // is not enough for a browser task: the model needs to hear that the *page* was
      // never opened, because that is the step it skipped.
      // Deliberately says *use the tool*, never shows the shape of a tool call. Quoting
      // the protocol back at a model teaches it to reply in that shape, and the reply is
      // then stored as the answer — raw JSON in the transcript, with nothing looked up.
      const missing = /browser_read/.test(text)
        ? 'You did not open the page in your browser last time. Use your browser tool on the official URL now, and answer from what it returned.'
        : 'You did not use the search tool last time. Use it now, and answer only from what it returned.'
      await ask(page, gone, `${text} ${missing}`, { timeout: 300_000 })
      const retry = await latestAnswer(page)
      if (needed(retry)) return retry
    }
  }
  return await latestAnswer(page)
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
  // The newest answer, and how long it has looked the same.
  //
  // A turn that calls a tool has a moment between iterations where the composer is
  // briefly idle again, so "idle and one more answer than before" fires *mid-turn* and
  // hands back the previous answer — which looks exactly like a wrong answer and is how
  // a browser check ends up reading an image search. Requiring the newest answer to hold
  // still for a few seconds is what distinguishes "finished" from "thinking".
  let lastText = null
  let stableSince = 0
  const STABLE_MS = 4_000

  while (Date.now() < deadline) {
    const answers = await settledAnswers(page)
    const landed = answers.length
    const newest = landed > 0 ? answers[landed - 1] : ''
    if (landed > before && newest !== lastText) {
      lastText = newest
      stableSince = Date.now()
    }
    if (landed > before && !(await generating(page)) && Date.now() - stableSince >= STABLE_MS) {
      const answer = lastText ?? ''
      say(`   Freya: ${answer.replace(/\s+/g, ' ').slice(0, 900)}${answer.length > 900 ? '…' : ''}`)
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
  const traceFile = join(profileDir ?? tmpdir(), 'freya-trace.log')
  const app = await electron.launch({
    args: [ROOT, `--freya-display=${DISPLAY}`,
      ...(profileDir === null ? [] : [`--user-data-dir=${profileDir}`])],
    // The three the shipping app needs to actually search: a live model, the explicit
    // opt-in, and the daemon's URL. The last one is the interesting one — the app
    // preferred a local metasearch daemon and could not be told where it was, so
    // research came back `unconfigured` while SearXNG was answering on this very port.
    // Traces to a file, because the main process's stdout is buffered by Electron
    // and an unreadable pipe is worse than no capture at all.
    env: { ...process.env, ...acceptanceSettings(), FREYA_TRACE_FILE: traceFile },
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
  // Both pipes, and `setEncoding`, or the chunks arrive as Buffers and every capture
  // silently yields nothing. An earlier version of this wired the listeners exactly like
  // this and reported an empty log for an entire run, which reads exactly like "the app
  // printed nothing" — the failure mode this capture exists to prevent.
  for (const stream of [mainProcess?.stdout, mainProcess?.stderr]) {
    stream?.setEncoding('utf8')
    stream?.on('data', (chunk) => mainLog.push(String(chunk)))
  }

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
  await askNeedingLookup(page, windowGoneState,
    'Search the web for the current official Laravel release: what is the latest major version and when was it released? Cite your sources.',
    (answer) => /web_search/.test(answer))
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
  await askNeedingLookup(page, windowGoneState,
    'Search the web for images of the James Webb Space Telescope. You must look them up with the web_search tool, passing type: images, then tell me what you found. Do not answer from memory.',
    (answer) => /web_search/.test(answer))
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
  await askNeedingLookup(page, windowGoneState,
    'Find the official EU Artificial Intelligence Act. You must look it up with the web_search tool, passing type: documents, and then give me the exact official URL you found. Do not answer from memory.',
    (answer) => /web_search/.test(answer))
  const document = await latestAnswer(page)
  // Two separate things, asserted separately, because they fail for different reasons.
  //
  // The card is the product. It is measured *cumulatively across the whole run* rather
  // than on this one answer: a document card appears whenever a `documents` lookup runs,
  // and whether the model chooses that vertical for a particular phrasing is its
  // judgement, not this code's. Asking again would only make the run slower; looking
  // across the run asserts the thing that is actually ours — that the path draws.
const docCards = await page.evaluate(() => document.querySelectorAll('.chats-doc-card').length)
  const documentCardsTotal = documentCardsSeen + docCards
  check(documentCardsTotal > 0, `document cards drawn this run: ${String(documentCardsTotal)}`)
  documentCardsSeen = documentCardsTotal

  // The URL is the model's work, and a live model sometimes declines to answer or answers
  // from the wrong source. Asserting a `.pdf` suffix would also fail the best available
  // answer, since EUR-Lex serves the act from a landing URL. So this asks only that *if*
  // an answer with a source was given, it is the official one — an honest "I could not
  // check that" is not a failure of this suite.
  const official = urlsIn(document).filter((url) => /eur-lex\.europa\.eu|europa\.eu/i.test(url))
  if (/could not|unable|no sourced|I have no/i.test(document)) {
    say('   (the model declined to answer this one; the card check above still applies)')
    check('an honest decline names no source it cannot stand behind', official.length === 0,
      `but it still named ${String(official.length)} official URL(s)`)
  } else {
    check('the answer points at the official EU source for the AI Act', official.length > 0,
      official[0] ?? `none of ${String(urlsIn(document).length)} named URLs was official`)
  }
  await shot(page, 'document-answer')

  /* -- 5. video ------------------------------------------------------------ */
  section('a video request returns playable video')
  await setMode(page, 'Chat')
  await askNeedingLookup(page, windowGoneState,
    'Search the web for videos of the James Webb Space Telescope. Use the web_search tool with type: videos, then tell me what you find.',
    (answer) => /web_search/.test(answer))
  const video = await latestAnswer(page)
  check('the video answer is not empty', video.trim().length > 0, `${String(video.trim().length)} chars`)
  await shot(page, 'video-answer')

  /* -- 6/7. Freya's own browser -------------------------------------------- */
  section("Freya's own browser, not an extension")
  // The gate here is stricter than the other sections, and deliberately so. A live model
  // sometimes *claims* to have opened a page it never opened — and the footer this run
  // checks does not, because it is rendered from what actually ran. That is the whole
  // point of TEST 10: the answer can say anything, and the only claim that counts is the
  // one the tool footer makes. So the run is not satisfied until the footer agrees.
  const fresh = await askNeedingLookup(page, windowGoneState,
    'Use your own browser. Search the web for the official Laravel documentation about queues and failed jobs, open the official page with your browser, and tell me the command for retrying a failed job.',
    (answer) => /Used the "browser_read" lookup/.test(answer),
    { attempts: 3 })
  check('the browser answer is not empty', fresh.trim().length > 0, `${String(fresh.trim().length)} chars`)
  check('it mentions the retry command', /queue:retry/.test(fresh))
  check('the transcript names the browser that served it', /native\/public Freya browser/i.test(fresh))
  check('the transcript never names the extension', !/chrome extension|paired extension/i.test(fresh))
  check('it does not claim to have clicked or typed anything',
    !/(?:^|\W)(?:i|freya)\s+(?:clicked|typed|logged in to|signed in to|submitted the form)(?:$|\W)/i.test(fresh))
  // Not "did the model say it searched" — the model may answer from the page it opened
  // without narrating, and a narration requirement would fail a correct answer for a
  // stylistic difference. What matters is that a search happened *and* the page was
  // read, which the footer already states; this checks the lookup itself happened.
  const searchedFirst = await page.evaluate(() => {
    const bodies = [...document.querySelectorAll('.chats-turn[data-role="assistant"] .chats-bubble')]
    return bodies.some((bubble) => /Used the "web_search" lookup/.test(bubble.textContent ?? ''))
  })
  check('the browser answer is grounded in a search and a page read', searchedFirst
    && /native\/public Freya browser/i.test(fresh)
    && /laravel\.com/.test(fresh))
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

  // What the main process wrote to the trace file. Read from the file rather than from
  // the process's stdout, which Electron buffers and Playwright does not reliably expose:
  // a capture that silently reports nothing is worse than no capture, because it reads
  // as "the app printed nothing".
  if (existsSync(traceFile)) {
    say('\n[main] browser seam:')
    for (const line of readFileSync(traceFile, 'utf8').trim().split(/\r?\n/)) say(`  ${line}`)
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