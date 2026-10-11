import { expect, it } from 'vitest'
import { parseVideoDuration, videoDurationConstraint, matchesVideoDuration } from '../../../core/research/video-duration'
import { parseSearchRequest, patchFromFollowUp } from '../../../core/research/sessions'

it('recognises explicit runtime constraints without turning minutes into result counts', () => {
  const parsed = parseSearchRequest('I need videos over 150 minutes about physics')
  expect(parsed.intent.targetCount).toBe(10)
  expect(parsed.intent.constraints).toEqual(['over 150 minutes'])
  expect(parsed.intent.subject).toContain('physics')
  expect(patchFromFollowUp('ok I need videos over 150 minues', parsed.intent).patch?.addConstraints).toEqual(['over 150 minues'])
})
it('keeps over strict, at least inclusive, and rejects unknown runtimes', () => {
  const limit = videoDurationConstraint('videos over 150 minutes')!
  expect(matchesVideoDuration('2:30:00', limit)).toBe(false)
  expect(matchesVideoDuration('2:31:00', limit)).toBe(true)
  expect(matchesVideoDuration(null, limit)).toBe(false)
  expect(matchesVideoDuration('9000', videoDurationConstraint('at least 150 minutes')!)).toBe(true)
  expect(matchesVideoDuration('9010', videoDurationConstraint('under 150 minutes')!)).toBe(false)
})
it('reads only unambiguous reported runtime formats', () => {
  expect(parseVideoDuration('2h 31m')).toBe(9060)
  expect(parseVideoDuration('PT2H31M')).toBe(9060)
  expect(parseVideoDuration('151 minutes')).toBe(9060)
  expect(parseVideoDuration('2:90:00')).toBeNull()
  expect(parseVideoDuration('live')).toBeNull()
})
