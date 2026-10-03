# Phase 26 — Test Plan

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

This test plan defines the testing strategy for Phase 26 Natural Presence.
It covers unit tests, integration tests, red-team tests, zero-idle-inference
tests, and no-invented-state tests.

All tests are deterministic: same inputs + same clock = same output. No test
relies on randomness, wall-clock time, or external services.

---

## 2. Unit tests

### 2.1 Presence state machine tests

| Test | Description |
|---|---|
| `presence.derive.idle` | Nothing happening → idle |
| `presence.derive.listening` | Voice capture active → listening |
| `presence.derive.no-thinking` | Provider call in flight → working; thinking is never derived |
| `presence.derive.speaking` | Synthesis active → speaking |
| `presence.derive.working` | Run executing → working |
| `presence.derive.attention` | Attention directive → attention |
| `presence.derive.error` | STOP ALL → error |
| `presence.derive.degraded` | Degraded → degraded |
| `presence.transition.idle-to-listening` | Voice capture started |
| `presence.transition.listening-to-thinking` | Reserved edge; legal, never produced |
| `presence.transition.thinking-to-speaking` | Reserved edge; legal, never produced |
| `presence.transition.speaking-to-idle` | Synthesis ended |
| `presence.transition.working-to-attention` | Attention directive received |
| `presence.transition.attention-to-idle` | Attention directive cleared |
| `presence.transition.error-to-idle` | STOP ALL deactivated |
| `presence.transition.degraded-to-idle` | Fault cleared |
| `presence.transition.illegal` | Illegal transition → refused |
| `presence.transition.timeout` | Transition exceeds duration → timed out |
| `presence.transition.history-bounded` | History exceeds 16 entries → oldest removed |

### 2.2 Voice interaction tests

| Test | Description |
|---|---|
| `voice.capture.single` | Single push-to-talk capture |
| `voice.capture.multi-turn` | Multiple captures in sequence |
| `voice.capture.bounded` | Capture exceeds bound → refused |
| `voice.capture.local-only` | No cloud service is called |
| `voice.capture.explicit` | Capture is explicit (press-and-release) |
| `voice.session.bounded` | Session exceeds bound → refused |
| `voice.session.history` | Session history is bounded |
| `voice.session.local-only` | No cloud service is called |
| `voice.synthesis.local-only` | Synthesis is local-only |
| `voice.synthesis.bounded` | Synthesis exceeds bound → refused |

### 2.3 Embodiment cue tests

| Test | Description |
|---|---|
| `cue.attention-urgent` | Urgent attention directive → cue activated |
| `cue.attention-normal` | Normal attention directive → cue activated |
| `cue.work-running` | Running run → cue activated |
| `cue.work-waiting` | Waiting run → cue activated |
| `cue.work-approval` | Awaiting approval run → cue activated |
| `cue.voice-listening` | Voice capture active → cue activated |
| `cue.voice-speaking` | Voice synthesis active → cue activated |
| `cue.personality-cue` | Personality cue active → cue activated |
| `cue.bounded` | Cue list exceeds 8 → oldest removed |
| `cue.deactivation` | Derivation source removed → cue deactivated |

### 2.4 Presence frame tests

| Test | Description |
|---|---|
| `frame.creation` | Frame is created from real Core state |
| `frame.update` | Frame is updated from real Core state |
| `frame.expiry` | Frame expires after bounded duration |
| `frame.transition-history` | Transition history is bounded |
| `frame.embodiment-cues` | Embodiment cues are bounded |
| `frame.voice-session-history` | Voice session history is bounded |
| `frame.stop-all` | STOP ALL → error state |
| `frame.degraded` | Degraded → degraded state |
| `frame.no-invented-state` | No mood, emotion, or mental state claims |

---

## 3. Integration tests

### 3.1 Full presence frame flow

| Test | Description |
|---|---|
| `integration.core-to-frame` | Core state → presence frame |
| `integration.core-to-renderer` | Core state → presence frame → renderer |
| `integration.transition-flow` | Transition → history → frame |
| `integration.voice-flow` | Voice capture → session → history → frame |
| `integration.cue-flow` | Core state → cue → frame |

### 3.2 Authority preservation tests

| Test | Description |
|---|---|
| `authority.guard-not-bypassed` | Guard capability checks are never bypassed |
| `authority.governor-not-bypassed` | Governor cognition authorization is never bypassed |
| `authority.stop-all-respected` | STOP ALL immediately halts everything |
| `authority.budgets-respected` | Budget limits are never exceeded |
| `authority.approvals-respected` | Approval requirements are never skipped |
| `authority.no-self-approval` | Presence cannot approve its own requests |
| `authority.no-grant-creation` | Presence cannot create grants |
| `authority.no-capability-widening` | Presence cannot widen capabilities |

---

## 4. Red-team tests

### 4.1 Authority escalation attempts

| Test | Description |
|---|---|
| `redteam.worker-claims-capability` | Worker claims a capability it does not hold → refused |
| `redteam.worker-claims-authority` | Worker claims authority it does not have → refused |
| `redteam.worker-claims-owner` | Worker claims to be the owner → refused |
| `redteam.worker-claims-budget` | Worker claims more budget → refused |
| `redteam.worker-claims-approval` | Worker claims approval it does not have → refused |
| `redteam.model-claims-urgency` | Model output claims urgency → data, not authority |
| `redteam.model-claims-priority` | Model output claims priority → data, not authority |
| `redteam.model-claims-outcome` | Model output claims outcome → data, not authority |
| `redteam.event-claims-importance` | Event claims importance → data, not authority |
| `redteam.event-claims-deadline` | Event claims deadline → data, not authority |
| `redteam.context-claims-authority` | Context claims authority → data, not authority |

