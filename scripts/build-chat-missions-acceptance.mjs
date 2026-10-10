import { build } from 'esbuild'
await build({ entryPoints: ['electron/acceptance-chat-missions.ts'], outfile: 'dist-electron/acceptance-chat-missions.cjs', bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron', 'better-sqlite3', 'pdfjs-dist'], logLevel: 'info' })
