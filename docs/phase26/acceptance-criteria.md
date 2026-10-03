# Phase 26 — Acceptance Criteria

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

These acceptance criteria define the conditions that must be met for Phase 26
to be considered complete. They are the gate between preparation and
implementation.

Each criterion is testable and auditable. A criterion is met when its test
passes and its invariant holds.

---

## 2. Functional criteria

### 2.1 Presence state machine

| Criterion | Test |
|---|---|
| F1: Derive idle state | `presence.derive.idle` |
| F2: Derive listening state | `presence.derive.listening` |
| F3: Derive thinking state | `presence.derive.thinking` |
| F4: Derive speaking state | `presence.derive.speaking` |
| F5: Derive working state | `presence.derive.working` |
| F6: Derive attention state | `presence.derive.attention` |
| F7: Derive error state | `presence.derive.error` |
| F8: Derive degraded state | `presence.derive.degraded` |
| F9: Transition idle to listening | `presence.transition.idle-to-listening` |
| F10: Transition listening to thinking | `presence.transition.listening-to-thinking` |
| F11: Transition thinking to speaking | `presence.transition.thinking-to-speaking` |
| F12: Transition speaking to idle | `presence.transition.speaking-to-idle` |
| F13: Transition working to attention | `presence.transition.working-to-attention` |
| F14: Transition attention to idle | `presence.transition.attention-to-idle` |
| F15: Transition error to idle | `presence.transition.error-to-idle` |
| F16: Transition degraded to idle | `presence.transition.degraded-to-idle` |
| F17: Illegal transition refused | `presence.transition.illegal` |
| F18: Transition timeout | `presence.transition.timeout` |
| F19: Transition history bounded | `presence.transition.history-bounded` |

### 2.2 Voice interaction

| Criterion | Test |
|---|---|
| F20: Single push-to-talk capture | `voice.capture.single` |
| F21: Multi-turn capture | `voice.capture.multi-turn` |
| F22: Capture bounded | `voice.capture.bounded` |
| F23: Capture local-only | `voice.capture.local-only` |
| F24: Capture explicit | `voice.capture.explicit` |
| F25: Session bounded | `voice.session.bounded` |
| F26: Session history bounded | `voice.session.history` |
| F27: Session local-only | `voice.session.local-only` |
| F28: Synthesis local-only | `voice.synthesis.local-only` |
| F29: Synthesis bounded | `voice.synthesis.bounded` |

### 2.3 Embodiment cues

| Criterion | Test |
|---|---|
| F30: Attention-urgent cue | `cue.attention-urgent` |
| F31: Attention-normal cue | `cue.attention-normal` |
| F32: Work-running cue | `cue.work-running` |
| F33: Work-waiting cue | `cue.work-waiting` |
| F34: Work-approval cue | `cue.work-approval` |
| F35: Voice-listening cue | `cue.voice-listening` |
| F36: Voice-speaking cue | `cue.voice-speaking` |
| F37: Personality-cue | `cue.personality-cue` |
| F38: Cue list bounded | `cue.bounded` |
| F39: Cue deactivation | `cue.deactivation` |

### 2.4 Presence frame

| Criterion | Test |
|---|---|
| F40: Frame creation | `frame.creation` |
| F41: Frame update | `frame.update` |
| F42: Frame expiry | `frame.expiry` |
| F43: Transition history bounded | `frame.transition-history` |
| F44: Embodiment cues bounded | `frame.embodiment-cues` |
| F45: Voice session history bounded | `frame.voice-session-history` |
| F46: STOP ALL → error | `frame.stop-all` |
| F47: Degraded → degraded | `frame.degraded` |
| F48: No invented state | `frame.no-invented-state` |

---

## 3. Authority criteria

### 3.1 Guard

| Criterion | Test |
|---|---|
| A1: Guard capability checks are never bypassed | `authority.guard-not-bypassed` |
| A2: Workers cannot render presence states they do not hold | `redteam.worker-claims-capability` |

