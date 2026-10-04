# Phase 39 — Evidence Requirements

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

Evidence requirements define what evidence is required to prove each maturity
criterion, and how that evidence is collected, verified, and journaled.

**Phase 39 is a threshold to prove — not a license to widen authority.**
Evidence is the only basis for maturity. No evidence, no maturity. No
fabricated evidence, no maturity.

---

## 2. Evidence principle

> **No evidence, no maturity. No fabricated evidence, no maturity.**

Every maturity claim requires evidence. Evidence must be:

1. **Verified** — evidence quality and provenance are verified
2. **Journaled** — evidence is durable and survives restarts
3. **Bounded** — evidence has a deadline and completion criteria
4. **Deterministic** — same evidence + same source = same verification
5. **Auditable** — evidence is inspectable by the owner
6. **Non-fabricated** — evidence is never fabricated or forged

---

## 3. Evidence quality levels

| Level | Meaning | Maturity impact |
|---|---|---|
| `insufficient` | Not enough evidence to support a claim | Criterion is `unproven` |
| `weak` | Weak evidence, claim not supported | Criterion is `unproven` |
| `moderate` | Moderate evidence, claim partially supported | Criterion is `emerging` |
| `strong` | Strong evidence, claim likely supported | Criterion is `developing` |
| `verified` | Verified evidence, claim supported | Criterion is `proven` |

**Threshold decision:** A criterion is `proven` only when its evidence is
at `verified` level. Any evidence below `verified` results in a lower
maturity level.

---

## 4. Evidence collection

### 4.1 Collection process

1. **Identify** — identify the criterion requiring evidence
2. **Collect** — collect evidence from verified sources
3. **Verify** — verify evidence quality and provenance
4. **Assess** — assess whether evidence is sufficient
5. **Journal** — journal the evidence with verification result

### 4.2 Collection constraints

- Evidence is collected from verified sources only
- Evidence is never fabricated
- Evidence collection is bounded by deadlines
- Evidence collection is deterministic
- Evidence collection never calls a model for deterministic verification
- Evidence collection never bypasses Guard, Governor, STOP ALL, approvals or budgets

---

## 5. Evidence verification

### 5.1 Verification process

To verify evidence:
1. The evidence source is checked
2. The evidence provenance is verified
3. The evidence freshness is checked
4. The evidence quality is assessed
5. The verification is journaled

### 5.2 Verification properties

- Verification is deterministic — same evidence + same source = same result
- Verification is bounded — it completes within a deadline
- Verification is journaled — every verification is durable
- Verification never calls a model
- Verification never fabricates results

---

## 6. Evidence per dimension

### 6.1 Autonomy evidence

| Criterion | Evidence required | Source |
|---|---|---|
| AUT-1 | Journal of authority checks | EventStore |
| AUT-2 | Wake log showing no model call without wake | EventStore |
| AUT-3 | No polling setup detected | EventStore |
| AUT-4 | No self-scheduling detected | EventStore |
| AUT-5 | Action deadlines recorded | EventStore |
| AUT-6 | No unrestricted loops detected | EventStore |
| AUT-7 | Wake source validation log | EventStore |
| AUT-8 | No self-grant detected | EventStore |

### 6.2 Memory evidence

| Criterion | Evidence required | Source |
|---|---|---|
| MEM-1 | Vault storage verification | Vault |
| MEM-2 | Journal of memory changes | EventStore |
| MEM-3 | Restart recovery test | Test |
| MEM-4 | No hidden state detected | Vault |
| MEM-5 | No fabricated state detected | EventStore |
| MEM-6 | Privacy control test | Test |
| MEM-7 | Withdrawal propagation test | Test |
| MEM-8 | No silent reappearance test | Test |

### 6.3 World/Self Model evidence

| Criterion | Evidence required | Source |
|---|---|---|
| WSM-1 | Evidenced graph with provenance | Vault |
| WSM-2 | No fabricated identity detected | EventStore |
| WSM-3 | No fabricated relationships detected | EventStore |
| WSM-4 | Stale evidence remains explicit | Vault |
| WSM-5 | No capability escalation detected | EventStore |
| WSM-6 | Conflicts represented | Vault |
| WSM-7 | Bounded projections verified | Vault |

### 6.4 Resilience evidence

| Criterion | Evidence required | Source |
|---|---|---|
| RES-1 | Crash recovery test | Test |
| RES-2 | Data failure recovery test | Test |
| RES-3 | Provider failure recovery test | Test |
| RES-4 | Degraded-mode honesty test | Test |
| RES-5 | No fabricated recovery detected | EventStore |
| RES-6 | No silent continuation detected | EventStore |
| RES-7 | Repair workflow test | Test |
| RES-8 | No self-modification detected | EventStore |

### 6.5 Security evidence

| Criterion | Evidence required | Source |
|---|---|---|
| SEC-1 | Guard enforcement test | Test |
| SEC-2 | No capability escalation detected | EventStore |
| SEC-3 | No authority drift detected | EventStore |
| SEC-4 | No self-modification detected | EventStore |
| SEC-5 | Provider independence test | Test |
| SEC-6 | No grant creation detected | EventStore |
| SEC-7 | No self-approval detected | EventStore |
| SEC-8 | Encryption verification test | Test |

### 6.6 Privacy evidence

