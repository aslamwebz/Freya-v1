import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { Home } from '../../../src/ui-v2/workspaces/Home'
import { createPreviewAdapter } from '../../../src/ui-v2/state/preview'
import { createViews } from '../../../src/ui-v2/workspaces/viewState'

afterEach(cleanup)

describe('Home composition', () => {
  it('places the Brain as the centrepiece, not an avatar', () => {
    const snapshot = createPreviewAdapter().getSnapshot()
    const { container } = render(
      <Home snapshot={snapshot} view={createViews().home} update={() => {}} open={() => {}} panels={['focus', 'mission', 'attention', 'workforce']} />,
    )
    expect(container.querySelector('.f-brain')).toBeTruthy()
    expect(container.querySelector('.f-compass')).toBeFalsy()
  })

  it('reads the Brain state from the projections, not from a local flag', () => {
    // The preview fixture reports three working workers and no active calls, so the
    // Brain must show delegating — the state Core's numbers actually describe.
    const snapshot = createPreviewAdapter().getSnapshot()
    const { container } = render(
      <Home snapshot={snapshot} view={createViews().home} update={() => {}} open={() => {}} panels={['focus', 'mission', 'attention', 'workforce']} />,
    )
    expect(container.querySelector('.f-brain')).toHaveAttribute('data-state', 'delegating')
  })
})