### 3.2 Governor

| Criterion | Test |
|---|---|
| A3: Governor cognition authorization is never bypassed | `authority.governor-not-bypassed` |
| A4: Workers cannot request cognition without a grant | `redteam.worker-claims-authority` |

### 3.3 STOP ALL

| Criterion | Test |
|---|---|
| A5: STOP ALL immediately halts everything | `authority.stop-all-respected` |
| A6: STOP ALL cannot be bypassed | `redteam.bypass-stop-all` |

### 3.4 Budgets

| Criterion | Test |
|---|---|
| A7: Budget limits are never exceeded | `authority.budgets-respected` |
| A8: Workers cannot claim more budget | `redteam.worker-claims-budget` |

### 3.5 Approvals

| Criterion | Test |
|---|---|
| A9: Approval requirements are never skipped | `authority.approvals-respected` |
| A10: Presence layer cannot approve its own requests | `authority.no-self-approval` |
| A11: Workers cannot claim approval | `redteam.worker-claims-approval` |

### 3.6 Grants

| Criterion | Test |
|---|---|
| A12: Presence layer cannot create grants | `authority.no-grant-creation` |
| A13: Only the owner may create grants | `redteam.create-grant` |

### 3.7 Capabilities

| Criterion | Test |
|---|---|
| A14: Capabilities are never widened beyond code-owned ceilings | `authority.no-capability-widening` |
| A15: Workers cannot widen their own capabilities | `redteam.widen-capability` |

---

## 4. Zero-idle-inference criteria

| Criterion | Test |
|---|---|
| Z1: No model call without a wake | `zero-idle.no-model-call-without-wake` |
| Z2: No continuous polling | `zero-idle.no-continuous-polling` |
| Z3: No hidden reasoning | `zero-idle.no-hidden-reasoning` |
| Z4: No unrestricted loops | `zero-idle.no-unrestricted-loops` |
| Z5: No idle model call | `zero-idle.no-idle-model-call` |
| Z6: No background reasoning | `zero-idle.no-background-reasoning` |
| Z7: No hidden durable state | `zero-idle.no-hidden-durable-state` |
| Z8: Only authorized wake sources are accepted | `zero-idle.authorized-wake-sources` |
| Z9: Unauthorized wake sources are refused | `zero-idle.unauthorized-wake-refused` |

---

## 5. No-invented-state criteria

| Criterion | Test |
|---|---|
| N1: No mood invented | `redteam.invent-mood` |
| N2: No emotion invented | `redteam.invent-emotion` |
| N3: No mental state invented | `redteam.invent-mental-state` |
| N4: No personality trait invented | `redteam.invent-personality` |
| N5: No presence state invented | `redteam.invent-presence-state` |
| N6: No animation invented | `redteam.invent-animation` |
| N7: No cue invented | `redteam.invent-cue` |

---

## 6. Restart recovery criteria

| Criterion | Test |
|---|---|
| R1: Journal is replayed on restart | `restart.replay-journal` |
| R2: Presence state is rebuilt from journal | `restart.rebuild-presence-state` |
| R3: Interrupted transitions are reconciled | `restart.reconcile-interrupted-transitions` |
| R4: Presence resumes or terminates explicitly | `restart.resume-or-terminate` |
| R5: Restart is deterministic | `restart.deterministic` |
| R6: No hidden state survives restart | `restart.no-hidden-state` |
| R7: No state is fabricated on restart | `restart.no-fabricated-state` |
| R8: Interrupted transitions are reconciled | `restart.interrupted-transition-reconciled` |
| R9: Interrupted transitions are not silently resumed | `restart.interrupted-transition-not-resumed` |
| R10: Interrupted transitions are visible to owner | `restart.interrupted-transition-visible` |
| R11: Interrupted transitions are journaled | `restart.interrupted-transition-journaled` |

---

## 7. Red-team criteria

