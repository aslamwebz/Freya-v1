import { useEffect, useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PersistentWorkspaceLayers } from '../../../src/app/screens/PersistentWorkspaceLayers'

afterEach(cleanup)

function StatefulWorkspace({ id, onMount }: { id: string; onMount: (id: string) => void }) {
  const [draft, setDraft] = useState('')
  useEffect(() => {
    onMount(id)
  }, [id, onMount])

  return (
    <label>
      {id}
      <input
        aria-label={id + ' draft'}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
    </label>
  )
}

describe('PersistentWorkspaceLayers', () => {
  it('mounts Home once, lazily mounts a workspace, and keeps its local state when hidden', () => {
    const onMount = vi.fn()
    const ids = ['home', 'chat', 'settings'] as const
    const renderWorkspace = (id: string) => <StatefulWorkspace id={id} onMount={onMount} />

    const view = render(
      <PersistentWorkspaceLayers active="home" workspaceIds={ids} renderWorkspace={renderWorkspace} />,
    )

    expect(onMount.mock.calls.map(([id]) => id)).toEqual(['home'])
    expect(screen.queryByLabelText('chat draft')).toBeNull()

    view.rerender(
      <PersistentWorkspaceLayers active="chat" workspaceIds={ids} renderWorkspace={renderWorkspace} />,
    )
    expect(onMount.mock.calls.map(([id]) => id)).toEqual(['home', 'chat'])

    fireEvent.change(screen.getByLabelText('chat draft'), { target: { value: 'unfinished thought' } })

    view.rerender(
      <PersistentWorkspaceLayers active="home" workspaceIds={ids} renderWorkspace={renderWorkspace} />,
    )
    view.rerender(
      <PersistentWorkspaceLayers active="chat" workspaceIds={ids} renderWorkspace={renderWorkspace} />,
    )

    expect(onMount.mock.calls.map(([id]) => id)).toEqual(['home', 'chat'])
    expect((screen.getByLabelText('chat draft') as HTMLInputElement).value).toBe('unfinished thought')
    expect(screen.queryByLabelText('settings draft')).toBeNull()
  })

  it('keeps previously visited layers in the DOM but hides inactive ones', () => {
    const onMount = vi.fn()
    const ids = ['home', 'chat'] as const
    const renderWorkspace = (id: string) => <StatefulWorkspace id={id} onMount={onMount} />

    const view = render(
      <PersistentWorkspaceLayers active="chat" workspaceIds={ids} renderWorkspace={renderWorkspace} />,
    )
    view.rerender(
      <PersistentWorkspaceLayers active="home" workspaceIds={ids} renderWorkspace={renderWorkspace} />,
    )

    const chatLayer = document.querySelector('[data-workspace="chat"]') as HTMLElement
    const homeLayer = document.querySelector('[data-workspace="home"]') as HTMLElement
    expect(chatLayer.hidden).toBe(true)
    expect(homeLayer.hidden).toBe(false)
  })
})
