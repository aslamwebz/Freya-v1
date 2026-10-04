# Phase 34 — Conflict Handling

**Status:** PREPARATION ONLY — NOT PRODUCTION

---

## 1. Overview

Conflicts arise when two devices make concurrent changes to the same data.
Conflicts are resolved deterministically using vector clocks and
last-writer-wins (LWW) with explicit conflict records.

---

## 2. Conflict detection

A conflict is detected when:
1. Two changes target the same path.
2. The changes are concurrent (neither vector clock dominates).
3. The changes have different values.

---

## 3. Conflict resolution

### 3.1 Last-writer-wins (LWW)

The default resolution is LWW:
- The change with the later timestamp wins.
- If timestamps are equal, the change from the device with the lexicographically larger device ID wins.

### 3.2 Path-specific policies

Specific paths can have custom resolution policies:
- `local-wins`: The local change always wins.
- `remote-wins`: The remote change always wins.
- `merge`: The changes are merged (if possible).

### 3.3 Merge

If the changes can be merged (e.g., both are object merges), the merged
value is used. If the changes cannot be merged, LWW is used as a fallback.

---

## 4. Conflict records

Every conflict is recorded with:
- The path.
- The local change.
- The remote change.
- The resolution (`local`, `remote`, or `merged`).
- The resolved value.
- The timestamp.
- The resolving device.

---

## 5. Deterministic resolution

Conflict resolution is deterministic:
- Same state + same clock = same resolution.
- The resolution does not depend on the order in which changes are received.
- The resolution does not depend on which device is the "local" device.

---

## 6. Conflict examples

### 6.1 Concurrent edits to the same field

```
Device A: path="user.name", value="Alice", timestamp=100
Device B: path="user.name", value="Bob", timestamp=100

Resolution: LWW, tiebreak by device ID
Result: "Bob" (if Device B's ID > Device A's ID)
```

### 6.2 Concurrent edits to different fields

```
Device A: path="user.name", value="Alice", timestamp=100
Device B: path="user.email", value="bob@example.com", timestamp=100

Resolution: No conflict (different paths)
Result: Both changes applied
```

### 6.3 Concurrent edits with merge policy

```
Device A: path="user.preferences", value={ theme: "dark" }, timestamp=100
Device B: path="user.preferences", value={ fontSize: 14 }, timestamp=100

Resolution: Merge
Result: { theme: "dark", fontSize: 14 }
```
