# Phase 32 — Paper Trading Specification

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

The Paper Trading Engine is the subsystem that enables Freya to conduct
simulated trading experiments with zero real capital. It places simulated
orders (no real orders), tracks a paper portfolio, and computes performance
metrics with explicit denominators. It is bounded, deterministic and
explainable.

---

## 2. Paper trading process

### 2.1 Steps

1. **Define** — define the paper trading experiment and scope
2. **Place** — place simulated orders (no real orders)
3. **Track** — track the paper portfolio
4. **Measure** — compute performance metrics
5. **Report** — produce a bounded, explainable paper trading report

### 2.2 Constraints

- Paper trading never places real orders
- Paper trading never performs real-money actions
- Paper trading never fabricates certainty
- Paper trading always surfaces uncertainty
- Paper trading never exceeds authority
- Paper trading always respects STOP ALL

---

## 3. Paper orders

### 3.1 Definition

A paper order is a simulated order. It is NOT a real order. Each paper order
has:
- A unique identifier
- An experiment reference
- A symbol (bounded string)
- A side (buy or sell)
- A quantity (positive number)
- A price (positive number)
- A placement timestamp
- A status (filled, pending, cancelled)

### 3.2 Properties

- Paper orders are simulated — no real order is placed
- Paper orders are bounded — at most 256 orders per experiment
- Paper orders are deterministic — same inputs + same clock = same result
- Paper orders are explainable — every order carries its reasoning
- Paper orders are journaled — every order is durable

### 3.3 Order limits

| Limit | Value |
|---|---|
| Max orders per experiment | 256 |
| Max paper trading duration | 30 days |
| Max symbol length | 16 |
| Max quantity | 1,000,000 |
| Max price | 1,000,000 |

---

## 4. Paper portfolio

### 4.1 Definition

A paper portfolio is a collection of paper positions. Each position has:
- A unique identifier
- An experiment reference
- A symbol
- A quantity
- An average price
- A current price
- An unrealized P&L

### 4.2 Properties

- Paper portfolios are simulated — no real portfolio exists
- Paper portfolios are bounded — at most 64 positions per experiment
- Paper portfolios are deterministic — same inputs + same clock = same result
- Paper portfolios are explainable — every position carries its reasoning
- Paper portfolios are journaled — every change is durable

---

## 5. Performance metrics

### 5.1 Definition

A performance metric is a computed value with an explicit denominator. Each
metric has:
- A unique identifier
- An experiment reference
- A name
- A value
- A denominator (explicit, never implicit)
- A unit
- A computation timestamp

### 5.2 Properties

- Metrics have explicit denominators — no metric is reported without one
- Metrics are bounded — at most 64 metrics per experiment
- Metrics are deterministic — same inputs + same clock = same result
- Metrics are explainable — every metric carries its reasoning
- Metrics are journaled — every metric is durable

### 5.3 Metric constraints

- Every metric has a denominator — no metric is reported without one
- Every metric has a unit — no metric is reported without one
- Every metric is bounded — values are in a closed range
- Every metric is honest — uncertainty is never hidden

---

## 6. Paper trading and authority

### 6.1 Paper trading does not grant authority

Paper trading does not:
- Bypass Guard capability checks
- Bypass Governor cognition authorization
- Exceed budget limits
- Override STOP ALL
- Skip approval requirements
- Perform real-money actions
- Place real orders

### 6.2 Paper trading influences planning only

Paper trading determines what the economic subsystem has learned. It does not
change what the subsystem is allowed to do.

---

## 7. Paper trading persistence

### 7.1 Durable storage

Paper trading data is stored in Vault. It survives restarts. It is event-sourced —
all changes are journaled.

### 7.2 Recovery

On restart:
1. Replay the journal
2. Rebuild paper trading state
3. Reconcile interrupted paper trading
4. Resume or terminate explicitly

---

## 8. Paper trading invariants

These invariants must hold at all times:

1. **Paper trading is simulated** — No real order is placed.
2. **Paper trading is bounded** — Every experiment has a duration limit.
3. **Paper trading is deterministic** — Same inputs + same clock = same result.
4. **Paper trading is explainable** — Every order carries its reasoning.
5. **Paper trading is honest** — Uncertainty is never hidden.
6. **Paper trading does not grant authority** — Every action flows through existing authority.
7. **Paper trading performs no real-money actions** — No real-money action is performed.
8. **Metrics have denominators** — Every metric has an explicit denominator.
