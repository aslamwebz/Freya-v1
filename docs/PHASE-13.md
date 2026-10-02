# Phase 13 — Desktop Presence

A truthful, replaceable presentation layer over Core-owned state. The presence
window is a transparent, frameless, always-on-top window that shows Freya's
presence as a small character/avatar. It holds no Core state, makes no model
calls, and decides nothing.

The governing rule is the one in [PRODUCT.md](PRODUCT.md): *models decide, code
controls*. Presence is the subsystem where that rule is easiest to violate — a
"smart avatar" feature naturally drifts toward claiming emotional states it
cannot know — so Phase 13 is written the other way: the state, the animation,
the cue and the card are all derived from Core projections by a pure state
machine, and the renderer draws what it is told.

## Core ownership

`core/presence/` is Core's, and it is Electron-free and renderer-free.

| File | Owns |
| --- | --- |
| `protocol.ts` | The platform-neutral presence protocol: states, transitions, animation vocabulary, voice seam, frame validation. |
| `stateMachine.ts` | The pure derivation of presence from Core projections. |

The state machine holds no gateway, no provider, no authority object and no
capability. It cannot spend money, mint a capability, clear STOP ALL or widen a
permission, because none of those exists on any type it holds.

## The eight presence states

```
idle · listening · thinking · speaking · working · attention · error · degraded
```

Every state is derived from real Core state. The renderer never invents a
state, never decides urgency, and never claims an emotional or mental state it
cannot observe:

- `idle` — nothing is happening.
- `listening` — a voice capture is open.
- `thinking` — a provider call is in flight (reserved; see below).
- `speaking` — a synthesis engine is producing audio.
- `working` — a provider call is in flight or a Run is executing.
- `attention` — Core chose to cue (attention directive or personality cue).
- `error` — STOP ALL is active or the journal is corrupt.
- `degraded` — Core is running but a subsystem has faulted.

`thinking` is in the vocabulary for a future phase where a turn is running but
no provider call has been made yet. This phase never produces it, because the
only honest signal for "thinking" is a provider call in flight, which is
`working`.

## Bounded animation vocabulary

Each presence state maps to exactly one animation, fixed by the protocol:

| State | Animation | Meaning |
| --- | --- | --- |
| idle | breathe | slow pulse |
| listening | pulse | faster pulse |
| thinking | spin | rotation |
| speaking | wave | waveform |
| working | glow | bright glow |
| attention | alert | alert pulse |
| error | alert | alert pulse |
| degraded | dim | dimmed |

The renderer maps each state to at most one animation. A renderer that wanted
to invent a new animation would have to add it to the protocol, which means the
change is visible rather than hidden in a shader.

## The presence protocol

The protocol (`core/presence/protocol.ts`) is the platform-neutral contract
between Core and a presence renderer. It is deliberately Electron-free,
Three.js-free and renderer-free: a future Godot or native renderer replaces
the presentation layer by implementing this protocol, not by moving Core
authority.

A presence frame is the unit of the protocol:

```typescript
interface PresenceFrame {
  schemaVersion: number
  state: PresenceProtocolState
  animation: PresenceAnimation
  stateSince: number
  detail: string
  voiceCapture: { active: boolean; available: boolean; sessionId: string | null }
  voiceSynthesis: { active: boolean; available: boolean; label: string | null }
  attention: AttentionDirectiveView | null
  personalityCue: PersonalityCueView | null
  work: PresenceWorkSummary | null
  sequence: number
}
```

Frames are validated with strict exact-key checking: a frame with an unknown
key is refused, not ignored. A renderer that could ignore an unknown key would
be a renderer that could be talked into rendering a field Core never sent.

## The presence window

The presence window is a transparent, frameless, always-on-top window that
shows Freya's presence as a small character/avatar.

### Click-through and interaction mode

The window is click-through by default: mouse events pass through it to
whatever is beneath. When the user presses the interaction toggle (or drags
the window), the window becomes interactive for a bounded period (8 seconds),
then returns to click-through. A window that was always interactive would
block the desktop; a window that was never interactive could not be moved.

### Monitor-aware placement

