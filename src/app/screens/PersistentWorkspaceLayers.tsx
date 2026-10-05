import { useRef, type ReactNode } from 'react'

/**
 * Mount-once workspace stack.
 *
 * Home is present from the first paint. Every other workspace joins the stack the
 * first time it is visited and is never removed merely because navigation changed.
 * Switching screens therefore changes visibility, not component identity.
 *
 * This matters for Freya's expensive presence rendering, chat scroll/drafts,
 * browser controllers, forms and any future canvas/native-view coordination.
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
  const mounted = useRef<Set<string> | null>(null)
  if (mounted.current === null) mounted.current = new Set(['home', active])
  mounted.current.add(active)

  return (
    <>
      {workspaceIds.map((workspaceId) => {
        if (!mounted.current?.has(workspaceId)) return null
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
