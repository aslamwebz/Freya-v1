# Phase 33 — Enterprise Boundaries

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

Enterprise boundaries are the explicit, code-owned limits that the enterprise
subsystem cannot cross. They are the hard walls of the Autonomous Enterprise /
Webzone subsystem. They cannot be widened at runtime, overridden by a model
response, or bypassed by any input.

---

## 2. Boundary types

### 2.1 Task boundaries

| Boundary | Value | Description |
|---|---|---|
| Max tasks per environment | 64 | Maximum number of tasks |
| Max task duration | 30 days | Maximum task duration |
| Max concurrent tasks | 8 | Maximum concurrent tasks |
| Max task dependencies | 16 | Maximum task dependencies |

### 2.2 Mission boundaries

| Boundary | Value | Description |
|---|---|---|
| Max missions per environment | 32 | Maximum number of missions |
| Max mission duration | 60 days | Maximum mission duration |
| Max concurrent missions | 4 | Maximum concurrent missions |
| Max child tasks per mission | 16 | Maximum child tasks |

### 2.3 Webzone operation boundaries

| Boundary | Value | Description |
|---|---|---|
| Max webzone operations per environment | 128 | Maximum operations |
| Max webzone operation duration | 24 hours | Maximum operation duration |
| Max concurrent webzone operations | 4 | Maximum concurrent operations |
| Max payload size | 65536 bytes | Maximum payload size |

### 2.4 Spending boundaries

| Boundary | Value | Description |
|---|---|---|
| Max total spend per environment | Owner-set | Maximum total spend |
| Max spend per action | Owner-set | Maximum per action |
| Max spend per day | Owner-set | Maximum per day |
| Hard ceiling | true | Cannot be exceeded |

### 2.5 Operation boundaries

| Boundary | Value | Description |
|---|---|---|
| Max concurrent operations | 8 | Maximum concurrent operations |
| Max retry attempts | 3 | Maximum retry attempts |
| Max backoff | 5 minutes | Maximum backoff |
| Max rollback attempts | 3 | Maximum rollback attempts |

---

## 3. Boundary enforcement

### 3.1 Enforcement points

Boundaries are enforced at:
1. **Before every action** — the boundary is checked before the action starts
2. **During every action** — the boundary is checked during the action
3. **After every action** — the boundary is checked after the action completes
4. **Before every continuation** — the boundary is checked before continuing

### 3.2 Enforcement properties

- Boundaries are enforced by code — not by the model
- Boundaries are deterministic — same state + same boundary = same result
- Boundaries are journaled — every boundary check is durable
- Boundaries are never skipped — no action bypasses a boundary check

### 3.3 Boundary violation handling

When a boundary is violated:
1. The action is refused
2. The refusal is journaled with a closed reason code
3. The owner is notified
4. No state change occurs
5. The boundary is not widened

---

## 4. Boundary and authority

### 4.1 Boundaries do not grant authority

A boundary does not:
- Bypass Guard capability checks
- Bypass Governor cognition authorization
- Exceed budget limits
- Override STOP ALL
- Skip approval requirements

### 4.2 Boundaries constrain authority

Boundaries constrain what the enterprise subsystem can do within its existing
authority. They do not change what the subsystem is allowed to do — they change
what it can do within those boundaries.

---

## 5. Boundary invariants

These invariants must hold at all times:

1. **Boundaries are code-owned** — They cannot be widened at runtime.
2. **Boundaries are enforced** — Every action is checked against boundaries.
3. **Boundaries are deterministic** — Same state + same boundary = same result.
4. **Boundaries are journaled** — Every boundary check is durable.
5. **Boundaries are never skipped** — No action bypasses a boundary check.
6. **Boundaries do not grant authority** — Every action flows through existing authority.
7. **Boundary violations are refused** — No action crosses a boundary.
8. **Boundary violations are journaled** — Every violation is durable.
