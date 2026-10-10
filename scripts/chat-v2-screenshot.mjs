import { chromium } from 'playwright-core'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { mkdir } from 'node:fs/promises'
import { dirname, extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Capture the shipping Chat UI using explicit fixture-backed host data.
 * This is layout evidence only; it does not prove live Core behavior.
 * The historical command filename is retained for existing callers.
 */

const here_ = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(here_, '..')
const SHOTS = resolve(ROOT, 'artifacts', 'chat-v2')

const fixtureProjection = {
  persistence: { mode: 'encrypted', reason: null },
  conversations: [
    { conversationId: 'c-now', title: 'New conversation', updatedAt: '2026-10-07T10:00:00Z', messageCount: 2, lastTurnOutcome: 'completed' },
    { conversationId: 'c-saturn', title: 'Images of Saturn', updatedAt: '2026-10-07T09:30:00Z', messageCount: 4, lastTurnOutcome: 'completed' },
    { conversationId: 'c-queues', title: 'Laravel queues', updatedAt: '2026-10-07T09:10:00Z', messageCount: 5, lastTurnOutcome: 'failed' },
  ],
  activeConversationId: 'c-saturn',
  messages: [
    { messageId: 'u', role: 'user', content: 'show me images of Saturn', createdAt: '2026-10-07T09:25:00Z', turnId: 't1' },
    {
      messageId: 'a1',
      role: 'assistant',
      createdAt: '2026-10-07T09:25:30Z',
      turnId: 't1',
      content: [
        'Here are three pictures of Saturn from the last 24 hours of NASA imagery.',
        '',
        '## What the images show',
        '',
        '- The northern storm band, captured in visible light',
        '- An infrared view of the rings, with shadow detail',
        '- A wide-angle mosaic assembled from the latest flyby',
        '',
        '## Why the rings look the way they do',
        '',
        "Saturn's rings are mostly water ice. The particles range from dust to boulder-size, and they orbit in a disk that is hundreds of thousands of kilometres wide and, on average, only about ten metres thick. When sunlight hits the disk at a shallow angle, the shadows stretch across the rings, which is what gives the latest set its high contrast.",
        '',
        '```python',
        'def saturn_ring_thickness_km():',
        '    return 0.01  # about ten metres',
        '```',
        '',
        'See [NASA JPL](https://www.jpl.nasa.gov/news/saturn) for the source set.',
      ].join('\n'),
      media: [
        { kind: 'image', url: 'https://example.com/saturn-1.jpg', page: 'https://example.com/saturn-1', title: 'Saturn in visible light', host: 'example.com', playable: false, duration: null, bytes: null, pages: null },
        { kind: 'image', url: 'https://example.com/saturn-2.jpg', page: 'https://example.com/saturn-2', title: 'Saturn in infrared', host: 'example.com', playable: false, duration: null, bytes: null, pages: null },
        { kind: 'document', url: 'https://example.com/saturn-report.pdf', page: 'https://example.com/saturn-report', title: 'Saturn rings report', host: 'example.com', playable: false, duration: null, bytes: null, pages: 24 },
      ],
    },
  ],
  activeTurn: null,
  cognition: { available: true, reason: null },
  stopAll: { active: false, activatedAt: null },
  maxMessageCharacters: 4000,
  faults: [],
}

/** Init-script body. Runs before any renderer module evaluates. */
const INIT_SCRIPT = `
(() => {
  const fixture = ${JSON.stringify(fixtureProjection)};
  const projection = location.search === '?fixture=empty'
    ? { ...fixture, conversations: [], activeConversationId: null, messages: [] }
    : fixture;
  const target = window;
  target.freyaHost = target.freyaHost ?? {};
  const host = target.freyaHost;
  host.isDesktop = true;
  host.onCollect = () => {};
  host.loadWorkspace = async () => null;
  host.saveWorkspace = async () => false;
  // Unpictured lanes deliberately have no projection or command authority.
  for (const lane of ['Mission', 'Workforce', 'Attention', 'Brain', 'Work', 'Personality', 'Context', 'Consciousness', 'World', 'Office', 'Life', 'LifeLoop', 'Foundry', 'Relay', 'Skills', 'Voice']) {
    host['core' + lane] = async () => null;
    host['onCore' + lane] = () => () => {};
  }
  host.coreSubmit = async () => ({ ok: false, refusal: { reason: 'Layout fixture has no Core command authority' } });
  host.providerConfig = async () => { throw new Error('No provider in this layout fixture'); };
  host.voiceConfig = async () => { throw new Error('No voice provider in this layout fixture'); };
  host.coreConversation = async () => projection;
  host.onCoreConversation = () => () => {};
  host.coreActivity = async () => [
    { id: 'p1', kind: 'provider.started', type: 'model.request.started', sequence: 101, at: Date.now() - 4_000, text: 'Model request started (gpt-x).', tone: 'busy' },
    { id: 'p2', kind: 'work.run.started', type: 'work.run.started', sequence: 102, at: Date.now() - 2_500, text: 'Run started.', tone: 'busy' },
    { id: 'p3', kind: 'work.step.verified', type: 'work.step.verified', sequence: 103, at: Date.now() - 1_500, text: 'A step was verified.', tone: 'good' },
    { id: 'p4', kind: 'provider.completed', type: 'model.request.completed', sequence: 104, at: Date.now() - 500, text: 'Model request completed (gpt-x).', tone: 'good' },
  ];
  host.onCoreActivity = () => () => {};
  host.coreStatus = async () => null;
  host.onCoreStatus = () => () => {};
  host.mediaThumbnail = async () => ({ ok: false, dataUrl: null, bytes: 0, format: null, claimedType: null, reason: 'no host in this build' });
  host.mediaDocument = async () => ({ ok: false, reason: 'no host in this build' });
  host.mediaVideo = async () => ({ ok: false, dataUrl: null, bytes: 0, format: null, claimedType: null, reason: 'no host in this build' });
})();
`

/**
 * Tiny static server so Chromium will load the page. `file://` is rejected by
 * the renderer's CSP and the modern browser's CORS rules; serving the built
 * `dist/` over loopback gets the same Vite output onto the same browser as
 * Electron's `file://` window, without the cross-origin pain.
 */
function startStaticServer(rootDir) {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' }
  return new Promise((resolveServer) => {
    const server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const path = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)
        const file = resolve(rootDir, `.${path}`)
        if (!file.startsWith(rootDir)) {
          res.statusCode = 403
          res.end('forbidden')
          return
        }
        const body = await readFile(file)
        res.setHeader('content-type', types[extname(file).toLowerCase()] ?? 'application/octet-stream')
        res.end(body)
      } catch {
        res.statusCode = 404
        res.end('not found')
      }
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolveServer({ server, url: `http://127.0.0.1:${String(address.port)}` })
    })
  })
}

