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
    check('presence stage is live', presence !== null && presence.webgl && !presence.fallback)
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

    // The design lab is presentation only, and every option is wired.
    await page.getByRole('button', { name: /design lab/i }).click()
    await page.getByRole('button', { name: 'Galaxy', exact: true }).click()
    await page.waitForTimeout(500)
    check('design lab switches the centrepiece', (await page.locator('.hud-a b').textContent()) === 'STARS')

    await page.getByRole('button', { name: 'Grid lab', exact: true }).click()
    await page.waitForTimeout(250)
    check(
      'design lab switches the background',
      (await page.locator('.atmosphere').getAttribute('data-bg')) === 'grid',
    )

    await page.getByRole('button', { name: 'Deep space', exact: true }).click()
    await page.getByRole('button', { name: 'Liquid orb', exact: true }).click()
    await page.keyboard.press('Escape')

    // --- command bar and presence -----------------------------------------
    // Checked before any surface is opened: surfaces float above the shell by
    // design, so the presence console is not reachable while they are up.
    await page.getByLabel('Command Freya').fill('what should we build first')
    await page.getByRole('search').locator('input').press('Enter')
    check(
      'accepts a typed command locally',
      await page.getByText(/no model is attached/i).first().isVisible(),
    )

    await page.getByRole('group', { name: /demo presence state/i }).getByRole('button', { name: 'Working' }).click()
    check(
      'demo presence control drives the state',
      (await page.locator('.presence').getAttribute('data-state')) === 'working',
    )

    // --- the Core is real ------------------------------------------------
    // Everything here is a value Core produced over IPC. The shell does not
    // compute a lifecycle or keep a counter of its own.
    const coreReady = async (p: Page) => {
      await p.waitForFunction(
        () => {
          const el = document.querySelector('.panel-meta-value[data-lifecycle]')
          return el !== null && el.textContent === 'ready'
        },
        undefined,
        { timeout: 20_000 },
      )
    }
    await coreReady(page)
    check('core reaches ready and says so', true)

    const coreFacts = async (p: Page) =>
      p.evaluate(() =>
        Object.fromEntries(
          [...document.querySelectorAll('.core-facts > div')].map((row) => [
            row.querySelector('dt')?.textContent ?? '',
            row.querySelector('dd')?.textContent ?? '',
          ]),
        ),
      )

    const firstFacts = await coreFacts(page)
    check(
      'core reports a real event log and an idle inference count',
      Number(/seq (\d+)/.exec(firstFacts['Event log'] ?? '')?.[1] ?? 0) > 0 &&
        firstFacts['Inference'] === '0 this session · 0 durable',
      JSON.stringify(firstFacts),
    )
    check(
      'core is deny-by-default with no approval workflow',
      firstFacts['Guard']?.startsWith('deny by default') === true,
      firstFacts['Guard'],
    )
    check(
      'nanogpt is present but not live',
      (firstFacts['Providers'] ?? '').includes('nanogpt: unconfigured'),
      firstFacts['Providers'],
    )

    // An idle window must cost nothing. Nothing here touched a provider, and
    // the panel is reporting Core's own counter rather than a hard-coded zero.
    await page.waitForTimeout(1200)
    const idleFacts = await coreFacts(page)
    check(
      'an idle window spends no inference',
      idleFacts['Inference'] === firstFacts['Inference'],
      `${firstFacts['Inference']} -> ${idleFacts['Inference']}`,
    )

    // STOP ALL is derived from the log, so a relaunch must find it still latched.
    await page.getByRole('button', { name: 'Stop all' }).click()
    await page.waitForFunction(
      () => {
        const rows = [...document.querySelectorAll('.core-facts > div')]
        const grants = rows.find((r) => r.querySelector('dt')?.textContent === 'Grants')
        return grants?.textContent?.includes('stopped') === true
      },
      undefined,
      { timeout: 10_000 },
    )
    check('stop all latches and is reported by the governor', true)

    // --- open Search ------------------------------------------------------
    await page.getByRole('toolbar', { name: /work surfaces/i }).getByRole('button', { name: 'Search' }).click()
    await page.waitForSelector('[role="dialog"][aria-label="Search"]')
    check('opens the Search surface', await page.locator('[role="dialog"][aria-label="Search"]').isVisible())

    // --- move it ----------------------------------------------------------
    const before = await boxOf(page, 'Search')
    const title = page.locator('[role="dialog"][aria-label="Search"] .surface-title')
    const tb = await title.boundingBox()
    if (!tb) throw new Error('no title bar box')
    await page.mouse.move(tb.x + 40, tb.y + 20)
    await page.mouse.down()
    await page.mouse.move(tb.x + 320, tb.y + 200, { steps: 12 })
    await page.mouse.up()
    const moved = await boxOf(page, 'Search')
    check(
      'drags the surface to a new position',
      Math.abs(moved.x - before.x) > 200 && Math.abs(moved.y - before.y) > 150,
      `moved from ${Math.round(before.x)},${Math.round(before.y)} to ${Math.round(moved.x)},${Math.round(moved.y)}`,
    )

    // --- resize it --------------------------------------------------------
    const handle = page.locator('[role="dialog"][aria-label="Search"] .surface-handle.edge-se')
    const hb = await handle.boundingBox()
    if (!hb) throw new Error('no resize handle box')
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2)
    await page.mouse.down()
    await page.mouse.move(hb.x + hb.width / 2 + 120, hb.y + hb.height / 2 + 100, { steps: 10 })
    await page.mouse.up()
    const resized = await boxOf(page, 'Search')
    check(
      'resizes the surface from its corner',
      resized.width > moved.width + 80 && resized.height > moved.height + 60,
      `${Math.round(moved.width)}x${Math.round(moved.height)} -> ${Math.round(resized.width)}x${Math.round(resized.height)}`,
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
      (await page.locator('[role="dialog"]').count()) === 0 && searchStillInDock,
    )

    await page.getByRole('toolbar', { name: /work surfaces/i }).getByRole('button', { name: 'Harness' }).click()
    await page.waitForSelector('[role="dialog"][aria-label="Harness"]')

    // Restore Search from the dock so both are on screen for the restart.
    await page.getByRole('toolbar', { name: /work surfaces/i }).getByRole('button', { name: 'Search' }).click()
    await page.waitForSelector('[role="dialog"][aria-label="Search"]')
    check('opens a second surface alongside the first', (await page.locator('[role="dialog"]').count()) === 2)

    const expectedSearch = await boxOf(page, 'Search')
    const expectedHarness = await boxOf(page, 'Harness')

    // Let the debounced save land before quitting.
    await page.waitForTimeout(900)
    await app.close()
    first = null

    // --- relaunch and assert the workspace came back ----------------------
    const { app: second, page: restored } = await launch(userData)
    first = second

    check('restores both surfaces after a relaunch', (await restored.locator('[role="dialog"]').count()) === 2)
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
    check(
      'restores the presence state',
      (await restored.locator('.presence').getAttribute('data-state')) === 'working',
    )

    // --- the stop latch survived the process -----------------------------
    await coreReady(restored)
    const restoredFacts = await coreFacts(restored)
    check(
      'the stop latch is still set after a relaunch',
      restoredFacts['Grants']?.includes('stopped') === true,
      restoredFacts['Grants'],
    )
    check(
      'the durable call count did not change while the app was closed',
      restoredFacts['Inference'] === idleFacts['Inference'],
      `${idleFacts['Inference']} -> ${restoredFacts['Inference']}`,
    )
    check(
      'resuming clears the latch',
      await (async () => {
        await restored.getByRole('button', { name: 'Resume' }).click()
        await restored.waitForFunction(
          () => {
            const rows = [...document.querySelectorAll('.core-facts > div')]
            const grants = rows.find((r) => r.querySelector('dt')?.textContent === 'Grants')
            return grants !== undefined && !grants.textContent?.includes('stopped')
          },
          undefined,
          { timeout: 10_000 },
        )
        return true
      })(),
    )

    // --- window chrome ---------------------------------------------------
    await restored.getByRole('button', { name: 'Close Harness' }).click()
    await restored.waitForSelector('[role="dialog"][aria-label="Harness"]', { state: 'detached' })
    check('closes a surface', (await restored.locator('[role="dialog"]').count()) === 1)

    // --- an immediate quit must not lose the last change -----------------
    // Move a window and quit at once, with no time for the debounce. The
    // final flush has to land or this layout is gone.
    const quitTitle = restored.locator('[role="dialog"][aria-label="Search"] .surface-title')
    const quitBox = (await quitTitle.boundingBox())!
    await restored.mouse.move(quitBox.x + 40, quitBox.y + 20)
    await restored.mouse.down()
    await restored.mouse.move(quitBox.x + 260, quitBox.y + 150, { steps: 8 })
    await restored.mouse.up()

    const beforeImmediateQuit = await boxOf(restored, 'Search')
    await second.close()
    first = null

    const { app: third, page: afterImmediateQuit } = await launch(userData)
    first = third
    const recovered = await boxOf(afterImmediateQuit, 'Search')
    check(
      'an immediate quit still persists the last layout change',
      Math.abs(recovered.x - beforeImmediateQuit.x) < 2 && Math.abs(recovered.y - beforeImmediateQuit.y) < 2,
      `expected ${Math.round(beforeImmediateQuit.x)},${Math.round(beforeImmediateQuit.y)} got ${Math.round(recovered.x)},${Math.round(recovered.y)}`,
    )

    await third.close()
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
