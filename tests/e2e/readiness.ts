/** DOM predicates passed directly to Playwright's browser context. */
export function appReady(): boolean {
  const error = document.querySelector('.boot-error')
  if (error) throw new Error(`Renderer boot failed: ${error.textContent ?? 'unknown error'}`)
  const root = document.querySelector('.app[data-ready="true"]')
  const core = [...(root?.querySelectorAll('.runtime-row') ?? [])].find(
    (row) => row.querySelector('dt')?.textContent === 'Core',
  )
  // Shell hydration and Core startup are separate. Neither depends on WebGL
  // or on Playwright considering the root's layout box visible.
  return root !== null && core?.querySelector('dd b')?.textContent === 'Ready' &&
    root.querySelector('.presence') !== null
}

export function vaultSettled(): boolean {
  const surface = document.querySelector('[role="dialog"][aria-label="Vault"] .vault-surface')
  const health = surface?.getAttribute('data-health')
  const durable = surface?.getAttribute('data-durable')
  // The non-null ABSENT_PROJECTION also renders a banner. It is not a settled
  // persistence report. Accept either durability value; assertions decide if
  // that value is correct for the injected keys, rather than waiting for green.
  return (health === 'healthy' || health === 'degraded') &&
    (durable === 'true' || durable === 'false')
}
