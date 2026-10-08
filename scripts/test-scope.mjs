import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const FAST_CHAT = [
  'tests/unit/app',
  'tests/unit/chat',
  'tests/unit/chatIntent.test.ts',
  'tests/unit/chatMediaPreview.test.tsx',
  'tests/unit/dockedBrowserStore.test.ts',
  'tests/unit/capabilities.test.ts',
]

const CHAT_INTEGRATION = [
  ...FAST_CHAT,
  'tests/unit/electron/browserRendererRequest.test.ts',
  'tests/unit/electron/coreHost-reenv.test.ts',
  'tests/core/browser',
  'tests/core/research',
  'tests/core/cognition.test.ts',
  'tests/core/mind.test.ts',
  'tests/core/mind/tool-intent.test.ts',
  'tests/core/mind/tool-intent-contamination.test.ts',
  'tests/core/devicehands/owner-policy-upgrade.test.ts',
  'tests/host/capabilityRuntime.test.ts',
  'tests/host/minimaxSearch.test.ts',
  'tests/host/owner-browser-authority.test.ts',
  'tests/host/dualBrowser.test.ts',
  'tests/host/research-extract.test.ts',
  'tests/host/research-target.test.ts',
  'tests/host/preloadModelCommands.test.ts',
  'tests/host/voiceCapabilities.test.ts',
]

const scopes = {
  chat: FAST_CHAT,
  'chat-integration': CHAT_INTEGRATION,
}

const scope = process.argv[2]
const files = scopes[scope]
const watch = process.argv.includes('--watch')
if (!files) {
  process.stderr.write('Unknown test scope: ' + (scope ?? '(missing)') + '\nAvailable: ' + Object.keys(scopes).join(', ') + '\n')
  process.exit(2)
}

process.stdout.write('Freya test scope: ' + scope + ' (' + files.length + ' paths)\n')
const vitest = resolve('node_modules', 'vitest', 'vitest.mjs')
const result = spawnSync(process.execPath, [vitest, ...(watch ? [] : ['run']), ...files], {
  stdio: 'inherit',
  cwd: process.cwd(),
  env: { ...process.env, FREYA_TEST_SCOPE: scope },
})
if (result.error) {
  process.stderr.write(result.error.message + '\n')
  process.exit(1)
}
process.exit(result.status ?? 1)
