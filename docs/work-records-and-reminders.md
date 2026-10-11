# Core record controls and durable reminders

Mission and Goal controls use Core as the source of truth. The window reads metadata for the list and requests private content only when the owner opens one record. Drafts can be edited; drafts and settled records can be deleted. Running records must be cancelled or finished first. Deletion removes encrypted content and journals a metadata tombstone, so replay does not restore the deleted record. Content edits journal only an ID. Store/journal failures refuse success and restore the prior content where possible.

The window exposes creation, explicit read, draft editing, activation, pause/resume, cancellation, verification, and confirmed deletion through `coreSubmit`. Verification requests ask the existing verifier rather than setting completion directly.

## Core integration interfaces

- `MissionEngine.update(missionId, { title, intent, successCriteria? })`, `MissionEngine.delete(missionId)`.
- `GoalEngine.updateGoal(goalId, { title, description, completionCriteria? })`, `GoalEngine.deleteGoal(goalId)`.
- Commands: `mission.read/update/delete` and `goal.read/update/delete`. Read uses existing `detail(id)`; the command result carries `mission.detail` or `goal.detail` only for that explicit read. Updates/deletes retain the domain manage capability checks.
- `createWorkManagementTools({ dispatch })` returns `mission_manage`, `goal_manage`, and `reminder_manage`. `dispatch(command, payload)` must use the guarded Core command path. The tools allow only named actions and fields, never grants, budgets, principals, or arbitrary commands.

## Reminder scheduling

`EncryptedAttentionScheduleStore.open({ path, key })` requires its own 32-byte key and stores private reminder bodies with AES-GCM authentication. Core injects it as `AttentionEngineOptions.scheduleStore` and closes it on shutdown. Schedule IDs/times/conditions remain in the ordinary journal; private reminder text does not enter the journal or broad projection.

If opening storage fails, inject `new UnavailableAttentionScheduleStore(reason)` rather than omit the store. Reconciliation and ticks preserve pending schedule metadata when encrypted content cannot be read. `projection.schedulePersistence` reports the fault. An absent store retains the older ephemeral-schedule recovery behavior.

The reminder tool registers an Attention schedule and requires the command result's confirmed `attention.scheduleId`. A daily reminder uses `intervalMs: 86400000` and `maxRepeats: null`, repeating until cancelled. Numeric repeat limits retain the existing ceiling. Indefinite repetition requires durable storage. Concurrent host ticks are serialized, and missed occurrences advance to the next future interval rather than producing a backlog. Bounded metadata retention protects pending schedules and evicts settled history first.

The existing host tick drives delivery while Freya is running. Existing Attention policy decides the visual cue and voice response. The existing voice phrase is generic; the private reminder message is available through the inbox detail read. This adds no operating-system notification or app-closed wake service. A daily cadence is every 24 hours at a fixed UTC instant; it does not track local daylight-saving clock changes. The tool requires an explicit timezone and describes these delivery limits.

## Verification

Focused tests cover private draft edits, active edit/delete refusal, deletion/replay, journal-failure rollback, Goal creation failure, UI command routing/refusal, tool argument boundaries/abort, encrypted reminder restart/cancellation, recurrence beyond eight days, missed ticks, concurrent ticks, encryption-key failure, unavailable-store preservation, and pending-schedule retention.

No live Core/Electron process, provider, or network was launched for these checks. Temporary test data stays under `.kilo/tmp`; existing dirty work is preserved and no changes were staged or committed.
