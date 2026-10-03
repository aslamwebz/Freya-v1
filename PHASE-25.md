# Phase 25 — Digital Senses & Hands II

**Status:** PREPARATION ONLY — NOT PRODUCTION
**Branch:** `prep/phase24-executive` (continuation)
**Blocked on:** Owner alpha gate (PLAN.md Step G)
**Required outcome:** tested browser/terminal/clipboard/download/upload capability expansion only

---

## 1. What this document is

This is a **preparation specification** for Phase 25. It defines the architecture,
interfaces, test plans, red-team cases and acceptance criteria for Digital Senses
& Hands II. It does **not** implement production runtime behavior.

**Phase 25 cannot start until Phase 24 is complete and the owner explicitly
approves the Electron alpha** after Vault + Phase21 + Phase22 + final Phase20 +
real UI/Core wiring (PLAN.md Step G). This branch exists so that when the gate
passes, implementation can begin immediately without re-deriving the design.

---

## 2. The core invariant

> **Hands are bounded tools, not unrestricted computer control. Capability
> expansion does not widen authority.**

Phase 25 expands the set of tested, bounded capabilities available to Freya.
It does **not** widen the authority boundaries established by Guard, Governor,
STOP ALL, approvals and budgets. Every new capability flows through the same
authority paths as every existing capability.

---

## 3. Scope

Phase 25 delivers:

1. **Clipboard capability** — read/write clipboard through a bounded, tested
   capability (currently deferred)
2. **Download capability** — bounded file download through a managed browser
   or direct HTTP
3. **Upload capability** — bounded file upload through a managed browser or
   direct HTTP
4. **Browser capability expansion** — additional tested, bounded browser
   actions (form fill, element click, page scroll, content extraction)
5. **Terminal capability expansion** — additional tested, bounded terminal
   actions (command execution with output capture)
6. **Capability testing framework** — deterministic, repeatable tests for
   every capability action
7. **No new authority** — every capability flows through Guard, Governor,
   STOP ALL, approvals and budgets

---

## 4. What Phase 25 explicitly does NOT do

- Does NOT add unrestricted screenshots or global screen capture
- Does NOT add unrestricted mouse/keyboard computer control
- Does NOT add unrestricted app control
- Does NOT add unrestricted filesystem/editor authority
- Does NOT add any new authority
- Does NOT bypass Guard, Governor, STOP ALL, approvals or budgets
- Does NOT change PLAN.md
- Does NOT merge to main
- Does NOT bypass the alpha gate
- Does NOT add cloud-based capabilities
- Does NOT add capabilities that require a model call to execute

---

## 5. Architecture overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                    DIGITAL SENSES & HANDS II                        │
│                                                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐     │
│  │  CAPABILITY  │  │   CAPABILITY │  │   CAPABILITY         │     │
│  │  REGISTRY    │  │   TESTING    │  │   EXECUTION          │     │
│  │              │  │              │  │                      │     │
│  │ browser      │  │ deterministic│  │ Action → Observation │     │
│  │ terminal     │  │ repeatable   │  │ → Verification       │     │
│  │ clipboard    │  │ no wall-clock│  │                      │     │
│  │ download     │  │ no external  │  │ bounded timeout      │     │
│  │ upload       │  │ services     │  │ bounded input        │     │
│  └──────┬───────┘  └──────┬───────┘  └──────────┬───────────┘     │
│         │                 │                      │                  │
│         └────────┬────────┘                      │                  │
│                  │                              │                  │
│         ┌────────┴──────────────────────────────┴────────┐        │
│         │           EXISTING AUTHORITY BOUNDARIES        │        │
│         │  Guard │ Governor │ STOP ALL │ Approvals │ Budgets      │
│         └─────────────────────────────────────────────────────────┘  │
│                                                                      │
│  NO new authority. NO hidden inference. NO autonomous spend.         │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 6. Component details

### 6.1 Capability Registry

- Maintains the closed set of capability kinds
- Each capability kind has a set of supported actions
- Each action has a set of supported input fields
- Each action has a bounded timeout
- Each action has a bounded input size

### 6.2 Capability Testing Framework

- Deterministic tests for every capability action
- No wall-clock dependency
- No external service dependency
- No model call dependency
- Repeatable and auditable

### 6.3 Capability Execution

- Action → Observation → Verification lifecycle
- Bounded timeout for every action
- Bounded input for every action
- Exact-key validation for every action envelope
- Refusal codes for every failure mode

---

## 7. Authority preservation

Every capability action flows through:
1. Guard capability check
2. Governor cognition authorization (if cognition is needed)
3. STOP ALL latch check
4. Budget remaining check
5. Approval requirement check

No component can bypass any of these.

---

## 8. Test plan summary

See `docs/phase25/test-plan.md` for the full test plan.

Key test categories:
1. Unit tests — capability registry, validation, lifecycle
2. Integration tests — full capability execution flow
3. Red-team tests — authority escalation attempts
4. Zero-idle-inference tests — no model call without wake
5. Capability-specific tests — browser, terminal, clipboard, download, upload

---

## 9. Acceptance criteria summary

See `docs/phase25/acceptance-criteria.md` for full acceptance criteria.

Key criteria:
1. No continuous polling or hidden reasoning
2. Every wake is from an authorized source
3. Every cognition is gated by Governor
4. Every action is bounded and verifiable
5. STOP ALL immediately halts everything
6. Restart recovery is deterministic
7. Zero idle inference is proven
8. No authority escalation from any input
9. Every capability action is tested
10. No unrestricted computer control

---

## 10. Document index

| Document | Purpose |
|---|---|
| `docs/phase25/architecture.md` | Architecture specification |
| `docs/phase25/interfaces.md` | Compile-time types/interfaces |
| `docs/phase25/capability-registry.md` | Capability registry specification |
| `docs/phase25/browser-capability.md` | Browser capability expansion |
| `docs/phase25/terminal-capability.md` | Terminal capability expansion |
| `docs/phase25/clipboard-capability.md` | Clipboard capability |
| `docs/phase25/download-upload-capability.md` | Download/upload capability |
| `docs/phase25/test-plan.md` | Test plan |
| `docs/phase25/red-team-cases.md` | Red-team cases |
| `docs/phase25/acceptance-criteria.md` | Acceptance criteria |
| `docs/phase25/dependency-map.md` | Dependency map |

---

## 11. NOT PRODUCTION — blocked on owner alpha gate

This entire branch is **preparation only**. No production runtime behavior is
implemented. No code in this branch activates runtime behavior. The branch
contains only documentation, specifications, interfaces and test plans.

**Phase 25 implementation begins only when:**
1. Phase 24 is complete
2. The owner explicitly approves the Electron alpha
3. Vault + Phase21 + Phase22 + final Phase20 + real UI/Core wiring are complete
4. The owner's manual test passes
5. PLAN.md Step G is satisfied

Until then, this branch is **blocked** and must not be merged to main.
