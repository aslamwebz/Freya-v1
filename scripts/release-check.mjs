#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  artifactMeasurements,
  coreSourceFiles,
  inspectCoreBoundary,
  inspectLockfile,
  inspectPerformance,
  PERFORMANCE_BUDGETS,
} from './release-policy.mjs'

const root = resolve(process.cwd())
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const lock = JSON.parse(await readFile(resolve(root, 'package-lock.json'), 'utf8'))

const failures = []
if (pkg.packageManager !== 'npm@11.5.1') failures.push('packageManager must be pinned to npm@11.5.1')
if (pkg.private !== true) failures.push('the private prototype must remain package.json private=true')
failures.push(...inspectLockfile(pkg, lock))
failures.push(...inspectCoreBoundary(await coreSourceFiles(root)))

let measured
try {
  measured = await artifactMeasurements(root)
  failures.push(...inspectPerformance(measured))
} catch (error) {
  failures.push(`release artifacts are missing or unreadable: ${error instanceof Error ? error.message : String(error)}`)
}

if (failures.length) {
  console.error('Phase 18 release check failed:')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}

console.log('Phase 18 release check passed.')
console.log('Performance budgets:', PERFORMANCE_BUDGETS)
console.log('Measured artifacts:', measured)
