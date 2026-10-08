# Degraded Core operation and diagnostics

Core health and command availability are separate. `CoreStatus.operational`
becomes true after startup finishes and false when shutdown starts. A degraded
Core serves usable subsystems; each subsystem still applies its own authority,
health, STOP ALL and execution gates. A Brain fault does not disable Chat.

When the event store cannot open, recover or accept writes, Core uses temporary
memory storage and reports `persistence.mode = ephemeral-fallback`, its reason
and `durable = false`. Runtime failures preserve already recovered events,
including STOP ALL, using a serialized store adapter. An uncertain disk write
is never retried. Initial recovery failures cannot restore unread history.
Recovery, close and subsystem faults remain separately visible in status.

This fallback does not repair corruption. A recorded integrity fault remains
untrusted across restart until validated repair; merely retaining a quarantine
does not recover missing security state. Cognition, research, browser, Relay
and voice effects retain their trust checks. Local inspection and stop controls
remain available. Ordinary degradation alone is not a global capability veto.

Runtime diagnostics are a separate JSONL writer at
`<event-store-path>.diagnostics.jsonl`. Lifecycle transitions, storage and
subsystem failures, failed model events and command failures can be recorded
without a working event journal. Records use fixed summaries and correlation
IDs; upstream exception text, upstream stacks, prompts and responses are not
copied. Exception stacks are captured locally at the diagnostic boundary.
Credential fields are additionally redacted. Directory/write failures never
throw into Core and increment `diagnostics.writeFailures`.

Shipping App Mode uses operational status for startup, workspace availability
and model selection. Its health details expose all faults, temporary event
history, diagnostics location and write failures. Security settings warn when
STOP ALL durability cannot be guaranteed. Chat and other domain stores report
their own persistence independently of the event journal.

Temporary event history is lost on process exit, and automatic migration back
to disk is intentionally absent. Recovery requires a subsequent healthy start.
Diagnostics share the event journal's parent filesystem by default, so a total
filesystem outage can prevent both writes; the failure counter makes that loss
visible. Diagnostics currently have no rotation or power-loss flush guarantee.
Focused regressions cover fallback startup/runtime writes, recovered STOP ALL,
concurrent reads, later read failures, fault retention, unrelated Chat operation,
corrupt-history admission, shutdown, diagnostic privacy and App Mode gating.

## Known-defect recovery with newer history

A recognized quarantine can now be reconciled with a newer active journal.
Recovery validates both complete histories, requires the same trusted prefix,
and retains the recovered older tail followed by every newer event. Event IDs,
timestamps, payloads and causal IDs remain unchanged. Newer envelope sequences
receive an offset; their original sequence values remain in a uniquely named
`pre-known-repair` archive, whose companion note records that offset. The
original quarantine is retained.

Recovery refuses overlapping identities, interleaved branch times, unknown
damage, additional suffix faults and any unresolved fault in the common prefix.
It synchronizes the complete candidate and its `core.integrity_repaired` marker
to a temporary file before replacing the active file atomically. The marker is
therefore replayed on the first repaired startup, rather than added afterward.
A failed archive, synchronization, verification read or replacement keeps
cognition refused while local inspection remains operational. Chat availability
reports that same trust blocker.

The resolved journal warning leaves current health, while its original fault
and degraded events remain in the audit history. Unrelated health faults remain
visible. Replaying the combined journal restores state without repeating model
calls or other external effects.

Run recovery with all instances using that profile stopped. The expected-byte
check catches changes during preparation, but it is not a store ownership lock;
another writer between that check and replacement is still unsafe. Store-level
ownership, universal write validation, short-write handling, live-read regression
detection and the general truncation-before-fault crash window remain separate
hardening work. This change fixes the recognized-repair deadlock and makes its
replacement and acknowledgment durable; it does not waive journal trust checks.