### 4.2 Boundary violation attempts

| Test | Description |
|---|---|
| `redteam.bypass-guard` | Attempt to bypass Guard → refused |
| `redteam.bypass-governor` | Attempt to bypass Governor → refused |
| `redteam.bypass-stop-all` | Attempt to bypass STOP ALL → refused |
| `redteam.exceed-budget` | Attempt to exceed budget → refused |
| `redteam.skip-approval` | Attempt to skip approval → refused |
| `redteam.widen-capability` | Attempt to widen capability → refused |
| `redteam.create-grant` | Attempt to create grant → refused |
| `redteam.self-approve` | Attempt to self-approve → refused |
| `redteam.hidden-inference` | Attempt to hide inference → detected |
| `redteam.continuous-polling` | Attempt to poll continuously → detected |

### 4.3 Invented state attempts

| Test | Description |
|---|---|
| `redteam.invent-mood` | Attempt to invent mood → refused |
| `redteam.invent-emotion` | Attempt to invent emotion → refused |
| `redteam.invent-mental-state` | Attempt to invent mental state → refused |
| `redteam.invent-personality` | Attempt to invent personality trait → refused |
| `redteam.invent-presence-state` | Attempt to invent presence state → refused |
| `redteam.invent-animation` | Attempt to invent animation → refused |
| `redteam.invent-cue` | Attempt to invent cue → refused |

---

## 5. Zero-idle-inference tests

### 5.1 No model call without wake

| Test | Description |
|---|---|
| `zero-idle.no-model-call-without-wake` | No model call occurs without a wake event |
| `zero-idle.no-continuous-polling` | No continuous polling occurs |
| `zero-idle.no-hidden-reasoning` | No hidden reasoning occurs |
| `zero-idle.no-unrestricted-loops` | No unrestricted loops occur |
| `zero-idle.no-idle-model-call` | No model call occurs while idle |
| `zero-idle.no-background-reasoning` | No background reasoning occurs |
| `zero-idle.no-hidden-durable-state` | No hidden durable state is created |

### 5.2 Wake source validation

| Test | Description |
|---|---|
| `zero-idle.authorized-wake-sources` | Only authorized wake sources are accepted |
| `zero-idle.unauthorized-wake-refused` | Unauthorized wake sources are refused |
| `zero-idle.wake-from-renderer` | Wake from renderer is accepted (owner-interaction) |
| `zero-idle.wake-from-event` | Wake from authorized event is accepted |
| `zero-idle.wake-from-heartbeat` | Wake from scheduled heartbeat is accepted |
| `zero-idle.wake-from-mission` | Wake from mission transition is accepted |
| `zero-idle.wake-from-work` | Wake from work transition is accepted |

---

## 6. Restart recovery tests

### 6.1 Event-driven resumption

| Test | Description |
|---|---|
| `restart.replay-journal` | Journal is replayed on restart |
| `restart.rebuild-presence-state` | Presence state is rebuilt from journal |
| `restart.reconcile-interrupted-transitions` | Interrupted transitions are reconciled |
| `restart.resume-or-terminate` | Presence resumes or terminates explicitly |
| `restart.deterministic` | Same journal + same clock = same state |
| `restart.no-hidden-state` | No hidden state survives restart |
| `restart.no-fabricated-state` | No state is fabricated on restart |

### 6.2 Interrupted transition recovery

| Test | Description |
|---|---|
| `restart.interrupted-transition-reconciled` | Interrupted transitions are reconciled |
| `restart.interrupted-transition-not-resumed` | Interrupted transitions are not silently resumed |
| `restart.interrupted-transition-visible` | Interrupted transitions are visible to owner |
| `restart.interrupted-transition-journaled` | Interrupted transitions are journaled |

---

## 7. Test infrastructure

### 7.1 Test doubles

- `FakeClock`: deterministic clock for testing
- `FakeJournal`: in-memory journal for testing
- `FakeWorker`: fake worker for testing
- `FakeModelProvider`: fake model provider for testing
- `FakeGuard`: fake Guard for testing
- `FakeGovernor`: fake Governor for testing
- `FakeVoiceTranscriber`: fake voice transcriber for testing
- `FakeVoiceSynthesizer`: fake voice synthesizer for testing

### 7.2 Test helpers

- `createTestPresenceInput()`: creates a test presence input
- `createTestPresenceFrame()`: creates a test presence frame
- `createTestTransition()`: creates a test transition
- `createTestEmbodimentCue()`: creates a test embodiment cue
- `createTestVoiceSession()`: creates a test voice session

### 7.3 Test conventions

- All tests are synchronous unless testing async behavior
- All tests use injected clock, never `Date.now()`
- All tests use injected journal, never a real file
- All tests use injected model provider, never a real model
- All tests are deterministic and repeatable

---

## 8. Coverage targets

| Component | Line coverage | Branch coverage |
|---|---|---|
| Presence State Machine | 95% | 90% |
| Voice Interaction | 95% | 90% |
| Embodiment Cues | 95% | 90% |
| Presence Frame | 95% | 90% |
| Authority Preservation | 100% | 100% |
| Zero Idle Inference | 100% | 100% |
| No Invented State | 100% | 100% |
| Restart Recovery | 95% | 90% |

---

## 9. Test execution

Tests are run as part of the standard verification gate:

```bash
npm test
```

All tests must pass before the phase is considered complete.
