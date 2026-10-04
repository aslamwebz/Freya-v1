# Phase 34 — Enrollment and Pairing Protocol

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

New devices are enrolled via an explicit, owner-approved pairing flow. The
pairing flow uses challenge-response verification to prevent eavesdropping
and replay.

---

## 2. Pairing flow

### Step 1: Pairing request

The new device generates a pairing request containing:
- Device identity (ID, public key, display name, platform).
- Timestamp.
- Nonce (random, 32 bytes).

The pairing request is sent to the owner device.

### Step 2: Challenge

The owner device generates a challenge containing:
- A random nonce (32 bytes).
- The owner device's ID.
- A timestamp.

The challenge is sent to the new device.

### Step 3: Response

The new device signs the challenge with its private key and sends back:
- The signed challenge.
- The original pairing request.

### Step 4: Owner approval

The owner device verifies the signature and presents the pairing request
to the owner for explicit approval. The owner must approve the pairing
via an explicit action (e.g., clicking "Approve").

### Step 5: Enrollment

If the owner approves, the owner device:
1. Creates an enrollment record.
2. Issues an enrollment token.
3. Sets the device's initial trust level to `limited`.
4. Journals the enrollment in the audit log.
5. Sends the enrollment token to the new device.

### Step 6: Confirmation

The new device:
1. Stores the enrollment token.
2. Completes the pairing flow.
3. Begins syncing at the `limited` trust level.

---

## 3. Pairing security

### 3.1 Challenge-response

The challenge-response protocol prevents eavesdropping and replay:
- The challenge nonce is random and single-use.
- The response is signed with the new device's private key.
- The owner device verifies the signature before approving.

### 3.2 Owner approval

Owner approval is explicit and cannot be bypassed. The owner must
approve the pairing via an explicit action.

### 3.3 Initial trust level

New devices are always enrolled at the `limited` trust level. They
cannot be enrolled at a higher trust level.

### 3.4 Enrollment token

The enrollment token is a one-time token that expires after a bounded
timeout. It cannot be reused.

---

## 4. Pairing rejection

The owner can reject a pairing request. Rejection:
1. Is journaled in the audit log.
2. Does not create an enrollment record.
3. Does not issue an enrollment token.

---

## 5. Pairing timeout

If the owner does not approve or reject a pairing request within a
bounded timeout, the pairing request expires. The new device must
initiate a new pairing flow.

---

## 6. Re-enrollment

A revoked device can be re-enrolled via a new pairing flow. The new
enrollment creates a new device record with a new device ID. The old
device record is retained in the audit log.
