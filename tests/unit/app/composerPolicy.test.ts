import { expect, it } from 'vitest'
import { composerPolicy } from '../../../src/app/chat/composerPolicy'

it('retains explicit off values and keeps disabled search modes in Chat', () => {
  expect(composerPolicy('eye', { webSearch: false, browserUse: false })).toEqual({ mode: 'chat', intents: { webSearch: false, browserUse: false } })
  expect(composerPolicy('deep-research', { webSearch: false })).toMatchObject({ mode: 'chat' })
  expect(composerPolicy('eye', { webSearch: true })).toMatchObject({ mode: 'eye' })
})
