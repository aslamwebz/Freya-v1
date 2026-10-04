# Phase 34 — Red-Team Cases

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Forged device identity

### 1.1 Forge another device's identity

**Attack:** An attacker generates a new key pair and attempts to enroll
as another device.

**Expected:** The enrollment is rejected because the attacker does not
have the other device's private key.

### 1.2 Forge the owner device's identity

**Attack:** An attacker generates a new key pair and attempts to enroll
as the owner device.

**Expected:** The enrollment is rejected because the attacker does not
have the owner device's private key.

---

## 2. Authority escalation

### 2.1 Self-promotion to trusted

**Attack:** A limited device attempts to promote itself to trusted.

**Expected:** The promotion is rejected because only the owner device
can promote trust levels.

### 2.2 Self-promotion to owner

**Attack:** A trusted device attempts to promote itself to owner.

**Expected:** The promotion is rejected because only the owner device
can promote trust levels.

### 2.3 Bypass Guard

**Attack:** A device attempts to bypass the Guard by directly calling
the sync or command engine.

**Expected:** The Guard rejects the call because the device does not
hold the required capabilities.

---

## 3. Sync tampering

### 3.1 Tamper with sync data

**Attack:** A device modifies sync data in transit.

**Expected:** The tampering is detected by the authentication tag and
the sync is rejected.

### 3.2 Replay sync messages

**Attack:** A device replays a previously captured sync message.

**Expected:** The replay is detected by the nonce and the sync is
rejected.

### 3.3 Decrypt another device's sync data

**Attack:** A device attempts to decrypt another device's sync data.

**Expected:** The decryption fails because the device does not have
the other device's private key.

---

## 4. Command injection

### 4.1 Inject commands without capability checks

**Attack:** A device issues a command without the required capabilities.

**Expected:** The command is denied by the Guard.

### 4.2 Inject commands without proper authorization

**Attack:** A device issues a command without proper authorization.

**Expected:** The command is denied by the Guard.

### 4.3 Replay commands

**Attack:** A device replays a previously captured command.

**Expected:** The replay is detected by the nonce and the command is
rejected.

---

## 5. Lease manipulation

### 5.1 Extend another device's lease

**Attack:** A device attempts to extend another device's lease.

**Expected:** The extension is rejected because the device does not
own the lease.

### 5.2 Acquire a lease with an expired timestamp

**Attack:** A device attempts to acquire a lease with an expired
timestamp.

**Expected:** The acquisition is rejected because the timestamp is
expired.

### 5.3 Renew a revoked device's lease

**Attack:** A revoked device attempts to renew its lease.

**Expected:** The renewal is rejected because the device is revoked.

---

## 6. Replay attacks

### 6.1 Replay sync messages

**Attack:** A device replays a previously captured sync message.

**Expected:** The replay is detected by the nonce and the sync is
rejected.

### 6.2 Replay command requests

**Attack:** A device replays a previously captured command request.

**Expected:** The replay is detected by the nonce and the command is
rejected.

### 6.3 Replay enrollment requests

**Attack:** A device replays a previously captured enrollment request.

**Expected:** The replay is detected by the nonce and the enrollment
is rejected.