async function shot(page, label) {
  await page.evaluate(() => {
    const document = globalThis.document;
    if (document.getElementById('fixture-label')) return;
    const label = document.createElement('div');
    label.id = 'fixture-label';
    label.textContent = 'Layout fixture · no live Core';
    label.style.cssText = 'position:fixed;top:2px;left:50%;transform:translateX(-50%);z-index:99999;font:12px sans-serif;color:#cbd5e1;background:#101827;padding:4px 12px;border-radius:6px;pointer-events:none';
    document.body.append(label);
  });
  const file = resolve(SHOTS, `${label}.png`)
  await page.screenshot({ path: file, fullPage: true })
  process.stdout.write(`   [shot] ${file}\n`)
}

async function main() {
  await mkdir(SHOTS, { recursive: true })
  const { server, url } = await startStaticServer(resolve(ROOT, 'dist'))
  process.stdout.write(`[server] serving dist/ at ${url}\n`)

  let browser
  try {
    browser = await chromium.launch({ headless: true, channel: 'chrome' })
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    await context.addInitScript({ content: INIT_SCRIPT })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (error) => errors.push(String(error)))
    page.on('console', (msg) => {
      if (msg.type() === 'error') process.stdout.write(`   [console:error] ${msg.text()}\n`)
    })

    // 1. Default view: shipping shell with the Chat workspace selected.
    //    The projection from the init script is the one with messages, so the
    //    transcript draws; for the *empty state* we briefly drop it.
    await page.goto(`${url}/?fixture=empty`, { waitUntil: 'load' })
    await page.waitForSelector('.freya-v2', { timeout: 30_000 })
    await page.locator('.freya-boot').waitFor({ state: 'hidden', timeout: 20_000 })
    const chatNav = page.getByRole('button', { name: 'Open Chats' }).first()
    await chatNav.click()
    await page.waitForSelector('.chats', { timeout: 10_000 })
    if (await page.locator('.chats-rich').count()) throw new Error('Empty fixture rendered a transcript')
    await page.waitForTimeout(500)
    await shot(page, '01-empty-state')

    // 2. Restore the projection so the hydrated transcript draws.
    // A fresh document lets the singleton mirror read the hydrated fixture.
    await page.goto(`${url}/`, { waitUntil: 'load' })
    await page.waitForSelector('.freya-v2', { timeout: 30_000 })
    await page.locator('.freya-boot').waitFor({ state: 'hidden', timeout: 20_000 })
    const chatNav2 = page.getByRole('button', { name: 'Open Chats' }).first()
    await chatNav2.click()
    await page.waitForSelector('.chats-rich', { timeout: 15_000 })
    await page.getByText('show me images of Saturn', { exact: true }).waitFor()
    await page.waitForTimeout(700)
    await shot(page, '02-hydrated-transcript')

    // 3. Open the contents disclosure to show the TOC against the same body.
    const toc = page.locator('.chats-toc > summary').first()
    await toc.click()
    await page.waitForTimeout(300)
    await shot(page, '03-toc-open')
    if (errors.length) throw new Error(errors.join('\n'))

    process.stdout.write(`\nshots: ${SHOTS}\n`)
  } finally {
    await browser?.close()
    server.close()
  }
}

main().catch((error) => {
  process.stderr.write(`\n[run] fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
  process.exit(1)
})
