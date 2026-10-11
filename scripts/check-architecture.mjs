import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { checkRepository } from './architecture/check.mjs'

const args = process.argv.slice(2)
if (args.some(arg => !['--strict', '--json'].includes(arg))) {
  console.error('Usage: node scripts/check-architecture.mjs [--strict] [--json]')
  process.exitCode = 2
} else {
  try {
    const root = process.cwd()
    const baseline = JSON.parse(readFileSync(resolve(root, 'architecture-baseline.json'), 'utf8'))
    const result = checkRepository(root, baseline, { strict: args.includes('--strict') })
    if (args.includes('--json')) console.log(JSON.stringify(result, null, 2))
    else {
      console.log(`Architecture: ${result.observations.files} files, ${result.observations.edges} local edges`)
      console.log(`Existing exceptions: ${JSON.stringify(result.exceptions)}`)
      for (const issue of result.issues) console.error(`[${issue.code}] ${issue.message}`)
      console.log(result.issues.length ? `Architecture failed: ${result.issues.length} violations` : 'Architecture passed')
    }
    process.exitCode = result.issues.length ? 1 : 0
  } catch (error) {
    console.error(`Architecture failed: ${error.message}`)
    process.exitCode = 2
  }
}
