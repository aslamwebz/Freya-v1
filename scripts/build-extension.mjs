#!/usr/bin/env node
import { build } from 'esbuild'
import { copyFile, mkdir, rm } from 'node:fs/promises'

/**
 * Build the Manifest V3 extension into `extension/dist/`.
 *
 * The extension is deliberately not part of the renderer or Electron bundles: it is a
 * separate artifact a person loads unpacked (or ships to the Web Store). Bundling it
 * here keeps its dependency graph closed to the extension's own source and the browser
 * APIs it declares in `chrome.d.ts`.
 */

const shared = {
  bundle: true,
  platform: 'browser',
  target: 'chrome116',
  format: 'esm',
  sourcemap: true,
  logLevel: 'info',
}

await rm('extension/dist', { recursive: true, force: true })
await mkdir('extension/dist', { recursive: true })

await build({
  ...shared,
  entryPoints: ['extension/src/background.ts'],
  outfile: 'extension/dist/background.js',
})

await build({
  ...shared,
  entryPoints: ['extension/src/popup.ts'],
  outfile: 'extension/dist/popup.js',
})

await copyFile('extension/src/popup.html', 'extension/dist/popup.html')
await copyFile('extension/src/popup.css', 'extension/dist/popup.css')

console.log('extension built to extension/dist')
