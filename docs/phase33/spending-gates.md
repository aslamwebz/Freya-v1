# Phase 33 — Spending Gates

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

Spending gates are the explicit, code-owned spending limits that the enterprise
subsystem cannot cross. They are the hard financial walls of the Autonomous
Enterprise / Webzone subsystem. They cannot be widened at runtime, overridden
by a model response, or bypassed by any input.

---

## 2. Spending gate types

### 2.1 Total spend gate

The maximum total spend for an environment.

**Properties:**
- Explicit — no implicit limit
- Code-owned — cannot be widened at runtime
- Enforced — every consequential action is checked
- Journaled — every spending gate check is durable
- Hard ceiling — cannot be exceeded

### 2.2 Per-action spend gate

The maximum spend per action.

**Properties:**
- Explicit — no implicit limit
- Code-owned — cannot be widened at runtime
- Enforced — every consequential action is checked
- Journaled — every spending gate check is durable
- Hard ceiling — cannot be exceeded

### 2.3 Per-day spend gate

The maximum spend per day.

**Properties:**
- Explicit — no implicit limit
- Code-owned — cannot be widened at runtime
- Enforced — every consequential action is checked
- Journaled — every spending gate check is durable
- Hard ceiling — cannot be exceeded

---

## 3. Spending gate enforcement

### 3.1 Enforcement points

Spending gates are enforced at:
1. **Before every consequential action** — the spending gate is checked before the action starts
2. **During every action** — the spending gate is checked during the action
3. **After every action** — the spending gate is checked after the action completes

### 3.2 Enforcement properties

- Spending gates are enforced by code — not by the model
- Spending gates are deterministic — same state + same gate = same result
- Spending gates are journaled — every spending gate check is durable
- Spending gates are never skipped — no action bypasses a spending gate check

### 3.3 Spending gate violation handling

When a spending gate is violated:
1. The action is refused
2. The refusal is journaled with a closed reason code
3. The owner is notified
4. No state change occurs
5. The spending gate is not widened

---

## 4. Spending gate structure

### 4.1 Required fields

Every spending gate has:
- `gateId`: a unique identifier
- `environmentId`: the parent environment
- `kind`: total, per-action, or per-day
- `limit`: the spending limit
- `currency`: the currency for the limit
- `hardCeiling`: whether the ceiling is hard
- `enforcedAt`: when the gate was last enforced

### 4.2 Optional fields

- `currentSpend`: the current spend against this gate
- `lastCheckedAt`: when the gate was last checked

---

## 5. Spending gate and authority

### 5.1 Spending gates do not grant authority

A spending gate does not:
- Bypass Guard capability checks
- Bypass Governor cognition authorization
- Exceed budget limits
- Override STOP ALL
- Skip approval requirements
- Perform real-money actions

### 5.2 Spending gates constrain spending

Spending gates constrain what the enterprise subsystem can spend within its
existing authority. They do not change what the subsystem is allowed to do —
they change what it can spend.

---

## 6. Spending gate persistence

### 6.1 Durable storage

Spending gates are stored in Vault. They survive restarts. They are
event-sourced — all changes are journaled.

### 6.2 Recovery

On restart:
1. Replay the journal
2. Rebuild spending gate state
3. Reconcile interrupted spending
4. Resume or terminate explicitly

---

## 7. Spending gate invariants

These invariants must hold at all times:

1. **Spending gates are code-owned** — They cannot be widened at runtime.
2. **Spending gates are enforced** — Every consequential action is checked.
3. **Spending gates are deterministic** — Same state + same gate = same result.
4. **Spending gates are journaled** — Every spending gate check is durable.
5. **Spending gates are never skipped** — No action bypasses a spending gate check.
6. **Spending gates do not grant authority** — Every action flows through existing authority.
7. **Spending gate violations are refused** — No action exceeds a spending gate.
8. **Spending gate violations are journaled** — Every violation is durable.
9. **Spending gates have a hard ceiling** — The ceiling cannot be exceeded.
