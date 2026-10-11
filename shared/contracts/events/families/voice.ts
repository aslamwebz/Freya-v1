export const VOICE_EVENT_TYPES = [
// Voice — metadata only. Audio never reaches this file, and neither does a
  // transcript: an interim fragment is not even offered to the journal, and a
  // final one is recorded as a length and a turn reference.
  'voice.capture.started',
'voice.capture.completed',
'voice.capture.cancelled',
'voice.transcribe.started',
'voice.transcribe.completed',
'voice.transcribe.failed',
'voice.submitted',
'voice.speech.started',
'voice.speech.stopped',
'voice.speech.interrupted',
'voice.permission.changed',
'voice.wake.armed',
'voice.wake.fired',
'voice.wake.disarmed',
'voice.stopped',
] as const
