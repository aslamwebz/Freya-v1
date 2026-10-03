import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Button, Field, Progress, Panel } from '../../../src/ui-v2/primitives/Controls'
afterEach(cleanup)
describe('Phase 19 controls', () => {
  it('prevents unavailable actions and does not submit forms by default', () => {
    let actions = 0
    render(<form><Button disabled onClick={() => actions++}>Create</Button><Button>Inspect</Button></form>)
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(actions).toBe(0)
    expect(screen.getByRole('button', { name: 'Inspect' })).toHaveAttribute('type', 'button')
  })
  it('associates fields with their visible label and renders a named panel', () => {
    render(<Panel title="Mission"><Field label="Search missions" /></Panel>)
    expect(screen.getByRole('region', { name: 'Mission' })).toBeInTheDocument()
    expect(screen.getByLabelText('Search missions')).toHaveAccessibleName('Search missions')
  })
  it('does not represent unknown or invalid progress as an exact percentage', () => {
    const { rerender } = render(<Progress label="Verification" value={null} />)
    expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow')
    rerender(<Progress label="Verification" value={Number.NaN} />)
    expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow')
    rerender(<Progress label="Verification" value={140} />)
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100')
  })
})
