#!/usr/bin/env node
// Live-control Freya's Electron app for interactive verification.
//
// Launches a Freya Electron instance pointed at a Vite dev server this script
// owns, with an isolated user data dir so it does not touch the owner's
// journal, then drives the window with Playwright: click, type, screenshot.
//
//   node scripts/live-drive.mjs              # default: go to chat, type, send, screenshot
//   node scripts/live-drive.mjs --port 5280  # pick a vite port
//   node scripts/live-drive.mjs --shot out.png
//
// Technique mirrors how Athena's test/shot.mjs launches its Electron shell
// with _electron.launch + a controlled environment; the code is Freya's.

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { _electron as electron } from 'playwright-core';

const REPO = path.resolve(import.meta.dirname, '..');
const ARGS = process.argv.slice(2);
const PORT = (() => {
  const i = ARGS.indexOf('--port');
  return i >= 0 && ARGS[i + 1] ? Number(ARGS[i + 1]) : 5281;
})();
const SHOT = (() => {
  const i = ARGS.indexOf('--shot');
  return i >= 0 && ARGS[i + 1] ? ARGS[i + 1] : '.scratch/live-drive.png';
})();
const DATA_DIR = path.join(os.tmpdir(), 'freya-live-' + Date.now());
fs.mkdirSync(DATA_DIR, { recursive: true });

const VITE = `http://localhost:${PORT}`;

function startVite() {
  const proc = spawn(
    process.execPath,
    [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'],
    { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], shell: false },
  );
  proc.stdout.on('data', (d) => process.stderr.write('[vite] ' + d));
  proc.stderr.on('data', (d) => process.stderr.write('[vite] ' + d));
  return proc;
}

async function waitForVite(timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(VITE + '/', { method: 'GET', signal: AbortSignal.timeout(1000) });
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function main() {
  console.log('[live-drive] starting vite on ' + PORT);
  const vite = startVite();
  try {
    const ok = await waitForVite();
    if (!ok) throw new Error('vite did not become ready in time');
    console.log('[live-drive] vite ready, launching electron');

    const app = await electron.launch({
      args: ['.', '--user-data-dir=' + DATA_DIR, '--no-sandbox'],
      cwd: REPO,
      env: { ...process.env, FREYA_DEV_SERVER: VITE, FREYA_QUIET_HOURS: 'off', NANOGPT_API_KEY: '' },
      timeout: 60000,
    });
    console.log('[live-drive] electron launched, pid=' + app.process().pid);

    const window = await app.firstWindow();
    await window.setViewportSize({ width: 1440, height: 900 });
    console.log('[live-drive] first window url=' + window.url());

    const errors = [];
    window.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    window.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

    // Wait for the dashboard to render
    await window.waitForSelector('.hd-viewport', { timeout: 20000 });
    await window.waitForTimeout(2500);

    // Expand the rail (default is collapsed at <1800 width)
    const toggle = window.locator('.hd-rail-toggle');
    if (await toggle.count()) {
      const collapsed = await window.locator('.hd-rail').getAttribute('data-collapsed');
      if (collapsed !== null) await toggle.click();
      await window.waitForTimeout(400);
    }

    // Click Chats
    await window.locator('.chats-history-title').first().click();
    await window.waitForTimeout(900);

    // Type a draft and send (no Core => falls through to hostBridge absent => notice)
    const ta = window.locator('.hd-input textarea');
    await ta.click();
    await ta.fill('Hi Freya, this is a live drive.');
    await window.waitForTimeout(300);
    await window.keyboard.press('Enter');
    await window.waitForTimeout(1500);

    const issueCount = await window.locator('.chats-issue').count();
    const issueOpen = issueCount > 0
      ? await window.locator('.chats-issue').first().evaluate((el) => el.open)
      : null;
    console.log('[live-drive] issue drawer: count=' + issueCount + ' open=' + issueOpen);

    await window.screenshot({ path: SHOT });
    console.log('[live-drive] screenshot -> ' + SHOT);

    if (errors.length) console.log('[live-drive] errors:', JSON.stringify(errors).slice(0, 1500));

    await app.close();
  } finally {
    vite.kill();
  }
}

main().catch((e) => {
  console.error('[live-drive] FAIL', e.message);
  process.exit(1);
});