import { build } from 'esbuild'
await build({ entryPoints: ['electron/acceptance-browser-service.ts'], outfile: 'dist-electron/acceptance-browser-service.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron'] })
