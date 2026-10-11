import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useState } from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { MatrixService } from '../../core/matrix/service'
import { MatrixWorkspace } from '../../src/app/matrix/MatrixWorkspace'
import { resetMatrixClient } from '../../src/platform/matrixClient'

let folder: string
let service: MatrixService
beforeEach(async () => {
  folder = await mkdtemp(join(process.cwd(), '.kilo', 'matrix-ui-'))
  service = await MatrixService.open({ path: join(folder, 'matrix.enc'), key: new Uint8Array(32).fill(12) })
  resetMatrixClient()
  window.freyaHost = { coreSubmit: async (command: string, payload: unknown) => ({ ok: true, matrix: await service.execute(command, payload) }) } as never
})
afterEach(async () => { cleanup(); delete window.freyaHost; resetMatrixClient(); await service.close(); await rm(folder, { recursive: true, force: true }) })
function Harness() {
  const [section, setSection] = useState('overview')
  return <MatrixWorkspace section={section} onNavigate={path => setSection(path.split('/')[1]!)} />
}
describe('Matrix workspace', () => {
  it('creates a durable space, searches records above the tabs, and edits its settings', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(await screen.findByRole('button', { name: 'New space' }))
    await user.type(screen.getByRole('textbox', { name: 'Space name' }), 'Atlas')
    await user.click(screen.getByRole('button', { name: 'Create space' }))
    await screen.findByRole('heading', { name: 'Atlas' })
    await user.click(screen.getByRole('tab', { name: 'Knowledge' }))
    await user.click(screen.getByRole('button', { name: 'Add knowledge' }))
    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Launch plans')
    await user.type(screen.getByRole('textbox', { name: 'Content' }), 'The launch is Friday')
    await user.click(screen.getByRole('button', { name: 'Save record' }))
    await screen.findByRole('heading', { name: 'Launch plans' })
    expect(screen.queryByRole('tab', { name: 'Search' })).toBeNull()
    await user.type(screen.getByRole('searchbox', { name: 'Search this space' }), 'absent')
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Launch plans' })).toBeNull())
    await user.clear(screen.getByRole('searchbox', { name: 'Search this space' }))
    await user.click(screen.getByRole('tab', { name: 'Settings' }))
    const name = screen.getByRole('textbox', { name: 'Space name' })
    await user.clear(name)
    await user.type(name, 'Atlas updated')
    await user.click(screen.getByRole('button', { name: 'Save space' }))
    await screen.findByRole('heading', { name: 'Atlas updated' })
    expect(service.projection().spaces[0]?.name).toBe('Atlas updated')
  })
  it('keeps records isolated when changing spaces and confirms deletion', async () => {
    const a = (await service.execute('matrix.spaces.create', { name: 'Alpha' })).space!.id
    await service.execute('matrix.spaces.create', { name: 'Beta' })
    await service.execute('matrix.entries.create', { spaceId: a, kind: 'person', title: 'Sam', content: 'Designer' })
    const user = userEvent.setup()
    render(<Harness />)
    await screen.findByRole('heading', { name: 'Alpha' })
    await user.click(screen.getByRole('tab', { name: 'People' }))
    await screen.findByRole('heading', { name: 'Sam' })
    await user.click(screen.getByRole('button', { name: 'Open Beta' }))
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Sam' })).toBeNull())
    await user.click(screen.getByRole('tab', { name: 'Settings' }))
    await user.click(screen.getByRole('button', { name: 'Delete space' }))
    expect(service.projection().spaces).toHaveLength(2)
    await user.click(screen.getByRole('button', { name: 'Delete this space and its records' }))
    await waitFor(() => expect(service.projection().spaces).toHaveLength(1))
  })

  it('uploads the selected file bytes through Core and updates then deletes a record', async () => {
    const id = (await service.execute('matrix.spaces.create', { name: 'Files' })).space!.id
    const user = userEvent.setup()
    render(<Harness />)
    await screen.findByRole('heading', { name: 'Files' })
    await user.click(screen.getByRole('tab', { name: 'Files' }))
    await user.upload(screen.getByLabelText('Upload files to this space'), new File(['hello file'], 'notes.txt', { type: 'text/plain' }))
    await screen.findByRole('heading', { name: 'notes.txt' })
    const uploaded = (await service.execute('matrix.entries.read', { spaceId: id })).entries![0]!
    const full = await service.execute('matrix.entries.read', { spaceId: id, entryId: uploaded.id })
    expect(full.entry?.dataBase64).toBe('aGVsbG8gZmlsZQ==')
    await user.click(screen.getByRole('button', { name: 'Edit notes.txt' }))
    await user.clear(screen.getByRole('textbox', { name: 'Filename' }))
    await user.type(screen.getByRole('textbox', { name: 'Filename' }), 'renamed.txt')
    await user.click(screen.getByRole('button', { name: 'Save record' }))
    await screen.findByRole('heading', { name: 'renamed.txt' })
    await user.click(screen.getByRole('button', { name: 'Delete renamed.txt' }))
    await user.click(screen.getByRole('button', { name: 'Confirm delete renamed.txt' }))
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'renamed.txt' })).toBeNull())
    expect((await service.execute('matrix.entries.read', { spaceId: id })).entries).toEqual([])
  })
})
