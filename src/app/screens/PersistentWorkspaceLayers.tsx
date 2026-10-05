import { useEffect, useState, type ReactNode } from 'react'

/**
 * Mount-once workspace stack.
 *
 * Home is present from the first paint. Every other workspace joins the stack the
 * first time it is visited and is never removed merely because navigation changed.
 * Switching screens therefore changes visibility, not component identity.
 *
 * The active workspace is rendered immediately even before the bookkeeping effect
 * records it as visited. When the effect runs the same keyed section stays in the
 * same place, so React does not remount it.
 */
export function PersistentWorkspaceLayers({
  active,
  workspaceIds,
  renderWorkspace,
}: {
  readonly active: string
  readonly workspaceIds: readonly string[]
  readonly renderWorkspace: (workspaceId: string) => ReactNode
}) {
  const [visited, setVisited] = useState<ReadonlySet<string>>(
    () => new Set(['home', active]),
  )

  useEffect(() => {
    if (visited.has(active)) return
    setVisited((current) => {
      if (current.has(active)) return current
      const next = new Set(current)
      next.add(active)
      return next
    })
  }, [active, visited])

  return (
    <>
      {workspaceIds.map((workspaceId) => {
        if (!visited.has(workspaceId) && workspaceId !== active) return null
        const visible = workspaceId === active
        return (
          <section
            key={workspaceId}
            className="hd-workspace-layer"
            data-workspace={workspaceId}
            hidden={!visible}
            aria-hidden={!visible || undefined}
          >
            {renderWorkspace(workspaceId)}
          </section>
        )
      })}
    </>
  )
}