The window is placed on the same display as the main dashboard window, in the
bottom-right corner. When the dashboard moves to another monitor, the presence
window follows. When the display configuration changes, the presence window
re-evaluates its placement.

### What it does not do

- It does not decide presence state. The state machine does that.
- It does not make model calls.
- It does not hold Core state. It reads projections and forwards them.
- It does not allow the renderer to submit commands or read Core state.

## Voice integration seam

The voice seam is truthful and bounded:

- **Speech in**: a voice capture is open (`voice.capture.start`). The presence
  window shows `listening`. The capture is bounded, the audio is never stored,
  and the renderer holds no audio bytes.
- **Speech out**: a synthesis engine is producing audio. The presence window
  shows `speaking`. The synthesis is a future seam; this phase wires the
  protocol and the state machine, but no synthesis engine exists yet, so
  `speaking` is never produced. That is honest: the state is in the
  vocabulary, the renderer can draw it, but the state machine does not invent
  it.

There is no hidden recording, no surveillance expansion, and no auto-start.
The microphone opens only when the user presses the capture control, and it
closes when the user releases it or the capture times out.

## Contextual cards and cues

The presence window shows at most one attention directive, one personality cue,
and one work summary. All three are derived from Core projections through
narrow read-only contracts:

- **Attention**: the one directive Core chose (`subtle-cue`, `speak`, or
  `interrupt`), with its code-owned cue label. The renderer cannot invent an
  urgency or an importance.
- **Personality**: the one cue Core chose, with its code-owned kind. The
  renderer cannot hold the cue's content.
- **Work**: a bounded summary of running runs. The renderer cannot read step
  input or observation contents.

## Dashboard ↔ Presence transitions

The dashboard (main window) and the presence window share the same Core
state. The presence window does not duplicate truth: it receives presence
frames from the host and draws them. The dashboard does not interpret
presence state for the presence window; the state machine does that for both.

## Restart and recovery

The presence window is a presentation layer only. It holds no durable state.
When the app restarts, the presence window is recreated and receives a fresh
presence frame from the host. The presence state is derived from Core's
durable state, so it survives a restart exactly as Core's state does.

## Red-team

The red-team suite covers:

- **Renderer forgery**: a compromised renderer cannot forge a presence frame.
- **Click-through trapping**: the window returns to click-through after a
  bounded period.
- **Window spam**: the presence host creates exactly one window.
- **Fake working state**: the state machine never produces `working` without a
  provider call or a running run.
- **Attention cue escalation**: the state machine never escalates past `error`.
- **Voice auto-start**: the microphone opens only when the user presses the
  capture control.
- **Hidden capture**: the renderer holds no audio bytes.
- **Monitor-jump loops**: the presence window follows the dashboard, not the
  other way around.
- **Stale-state replay**: the presence window receives fresh frames from the
  host.
- **Protocol injection**: frames are validated with strict exact-key checking.
- **STOP ALL bypass**: STOP ALL outranks every other signal.
- **Model-call amplification**: the state machine makes no model call.

## Verification

On 2026-10-02 the full gate passed on `phase-13-desktop-presence`:

- **Focused Phase 13 tests:** 39 tests in 2 files — the presence protocol and
  the state machine.
- **Phase 13 red-team tests:** 19 tests in 2 files — renderer forgery and
  state machine integrity.
- **Full suite:** 2,834 tests in 164 files, typecheck, lint, the renderer/main/
  preload build and 195/195 offline Electron desktop checks, all under
  `npm run verify` (`EXIT=0`). The desktop suite includes five checks that
  verify the presence window exists, is transparent, shows the correct state,
  is click-through, and has no command bar.

## Deliberately deferred

- **A native/Godot renderer** is a future phase. The protocol is the contract;
  any renderer that can draw a `PresenceFrame` can be a presence renderer.
- **A real synthesis engine** is a future phase. The protocol and the state
  machine support `speaking`, but no engine exists yet, so the state is never
  produced.
- **A real transcription engine** is a future phase. The protocol and the
  state machine support `listening`, and the capture seam exists, but no local
  engine is configured in this build.
- **Thinking as a distinct state** is a future phase. The state is in the
  vocabulary, but this phase never produces it, because the only honest signal
  for "thinking" is a provider call in flight, which is `working`.
