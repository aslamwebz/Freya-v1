import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { existsSync } from 'node:fs'

/**
 * End-to-end check of the real desktop app.
 *
 * Launches Electron against a throwaway userData directory so the test can
 * quit and relaunch without touching a real Freya workspace, then asserts the
 * layout survives. No model, no network, no AI provider is involved.
 */

const ROOT = resolve(import.meta.dirname, '..', '..')
const results: { name: string; ok: boolean; detail?: string }[] = []

function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail })
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${detail && !ok ? ` — ${detail}` : ''}`)
}

async function launch(userData: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [ROOT, `--user-data-dir=${userData}`],
    env: { ...process.env, NODE_ENV: 'production' },
  })
  const page = await app.firstWindow()
  await page.waitForSelector('.app[data-ready="true"]', { timeout: 20_000 })
  await page.waitForSelector('.presence', { timeout: 20_000 })
  return { app, page }
}

async function boxOf(page: Page, title: string) {
  const dialog = page.locator(`[role="dialog"][aria-label="${title}"]`)
  const box = await dialog.boundingBox()
  if (!box) throw new Error(`no bounding box for surface "${title}"`)
  return box
}

async function main(): Promise<void> {
  if (!existsSync(join(ROOT, 'dist', 'index.html'))) {
    console.error('dist/ is missing. Run `npm run build` before the e2e test.')
    process.exit(1)
  }

  const userData = await mkdtemp(join(tmpdir(), 'freya-e2e-'))
  console.log(`\nFreya e2e — userData: ${userData}\n`)

  let first: ElectronApplication | null = null
  try {
    const { app, page } = await launch(userData)
    first = app

    check('application boots', await page.locator('.app[data-ready="true"]').isVisible())
    check('renders the command centre', await page.getByText('FREYA').first().isVisible())
    check('presence canvas is present', (await page.locator('.presence-canvas').count()) === 1)

    // --- the presence ----------------------------------------------------
    // Presence boots lazily. On a machine with WebGL the canvases are resized
    // away from their HTML defaults; on a machine without WebGL the component
    // deliberately renders an explicit fallback. CI must wait for one of those
    // two settled states instead of sampling the 300x150 canvases mid-boot.
    await page.waitForFunction(
      () => {
        const stage = document.querySelector('.presence-canvas') as HTMLCanvasElement | null
        const rings = document.querySelector('.presence-rings') as HTMLCanvasElement | null
        const fallback = document.querySelector('.presence-fallback')
        return Boolean(fallback) ||
          Boolean(stage && rings && stage.width > 320 && stage.height > 200 && rings.width > 800)
      },
      undefined,
      { timeout: 20_000 },
    )

    const presence = await page.evaluate(() => {
      const stage = document.querySelector('.presence-canvas') as HTMLCanvasElement | null
      const rings = document.querySelector('.presence-rings') as HTMLCanvasElement | null
      if (!stage || !rings) return null
      const gl = (stage.getContext('webgl2') ?? stage.getContext('webgl')) as WebGLRenderingContext | null
      return {
        stageWidth: stage.width,
        stageHeight: stage.height,
        ringWidth: rings.width,
        webgl: Boolean(gl),
        fallback: Boolean(document.querySelector('.presence-fallback')),
      }
    })

    check(
      'presence settles as WebGL or an explicit fallback',
      presence !== null && (presence.fallback || presence.webgl),
    )

    if (presence?.fallback) {
      check(
        'presence fallback is explicit when WebGL is unavailable',
        await page.locator('.presence-fallback').isVisible(),
      )
    } else {
      check('presence stage is live', presence !== null && presence.webgl)

      /**
       * The canvas backing store must track its CSS box.
       *
       * A stale framebuffer is not visible as a wrong number anywhere — it shows
       * up as a stretched orb, because the browser scales a drawing buffer that
       * no longer matches the box it is stretched across. Asserting the ratio is
       * what makes that failure legible.
       */
      const backingMatchesBox = (p: Page) =>
        p.evaluate(() => {
          const canvas = document.querySelector('.presence-canvas') as HTMLCanvasElement | null
          if (!canvas) return null
          const box = canvas.getBoundingClientRect()
          if (box.width === 0 || box.height === 0) return null
          const ratio = window.devicePixelRatio || 1
          return {
            widthError: Math.abs(canvas.width - box.width * ratio) / (box.width * ratio),
            heightError: Math.abs(canvas.height - box.height * ratio) / (box.height * ratio),
          }
        })

      const stageBox = (p: Page) =>
        p.evaluate(() => {
          const host = document.querySelector('.presence-stage')
          if (!host) return null
          const box = host.getBoundingClientRect()
          return {
            x: box.x,
            y: box.y,
            width: box.width,
            height: box.height,
            centreX: box.x + box.width / 2,
            centreY: box.y + box.height / 2,
          }
        })

      const initialFit = await backingMatchesBox(page)
      const initialStageBox = await stageBox(page)
      check(
        'presence backing store matches its box before anything moves',
        initialFit !== null && initialFit.widthError < 0.02 && initialFit.heightError < 0.02,
        JSON.stringify(initialFit),
      )

      // The orb is an instrument, not a fluid dashboard tile. Folding or
      // expanding the systems rail may move the surrounding layout, but it must
      // not change the orb's own CSS dimensions.
      const railToggle = page.getByRole('button', { name: /systems rail|collapse|fold/i }).first()
      if ((await railToggle.count()) > 0) {
        await railToggle.click()
        await page.waitForTimeout(400)
        const foldedFit = await backingMatchesBox(page)
        const foldedStageBox = await stageBox(page)
        check(
          'presence backing store still matches its box after the rail folds',
          foldedFit !== null && foldedFit.widthError < 0.02 && foldedFit.heightError < 0.02,
          JSON.stringify(foldedFit),
        )
        check(
          'folding the systems rail does not resize or move Freya',
          initialStageBox !== null &&
            foldedStageBox !== null &&
            Math.abs(foldedStageBox.width - initialStageBox.width) < 1 &&
            Math.abs(foldedStageBox.height - initialStageBox.height) < 1 &&
            Math.abs(foldedStageBox.centreX - initialStageBox.centreX) < 1 &&
            Math.abs(foldedStageBox.centreY - initialStageBox.centreY) < 1,
          `before ${JSON.stringify(initialStageBox)} after ${JSON.stringify(foldedStageBox)}`,
        )
        await railToggle.click()
        await page.waitForTimeout(300)
      }

      // And after a real window resize, which also has to move the pinned rings.
      //
      // The size is restored afterwards, to the size it was actually found at
      // rather than to a hard-coded one. Later checks in this file are about
      // window geometry, and a leftover smaller window makes them measure a
      // surface that has nowhere to grow — which reads as a resize regression
      // when the resize is fine. A test that changes global state owes the rest
      // of the run the state it found.
      const foundViewport = await page.evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
      }))
      await page.setViewportSize({ width: 1280, height: 800 })
      await page.waitForTimeout(500)
      const resizedFit = await backingMatchesBox(page)
      check(
        'presence backing store still matches its box after a window resize',
        resizedFit !== null && resizedFit.widthError < 0.02 && resizedFit.heightError < 0.02,
        JSON.stringify(resizedFit),
      )
      await page.setViewportSize(foundViewport)
      await page.waitForTimeout(400)
      check(
        'presence stage is sized to its host, not left at the default',
        presence !== null && presence.stageWidth > 320 && presence.stageHeight > 200,
        `stage ${presence?.stageWidth}x${presence?.stageHeight}`,
      )
      check(
        'background ring layer covers the window',
        presence !== null && presence.ringWidth > 800,
        `rings ${presence?.ringWidth}px wide`,
      )

      // Readouts come from the stage's own clock, not from React state.
      await page.waitForFunction(
        () => {
          const label = document.querySelector('.hud-b span')
          return label !== null && label.textContent !== null && /Hz|%/.test(label.textContent)
        },
        undefined,
        { timeout: 15_000 },
      )
      check('presence readouts are live', true)

      // The Design Lab and the presence chips can put Freya into any state
      // without Core having done anything. This window was launched against the
      // built renderer, so they must not be here at all — the assertion is that
      // the controls are absent, not that they work.
      check(
        'the Development Lab is not present in a production window',
        (await page.getByRole('button', { name: /design lab/i }).count()) === 0,
      )
      check(
        'the simulated presence controls are not present in a production window',
        (await page.getByRole('group', { name: /demo presence state/i }).count()) === 0,
      )
    }

    // --- command bar and presence -----------------------------------------
    // Checked before any surface is opened: surfaces float above the shell by
    // design, so the presence console is not reachable while they are up.
    // The command goes to Core, and the acknowledgement names an event the
    // Core log can be checked against.
    // The Core row states the event sequence in words. Reading it from the
    // rendered DOM rather than from an object is the point: this checks that the
    // fact actually reaches a person.
    const readSeq = (p: Page) =>
      p.evaluate(() => {
        const row = [...document.querySelectorAll('.runtime-row')].find(
          (r) => r.querySelector('dt')?.textContent === 'Core',
        )
        return Number(/event (\d+)/.exec(row?.textContent ?? '')?.[1] ?? 0)
      })
    const seqBefore = await readSeq(page)
    await page.getByLabel('Command Freya').fill('what should we build first')
    await page.getByRole('search').locator('input').press('Enter')
    await page.waitForSelector('text=/Freya Core received the command/i', { timeout: 15_000 })
    const receipt = await page.locator('text=/Freya Core received the command/i').first().textContent()
    check(
      'the command bar is acknowledged by Core, not by the UI',
      /Freya Core received the command/.test(receipt ?? ''),
      receipt ?? '',
    )
    check(
      'the acknowledgement is explicit that nothing will execute it',
      /not connected yet/i.test(receipt ?? ''),
      receipt ?? '',
    )
    const seqAfter = await readSeq(page)
    check(
      'submitting a command advances the durable Core event sequence',
      seqAfter > seqBefore,
      `seq ${seqBefore} -> ${seqAfter}`,
    )
    // The receipt claims a specific event. Check the claim rather than trust it.
    const claimed = Number(/event #(\d+)/.exec(receipt ?? '')?.[1] ?? 0)
    check(
      'the event number the UI quotes is one Core actually assigned',
      claimed > 0 && claimed <= seqAfter,
      `claimed #${claimed}, log is at seq ${seqAfter}`,
    )
    // A command is not work, so presence must not claim otherwise.
    check(
      'submitting a command does not put Freya into a working state',
      (await page.locator('.presence').getAttribute('data-state')) !== 'working',
    )

    // Presence is derived from Core, so with Core ready and no provider work in
    // flight the only honest state is idle — and nothing in the window can change
    // that, because the controls that could are not rendered.
    check(
      'a ready Core with no work in flight reads as idle',
      (await page.locator('.presence').getAttribute('data-state')) === 'idle',
      (await page.locator('.presence').getAttribute('data-state')) ?? '',
    )

    // --- the Core is real ------------------------------------------------
    // Everything here is a value Core produced over IPC. The shell does not
    // compute a lifecycle or keep a counter of its own.
    const coreReady = async (p: Page) => {
      await p.waitForFunction(
        () => {
          const rows = [...document.querySelectorAll('.runtime-row')]
          const core = rows.find((r) => r.querySelector('dt')?.textContent === 'Core')
          return core?.querySelector('dd b')?.textContent === 'Ready'
        },
        undefined,
        { timeout: 20_000 },
      )
    }
    await coreReady(page)
    check('core reaches ready and the window says Ready', true)

    const coreFacts = async (p: Page) =>
      p.evaluate(() =>
        Object.fromEntries(
          [...document.querySelectorAll('.runtime-row')].map((row) => [
            row.querySelector('dt')?.textContent ?? '',
            row.querySelector('dd')?.textContent ?? '',
          ]),
        ),
      )

    const firstFacts = await coreFacts(page)
    check(
      'the system area reports a real event sequence',
      Number(/event (\d+)/.exec(firstFacts['Core'] ?? '')?.[1] ?? 0) > 0,
      firstFacts['Core'] ?? '',
    )
    check(
      'security reads as running before anything has stopped it',
      firstFacts['Security']?.startsWith('Running') === true,
      firstFacts['Security'] ?? '',
    )
    check(
      'the journal reads as healthy with no integrity fault',
      firstFacts['Journal']?.startsWith('Healthy') === true,
      firstFacts['Journal'] ?? '',
    )
    check(
      'the governor is reported with its real grant count',
      firstFacts['Governor']?.startsWith('Allowing explicit user turns') === true,
      firstFacts['Governor'] ?? '',
    )
    check(
      'a registered provider with no key is reported as unable to be called',
      firstFacts['Models']?.startsWith('No API key') === true,
      firstFacts['Models'] ?? '',
    )

    // Idle means idle, and the panel is quoting Core's counter rather than a
    // hard-coded zero.
    const usage = async (p: Page) =>
      p.evaluate(() =>
        [...document.querySelectorAll('.usage-row')].map((r) => r.textContent ?? '').join(' | '),
      )
    const firstUsage = await usage(page)
    check(
      'an idle window has spent no model calls',
      /0 calls/.test(firstUsage),
      firstUsage,
    )
    check(
      'usage with nothing reported says so rather than showing zero tokens',
      /no tokens reported/.test(firstUsage),
      firstUsage,
    )

    // An idle window must cost nothing. Nothing here touched a provider, and
    // the panel is reporting Core's own counter rather than a hard-coded zero.
    await page.waitForTimeout(1200)
    const idleUsage = await usage(page)
    check(
      'an idle window spends no inference',
      idleUsage === firstUsage,
      `${firstUsage} -> ${idleUsage}`,
    )

    // A renderer reload must reconnect to the Core that is already running, not
    // start a second one. The sequence continuing across a reload is the proof.
    const beforeReload = await coreFacts(page)
    await page.reload()
    await coreReady(page)
    const afterReload = await coreFacts(page)
    const seqPreReload = Number(/event (\d+)/.exec(beforeReload['Core'] ?? '')?.[1] ?? 0)
    const seqPostReload = Number(/event (\d+)/.exec(afterReload['Core'] ?? '')?.[1] ?? 0)
    check(
      'a renderer reload reconnects to the same Core, it does not restart it',
      seqPostReload >= seqPreReload && seqPostReload > 0,
      `seq ${seqPreReload} -> ${seqPostReload} across reload`,
    )
    // And the reload itself cost nothing.
    check(
      'a renderer reload spends no inference',
      (await usage(page)) === firstUsage,
      `${firstUsage} -> ${await usage(page)}`,
    )

    // --- stop all, deliberately ------------------------------------------
    // STOP ALL is in the Security surface, and it takes two presses. This also
    // proves the accidental-click case: one press must stop nothing.
    // Reached from the Core panel, not from the dock: security controls should
    // not be one stray click away from every other surface.
    // Reached from the surface launcher rather than a Core-panel link: a healthy
    // Core has nothing needing attention, so the panel correctly offers no
    // shortcut — and STOP ALL should not be one stray click away anyway.
    await page
      .getByRole('toolbar', { name: /work surfaces/i })
      .getByRole('button', { name: 'Security' })
      .click()
    await page.waitForSelector('[role="dialog"][aria-label="Security"]')
    check(
      'the security surface shows Core deny-by-default, not a placeholder',
      await page
        .getByText(/anything not explicitly permitted is refused/i)
        .first()
        .isVisible(),
    )
    check(
      'the security surface says an approval workflow does not exist',
      await page.getByText(/no approval workflow exists/i).first().isVisible(),
    )

    await page.getByRole('button', { name: /stop all/i }).click()
    await page.waitForSelector('[role="alertdialog"][aria-label="Confirm stop all"]')
    check(
      'one press on stop all does not stop anything',
      (await page.locator('.security-posture b').textContent()) === 'RUNNING',
    )
    check(
      'stopping asks for confirmation and warns that it is durable',
      await page.getByText(/stays stopped after a restart/i).isVisible(),
    )

    await page.getByRole('button', { name: /yes, stop everything/i }).click()
    await page.waitForFunction(
      () => document.querySelector('.security-posture b')?.textContent === 'STOPPED',
      undefined,
      { timeout: 10_000 },
    )
    check('confirming stops Core', true)
    check(
      'the security surface says who stopped it',
      await page.getByText(/by owner/i).first().isVisible(),
    )

    // Closed for now, so the surface-counting checks below are about the
    // surfaces they are about. It comes back with the workspace after the
    // relaunch, and the checks there confirm it does.
    await page.getByRole('button', { name: 'Close Security' }).click()
    await page.waitForSelector('[role="dialog"][aria-label="Security"]', { state: 'detached' })

    // --- open Search ------------------------------------------------------
    await page.getByRole('toolbar', { name: /work surfaces/i }).getByRole('button', { name: 'Search' }).click()
    await page.waitForSelector('[role="dialog"][aria-label="Search"]')
    check('opens the Search surface', await page.locator('[role="dialog"][aria-label="Search"]').isVisible())

    // --- resize it --------------------------------------------------------
    const handle = page.locator('[role="dialog"][aria-label="Search"] .surface-handle.edge-se')
    const asOpened = await boxOf(page, 'Search')
    const hb = await handle.boundingBox()
    if (!hb) throw new Error('no resize handle box')
    // A window opens at the laptop floor, which in this frame is already the
    // whole region — so there is nothing to grow into. Dragging the corner
    // *inwards* is the direction with room, and it still proves the handle is
    // live: a window that ignored the drag would not change at all.
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2)
    await page.mouse.down()
    await page.mouse.move(hb.x - 120, hb.y - 90, { steps: 10 })
    await page.mouse.up()
    const resized = await boxOf(page, 'Search')
    // A window opens at the laptop floor, which on a display this size is most of
    // the room there is, so there is nothing to grow into. The rule worth
    // asserting is that the handle responded and the window stayed legal: below
    // the header, and with enough of itself on screen to be grabbed again.
    const frame = await page.evaluate(() => ({
      top: document.querySelector('.header')?.getBoundingClientRect().height ?? 0,
      width: window.innerWidth,
      height: window.innerHeight,
    }))
    const withinFrame =
      resized.y >= frame.top - 1 &&
      resized.x + resized.width > 96 &&
      resized.y + resized.height > frame.top + 96 &&
      resized.x < frame.width &&
      resized.y < frame.height
    check(
      'resizes the surface from its corner',
      withinFrame &&
        resized.width < asOpened.width - 80 &&
        resized.height < asOpened.height - 60,
      `as opened ${Math.round(asOpened.width)}x${Math.round(asOpened.height)} -> ${Math.round(resized.width)}x${Math.round(resized.height)}`,
    )

    // --- move it ----------------------------------------------------------
    const before = await boxOf(page, 'Search')
    const title = page.locator('[role="dialog"][aria-label="Search"] .surface-title')
    const tb = await title.boundingBox()
    if (!tb) throw new Error('no title bar box')
    // A laptop-sized window is wider than most of the space a drag has to give,
    // so the move is modest and the check is that it moved at all and stayed in
    // the region — not that it cleared a fixed distance.
    await page.mouse.move(tb.x + 40, tb.y + 20)
    await page.mouse.down()
    await page.mouse.move(tb.x + 190, tb.y + 130, { steps: 12 })
    await page.mouse.up()
    const moved = await boxOf(page, 'Search')
    check(
      'drags the surface to a new position',
      Math.abs(moved.x - before.x) > 20 || Math.abs(moved.y - before.y) > 20,
      `moved from ${Math.round(before.x)},${Math.round(before.y)} to ${Math.round(moved.x)},${Math.round(moved.y)}`,
    )

    // --- minimise the first, then open a second --------------------------
    // Order matters here. The drag above leaves Search sitting over the dock,
    // and a surface that covers a button correctly stops the click reaching it.
    // So the surface is minimised before the dock is used, rather than the dock
    // being made clickable by moving the surface somewhere less awkward.
    await page.getByRole('button', { name: 'Minimize Search' }).click()
    await page.waitForSelector('[role="dialog"][aria-label="Search"]', { state: 'detached' })
    const searchStillInDock = await page
      .getByRole('toolbar', { name: /work surfaces/i })
      .getByRole('button', { name: 'Search' })
      .isEnabled()
    check(
      'minimising hides the surface without destroying it',
      (await page.locator('.surface-layer [role="dialog"]').count()) === 0 && searchStillInDock,
    )

    await page.getByRole('toolbar', { name: /work surfaces/i }).getByRole('button', { name: 'Harness' }).click()
    await page.waitForSelector('[role="dialog"][aria-label="Harness"]')

    // Restore Search from the dock so both are on screen for the restart.
    await page.getByRole('toolbar', { name: /work surfaces/i }).getByRole('button', { name: 'Search' }).click()
    await page.waitForSelector('[role="dialog"][aria-label="Search"]')
    check('opens a second surface alongside the first', (await page.locator('.surface-layer [role="dialog"]').count()) === 2)

    const expectedSearch = await boxOf(page, 'Search')
    const expectedHarness = await boxOf(page, 'Harness')

    // Let the debounced save land before quitting.
    await page.waitForTimeout(900)
    await app.close()
    first = null

    // --- relaunch and assert the workspace came back ----------------------
    const { app: second, page: restored } = await launch(userData)
    first = second

    check('restores both surfaces after a relaunch', (await restored.locator('.surface-layer [role="dialog"]').count()) === 2)
    const restoredSearch = await boxOf(restored, 'Search')
    const restoredHarness = await boxOf(restored, 'Harness')

    check(
      'restores the moved and resized geometry',
      Math.abs(restoredSearch.x - expectedSearch.x) < 2 &&
        Math.abs(restoredSearch.y - expectedSearch.y) < 2 &&
        Math.abs(restoredSearch.width - expectedSearch.width) < 2 &&
        Math.abs(restoredSearch.height - expectedSearch.height) < 2,
      `expected ${JSON.stringify(expectedSearch)} got ${JSON.stringify(restoredSearch)}`,
    )
    check(
      'restores the second surface geometry',
      Math.abs(restoredHarness.x - expectedHarness.x) < 2 &&
        Math.abs(restoredHarness.y - expectedHarness.y) < 2,
    )
    // Layout is restored; presence is not, and cannot be. It is derived from
    // Core, so a fresh window shows whatever Core's durable state actually is.
    //
    // This app was stopped before it quit, so the honest answer is `locked` — and
    // reading it straight from Core's latch across a process restart is a
    // stronger claim than any value restored from a file could be.
    await coreReady(restored)
    check(
      'a relaunched window derives presence from the durable stop latch, not from a file',
      (await restored.locator('.presence').getAttribute('data-state')) === 'locked',
      (await restored.locator('.presence').getAttribute('data-state')) ?? '',
    )

    // --- the stop latch survived the process -----------------------------
    await coreReady(restored)
    const restoredFacts = await coreFacts(restored)
    check(
      'the stop latch is still set after a relaunch',
      restoredFacts['Security']?.startsWith('Stopped') === true,
      restoredFacts['Security'] ?? '',
    )
    // The surface was closed before the quit, so reopening it is the point: a
    // fresh renderer must find Core already stopped, with no latch to set.
    await restored
      .getByRole('toolbar', { name: /work surfaces/i })
      .getByRole('button', { name: 'Security' })
      .click()
    await restored.waitForSelector('[role="dialog"][aria-label="Security"]')
    check(
      'a fresh window finds Core already stopped',
      (await restored.locator('.security-posture b').textContent()) === 'STOPPED',
    )
    check(
      'the durable call count did not change while the app was closed',
      (await usage(restored)) === firstUsage,
      `${firstUsage} -> ${await usage(restored)}`,
    )
    check(
      'resuming clears the latch',
      await (async () => {
        await restored.getByRole('button', { name: /resume core/i }).click()
        await restored.waitForFunction(
          () => {
            const rows = [...document.querySelectorAll('.runtime-row')]
            const security = rows.find((r) => r.querySelector('dt')?.textContent === 'Security')
            return security?.querySelector('dd b')?.textContent === 'Running'
          },
          undefined,
          { timeout: 10_000 },
        )
        return true
      })(),
    )
    // Put the surface away again so the checks below count what they mean to.
    await restored.getByRole('button', { name: 'Close Security' }).click()
    await restored.waitForSelector('[role="dialog"][aria-label="Security"]', { state: 'detached' })

    // --- window chrome ---------------------------------------------------
    await restored.getByRole('button', { name: 'Close Harness' }).click()
    await restored.waitForSelector('[role="dialog"][aria-label="Harness"]', { state: 'detached' })
    check('closes a surface', (await restored.locator('.surface-layer [role="dialog"]').count()) === 1)

    // --- an immediate quit must not lose the last change -----------------
    // Move a window and quit at once, with no time for the debounce. The
    // final flush has to land or this layout is gone.
    //
    // The debounce is given time to fire *before* the drag, not after. That
    // makes the pre-drag position durable by the ordinary path, so the only
    // thing the closing flush can be responsible for is the drag — which is the
    // thing under test. Without it, a stale in-flight snapshot is a second
    // possible explanation for a failure and the check proves less.
    await restored.waitForTimeout(600)
    const preDrag = await boxOf(restored, 'Search')
    const quitTitle = restored.locator('[role="dialog"][aria-label="Search"] .surface-title')
    const quitBox = (await quitTitle.boundingBox())!
    // A window this size leaves very little room to move, so the drag is sized
    // to what the frame actually allows rather than to a fixed offset.
    const room = await restored.evaluate(() => {
      const chat = document.querySelector('.chatbar')
      return {
        dx: Math.max(0, (chat?.getBoundingClientRect().left ?? 0) - 40),
        dy: Math.max(0, (chat?.getBoundingClientRect().top ?? window.innerHeight) - 40),
      }
    })
    await restored.mouse.move(quitBox.x + 40, quitBox.y + 20)
    await restored.mouse.down()
    await restored.mouse.move(
      Math.min(quitBox.x + 40 + room.dx, quitBox.x + 40 + 240),
      Math.min(quitBox.y + 20 + room.dy, quitBox.y + 20 + 140),
      { steps: 8 },
    )
    await restored.mouse.up()
    // Let the last pointer move of the gesture settle before measuring. Reading
    // mid-gesture compares the position from one step earlier against the one
    // that was saved, which is a test artefact rather than a lost layout.
    await restored.waitForTimeout(150)

    const afterDrag = await boxOf(restored, 'Search')
    await second.close()
    first = null

    const { app: third, page: afterImmediateQuit } = await launch(userData)
    first = third
    const recovered = await boxOf(afterImmediateQuit, 'Search')
    // What is under test is that the change *survived* an immediate quit, not
    // that it survived to the pixel: the drag is measured while the gesture is
    // still settling, and byte-exact restore fidelity is already covered by
    // "restores the moved and resized geometry" above.
    const movedBeforeQuit =
      Math.abs(afterDrag.x - preDrag.x) > 20 || Math.abs(afterDrag.y - preDrag.y) > 20
    const keptTheMove =
      Math.abs(recovered.x - preDrag.x) > 20 || Math.abs(recovered.y - preDrag.y) > 20
    check(
      'an immediate quit still persists the last layout change',
      movedBeforeQuit && keptTheMove,
      `before ${Math.round(preDrag.x)},${Math.round(preDrag.y)} -> dragged ${Math.round(afterDrag.x)},${Math.round(afterDrag.y)} -> recovered ${Math.round(recovered.x)},${Math.round(recovered.y)}`,
    )

    await third.close()

    // =================================================================
    // Phase 2: the command centre as a truthful projection
    // =================================================================
    {
      const { app: fourth, page: p4 } = await launch(userData)

      // --- the activity feed is Core's, and carries no command text -----
      const activityRows = async () =>
        p4.evaluate(() =>
          [...document.querySelectorAll('.activity-row')].map((r) => r.querySelector('.activity-text')?.textContent ?? ''),
        )

      check(
        'the activity feed is populated from durable Core events',
        (await activityRows()).some((line) => /core started/i.test(line)),
        JSON.stringify((await activityRows()).slice(0, 4)),
      )
      // The visible feed is the tail of a long journal, so this window submits
      // its own command rather than hunting for an earlier one. That also
      // exercises the live subscription in a window that was not present for the
      // event, which is the case a naive renderer would get wrong.
      const SECRET = 'phase2 activity feed must not leak this sentence'
      await p4.getByLabel('Command Freya').fill(SECRET)
      await p4.getByRole('search').locator('input').press('Enter')
      await p4.waitForFunction(
        () =>
          [...document.querySelectorAll('.activity-row')].some((r) =>
            /command received/i.test(r.textContent ?? ''),
          ),
        undefined,
        { timeout: 15_000 },
      )
      check(
        'the activity feed reports a command as a length, without quoting it',
        (await activityRows()).some((line) => /command received \(\d+ characters\)/i.test(line)),
        JSON.stringify((await activityRows()).slice(0, 3)),
      )
      // Scoped to the feed, deliberately. The person who typed it can see it in
      // their own chat transcript — that is their text, in their window — but it
      // must not have reached the audit activity, which is a projection of the
      // durable journal. The journal itself holding no such text is asserted in
      // tests/core/activity.test.ts, where the file can be read directly.
      check(
        'no command text reached the activity feed',
        !(await activityRows()).join(' ').includes('phase2 activity feed'),
      )

      // And the durable security transitions, seen live by this window.
      await p4
        .getByRole('toolbar', { name: /work surfaces/i })
        .getByRole('button', { name: 'Security' })
        .click()
      await p4.waitForSelector('[role="dialog"][aria-label="Security"]')
      await p4.getByRole('button', { name: /stop all/i }).click()
      await p4.waitForSelector('[role="alertdialog"][aria-label="Confirm stop all"]')
      await p4.getByRole('button', { name: /yes, stop everything/i }).click()
      await p4.waitForTimeout(500)
      await p4.getByRole('button', { name: /resume core/i }).click()
      await p4.waitForTimeout(700)
      await p4.getByRole('button', { name: 'Close Security' }).click()
      check(
        'the activity feed reports the durable stop and resume',
        (await activityRows()).some((line) => /stop all activated/i.test(line)) &&
          (await activityRows()).some((line) => /stop all cleared/i.test(line)),
        JSON.stringify((await activityRows()).slice(0, 6)),
      )

      // --- empty states are stated, not filled ----------------------------
      check(
        'the work panel says there is no active work',
        await p4.getByText('No active work').isVisible(),
      )
      check(
        'the attention panel says nothing needs a person',
        await p4.getByText('Nothing needs you').isVisible(),
      )
      check(
        'no invented missions, agents or telemetry are on screen',
        !(await p4.content()).match(/Agent Alpha|Mission \d+ running|Archivist|Liaison/),
      )

      // --- singleton surfaces do not duplicate ---------------------------
      const launcher = p4.getByRole('toolbar', { name: /work surfaces/i })
      await launcher.getByRole('button', { name: 'Security' }).click()
      await p4.waitForSelector('[role="dialog"][aria-label="Security"]')
      await launcher.getByRole('button', { name: 'Security' }).click()
      await p4.waitForTimeout(200)
      // The second press focuses the focused surface, which minimises it; either
      // way it must not have produced two Security windows.
      check(
        'pressing the launcher twice does not open two Security windows',
        (await p4.locator('.surface-layer [role="dialog"][aria-label="Security"]').count()) <= 1,
      )
      await launcher.getByRole('button', { name: 'Security' }).click()
      await p4.waitForTimeout(200)
      check(
        'the launcher brings a minimised singleton back',
        (await p4.locator('.surface-layer [role="dialog"][aria-label="Security"]').count()) === 1,
      )
      await p4.getByRole('button', { name: 'Close Security' }).click()

      // --- idle costs nothing, and says so --------------------------------
      await p4.waitForTimeout(1500)
      const usageText = await p4.evaluate(() =>
        [...document.querySelectorAll('.usage-row')].map((r) => r.textContent ?? '').join(' | '),
      )
      check(
        'an idle window has spent nothing after all of that',
        usageText.includes('0 calls'),
        usageText,
      )
      check(
        'usage is presented as a lower bound only when something is unaccounted for',
        !/unaccounted/i.test(usageText),
        usageText,
      )

      await fourth.close()
    }

    first = null
  } catch (error) {
    check('e2e run completed', false, error instanceof Error ? error.message : String(error))
  } finally {
    await first?.close().catch(() => {})
    await rm(userData, { recursive: true, force: true })
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  process.exit(failed.length === 0 ? 0 : 1)
}

await main()
