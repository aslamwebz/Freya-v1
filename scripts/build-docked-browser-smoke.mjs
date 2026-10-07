import { build } from 'esbuild'
await build({ entryPoints: ['electron/smoke-docked-browser.ts'], outfile: 'dist-electron/smoke-docked-browser.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron'] })