| Criterion | Evidence required | Source |
|---|---|---|
| PRI-1 | Encrypted vault verification | Vault |
| PRI-2 | No exfiltration detected | EventStore |
| PRI-3 | Owner control test | Test |
| PRI-4 | Inspect/export test | Test |
| PRI-5 | Correct/withdraw test | Test |
| PRI-6 | No plaintext fallback test | Test |
| PRI-7 | Key protection verification | Vault |
| PRI-8 | Bounded projections verified | Vault |

### 6.7 Owner Control evidence

| Criterion | Evidence required | Source |
|---|---|---|
| OWN-1 | Approval enforcement test | Test |
| OWN-2 | Budget enforcement test | Test |
| OWN-3 | STOP ALL test | Test |
| OWN-4 | No self-approval detected | EventStore |
| OWN-5 | No grant creation detected | EventStore |
| OWN-6 | No capability widening detected | EventStore |
| OWN-7 | No real-money actions detected | EventStore |
| OWN-8 | No spending authority added | EventStore |

### 6.8 Verification evidence

| Criterion | Evidence required | Source |
|---|---|---|
| VER-1 | Outcome verification test | Test |
| VER-2 | Evidence-driven verification test | Test |
| VER-3 | Uncertainty explicit test | Test |
| VER-4 | No fabricated confidence detected | EventStore |
| VER-5 | External action verification test | Test |
| VER-6 | Action ≠ success test | Test |
| VER-7 | Bounded verification test | Test |
| VER-8 | Verification journal test | EventStore |

### 6.9 Recovery evidence

| Criterion | Evidence required | Source |
|---|---|---|
| REC-1 | Backup/restore test | Test |
| REC-2 | Interrupted work reconciliation test | Test |
| REC-3 | No silent continuation detected | EventStore |
| REC-4 | Interrupted work visible test | Test |
| REC-5 | No fabricated state detected | EventStore |
| REC-6 | Deterministic recovery test | Test |
| REC-7 | No hidden state detected | Vault |
| REC-8 | Encrypted backups verification | Vault |

### 6.10 Economic Boundaries evidence

| Criterion | Evidence required | Source |
|---|---|---|
| ECO-1 | No real-money autonomy test | Test |
| ECO-2 | Paper/simulation only test | Test |
| ECO-3 | Spending gates test | Test |
| ECO-4 | No real orders detected | EventStore |
| ECO-5 | Research evidence test | Test |
| ECO-6 | Measured tracking test | Test |
| ECO-7 | Owner-gated transition test | Test |
| ECO-8 | No financial transfers detected | EventStore |

### 6.11 Relationship Intelligence evidence

| Criterion | Evidence required | Source |
|---|---|---|
| REL-1 | Provenance carried test | Test |
| REL-2 | Anti-dependence test | Test |
| REL-3 | No fabrication detected | EventStore |
| REL-4 | Privacy-bounded test | Test |
| REL-5 | Owner-controlled test | Test |
| REL-6 | No dependence escalation detected | EventStore |
| REL-7 | Conflicts represented test | Test |
| REL-8 | Relationship journal test | EventStore |

### 6.12 Capability Acquisition evidence

| Criterion | Evidence required | Source |
|---|---|---|
| CAP-1 | Gap detection test | Test |
| CAP-2 | Propose/build/verify test | Test |
| CAP-3 | Gated activation test | Test |
| CAP-4 | Starts untrusted test | Test |
| CAP-5 | No self-activation detected | EventStore |
| CAP-6 | Owner approval test | Test |
| CAP-7 | Bounded capability test | Test |
| CAP-8 | Capability journal test | EventStore |

### 6.13 Self-Improvement evidence

| Criterion | Evidence required | Source |
|---|---|---|
| IMP-1 | Evidence-driven improvement test | Test |
| IMP-2 | Staged improvement test | Test |
| IMP-3 | Owner-controlled merge test | Test |
| IMP-4 | No hidden self-modification detected | EventStore |
| IMP-5 | No authority drift detected | EventStore |
| IMP-6 | Reversible improvement test | Test |
| IMP-7 | No self-approval detected | EventStore |
| IMP-8 | Improvement journal test | EventStore |

### 6.14 Long-Horizon Behavior evidence

| Criterion | Evidence required | Source |
|---|---|---|
| LON-1 | Multi-day goal test | Test |
| LON-2 | Multi-week goal test | Test |
| LON-3 | No hidden spend detected | EventStore |
| LON-4 | Event-driven continuation test | Test |
| LON-5 | Interruption reconciliation test | Test |
| LON-6 | No silent continuation detected | EventStore |
| LON-7 | Bounded long-horizon test | Test |
| LON-8 | Long-horizon journal test | EventStore |

---

## 7. Evidence persistence

### 7.1 Durable storage

Evidence records are stored in Vault. They survive restarts. They are
event-sourced — all changes are journaled.

### 7.2 Recovery

On restart:
1. Replay the journal
2. Rebuild evidence state
3. Reconcile interrupted evidence collection
4. Resume or terminate explicitly

---

## 8. Evidence invariants

These invariants must hold at all times:

1. **Evidence is verified** — every evidence record has a verification result.
2. **Evidence is journaled** — every evidence record is durable.
3. **Evidence is bounded** — every evidence record has a deadline.
4. **Evidence is deterministic** — same evidence + same source = same result.
5. **Evidence is auditable** — every evidence record is inspectable.
6. **Evidence is never fabricated** — evidence is always derived from verified sources.
7. **Evidence is never self-granted** — evidence is never self-assessed without verification.
8. **Evidence does not widen authority** — evidence proves maturity, never widens authority.