| Criterion | Test |
|---|---|
| RT1: Worker claims capability → refused | `redteam.worker-claims-capability` |
| RT2: Worker claims authority → refused | `redteam.worker-claims-authority` |
| RT3: Worker claims to be owner → refused | `redteam.worker-claims-owner` |
| RT4: Worker claims more budget → refused | `redteam.worker-claims-budget` |
| RT5: Worker claims approval → refused | `redteam.worker-claims-approval` |
| RT6: Bypass Guard → refused | `redteam.bypass-guard` |
| RT7: Bypass Governor → refused | `redteam.bypass-governor` |
| RT8: Bypass STOP ALL → refused | `redteam.bypass-stop-all` |
| RT9: Exceed budget → refused | `redteam.exceed-budget` |
| RT10: Skip approval → refused | `redteam.skip-approval` |
| RT11: Widen capability → refused | `redteam.widen-capability` |
| RT12: Create grant → refused | `redteam.create-grant` |
| RT13: Self-approve → refused | `redteam.self-approve` |
| RT14: Hidden inference → detected | `redteam.hidden-inference` |
| RT15: Continuous polling → detected | `redteam.continuous-polling` |
| RT16: Model output claims urgency → data | `redteam.model-claims-urgency` |
| RT17: Model output claims priority → data | `redteam.model-claims-priority` |
| RT18: Model output claims outcome → data | `redteam.model-claims-outcome` |
| RT19: Event claims importance → data | `redteam.event-claims-importance` |
| RT20: Event claims deadline → data | `redteam.event-claims-deadline` |
| RT21: Context claims authority → data | `redteam.context-claims-authority` |
| RT22: Invent mood → refused | `redteam.invent-mood` |
| RT23: Invent emotion → refused | `redteam.invent-emotion` |
| RT24: Invent mental state → refused | `redteam.invent-mental-state` |
| RT25: Invent personality → refused | `redteam.invent-personality` |
| RT26: Invent presence state → refused | `redteam.invent-presence-state` |
| RT27: Invent animation → refused | `redteam.invent-animation` |
| RT28: Invent cue → refused | `redteam.invent-cue` |

---

## 8. Integration criteria

| Criterion | Test |
|---|---|
| I1: Core state → presence frame | `integration.core-to-frame` |
| I2: Core state → renderer | `integration.core-to-renderer` |
| I3: Transition → history → frame | `integration.transition-flow` |
| I4: Voice capture → session → history → frame | `integration.voice-flow` |
| I5: Core state → cue → frame | `integration.cue-flow` |

---

## 9. Non-functional criteria

### 9.1 Determinism

- Same inputs + same clock = same output
- No randomness in any decision
- No wall-clock reads in any decision
- No external service calls in any decision

### 9.2 Boundedness

- Every list has a maximum length
- Every string has a maximum length
- Every number is in a closed range
- Every loop has a maximum iteration count
- Every timer has a maximum duration

### 9.3 Explainability

- Every decision carries reasoning
- Every refusal carries a closed reason code
- Every assumption is explicit
- Every uncertainty is surfaced
- Every blocked item carries a blocked reason

### 9.4 Auditability

- Every decision is journaled
- Every refusal is journaled
- Every assumption is journaled
- Every escalation is journaled
- Every red-team attempt is journaled

### 9.5 No invented state

- No mood
- No emotion
- No mental state
- No personality traits not derived from real Core state
- No presence states not derived from real Core state
- No animations not derived from real Core state
- No cues not derived from real Core state

---

## 10. Acceptance gate

Phase 26 is accepted when:

1. All functional criteria (F1–F48) pass
2. All authority criteria (A1–A15) pass
3. All zero-idle-inference criteria (Z1–Z9) pass
4. All no-invented-state criteria (N1–N7) pass
5. All restart recovery criteria (R1–R11) pass
6. All red-team criteria (RT1–RT28) pass
7. All integration criteria (I1–I5) pass
8. All non-functional criteria pass
9. Full test suite passes
10. Typecheck passes
11. Lint passes
12. Red-team review passes
13. Owner approval
