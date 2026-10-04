# Phase 34 — Bounded Remote Commands

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

Devices can issue bounded, capability-checked remote commands. Remote
commands never bypass Guard, Governor, STOP ALL, approvals, or budgets.

---

## 2. Command types

### 2.1 Ping

A simple ping to check if the target device is online.

### 2.2 Get status

Get the target device's status (online/offline, trust level, last seen).

### 2.3 Get presence

Get the target device's presence information.

### 2.4 Request sync

Request a sync from the target device.

### 2.5 Stop all

Issue a STOP ALL command to the target device. This requires owner
approval and is subject to the same STOP ALL semantics as local commands.

### 2.6 Custom

A custom command with a bounded payload. Custom commands are capability-
checked and audited.

---

## 3. Command lifecycle

### 3.1 Issuance

A device issues a remote command by sending a command request to the Core.
The command request includes:
- The command ID.
- The command kind.
- The source device ID.
- The target device ID.
- The command payload.
- A timestamp.
- A nonce.
- The required capabilities.

### 3.2 Authorization

The Core authorizes the command by:
1. Verifying the source device's signature.
2. Checking the source device's trust level.
3. Evaluating the source device's capabilities against the command's
   required capabilities.
4. Checking the target device's trust level.

### 3.3 Execution

If the command is authorized, the Core executes the command on the target
device. The execution is bounded and audited.

### 3.4 Result

The Core returns the command result to the source device. The result
includes:
- The command ID.
- Success/failure.
- The result payload.
- An error message (if any).
- The execution timestamp.
- The executing device ID.

---

## 4. Command bounds

### 4.1 Capability bounds

Each command specifies the required capabilities. The source device must
hold all required capabilities to issue the command.

### 4.2 Trust level bounds

The source device's trust level determines which commands it can issue:
- `owner`: Can issue all commands.
- `trusted`: Can issue all commands except `stop-all`.
- `limited`: Cannot issue commands.
- `untrusted`: Cannot issue commands.

### 4.3 Target trust level bounds

The target device's trust level determines which commands it can receive:
- `owner`: Can receive all commands.
- `trusted`: Can receive all commands except `stop-all`.
- `limited`: Cannot receive commands.
- `untrusted`: Cannot receive commands.

### 4.4 STOP ALL bounds

The `stop-all` command requires:
1. Owner approval.
2. The source device must be the owner device.
3. The target device must be the owner device or a trusted device.

---

## 5. Command security

### 5.1 Authentication

Command requests are authenticated with the source device's key. The
Core verifies the signature before processing the command.

### 5.2 Authorization

Command requests are authorized by the Guard. The Guard evaluates the
source device's capabilities against the command's required capabilities.

### 5.3 Auditability

All commands are journaled in the audit log. The audit log is
tamper-evident and can be verified.

### 5.4 Replay protection

Command requests include a nonce and timestamp. Replayed commands are
detected and rejected.

---

## 6. Command denial

A command is denied if:
1. The source device's signature is invalid.
2. The source device's trust level is insufficient.
3. The source device does not hold the required capabilities.
4. The target device's trust level is insufficient.
5. The command is a replay.
6. The command requires STOP ALL and the source device is not the owner.

Denied commands are journaled in the audit log.
