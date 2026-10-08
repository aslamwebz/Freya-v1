import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { BootScreen } from '../../../src/app/boot/BootScreen'
import { createPreviewAdapter } from '../../../src/ui-v2/state/preview'
import type { CoreView, Resource } from '../../../src/ui-v2/state/contract'

afterEach(() => { cleanup(); vi.useRealTimers() })
const resource = createPreviewAdapter().getSnapshot().core
const base = resource.status === 'ready' ? resource.data : null!

it('opens an operational degraded workspace but waits while Core is starting', () => {
  vi.useFakeTimers()
  const onDone = vi.fn()
  const core = (over: Partial<CoreView>): Resource<CoreView> => ({ status: 'ready', source: 'live', data: { ...base, ...over } })
  const view = render(<BootScreen core={core({ lifecycle: 'starting', operational: false })} attached onDone={onDone} />)
  act(() => { vi.advanceTimersByTime(700) })
  expect(onDone).not.toHaveBeenCalled()
  view.rerender(<BootScreen core={core({ lifecycle: 'degraded', operational: true })} attached onDone={onDone} />)
  act(() => { vi.advanceTimersByTime(1) })
  expect(onDone).toHaveBeenCalled()
})
