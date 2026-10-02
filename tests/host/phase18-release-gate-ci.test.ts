import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

describe('Phase 18 release gate CI enforcement', () => {
  it('runs release:check in the CI workflow', async () => {
    const workflowPath = resolve(__dirname, '../../.github/workflows/verify.yml')
    const content = await readFile(workflowPath, 'utf8')
    expect(content).toContain('npm run release:check')
  })

  it('runs release:manifest in the CI workflow', async () => {
    const workflowPath = resolve(__dirname, '../../.github/workflows/verify.yml')
    const content = await readFile(workflowPath, 'utf8')
    expect(content).toContain('npm run release:manifest')
  })

  it('runs release:check after build so artifacts exist', async () => {
    const workflowPath = resolve(__dirname, '../../.github/workflows/verify.yml')
    const content = await readFile(workflowPath, 'utf8')
    const buildIndex = content.indexOf('npm run build')
    const checkIndex = content.indexOf('npm run release:check')
    expect(buildIndex).toBeGreaterThan(-1)
    expect(checkIndex).toBeGreaterThan(buildIndex)
  })
})
