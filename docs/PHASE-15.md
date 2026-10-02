# Phase 15 — Foundry

## Summary

The Foundry is where Freya's work produces *reusable things*: artifacts, tools,
modules, and apps. Every one of these has a closed lifecycle with explicit
gates, and every one carries deterministic provenance so that "what this is"
and "where it came from" are facts rather than claims.

## The lifecycle

```
draft → building → built → verifying → verified → promoted → active
```

Every arrow is a gated transition. Nothing moves without an explicit
authorized action, and no model claim can substitute for verification
evidence. A thing that was never verified cannot be promoted; a thing that
was never promoted cannot be activated.

## What the Foundry ships

### Artifacts

An artifact is the basic unit of Foundry output. It has:

- **Deterministic identity** — a SHA-256 hash of its content and inputs,
  computed at creation time and never mutable.
- **Provenance** — the Run that produced it, the Step that created it, and
  the principal that authorized it.
- **Closed lifecycle** — `draft → building → built → verifying → verified →
  promoted → active`, with `failed` reachable from any non-terminal state.

### Tools

A tool is a reusable executable capability. It is created through the Work
engine, verified against its spec, promoted by explicit owner decision, and
then activated — which means it becomes available for invocation.

### Modules

A module is a composable unit of functionality. It is created through the
Work engine, verified against its spec, promoted, and then activated — which
means it can be composed into an app.

### Apps

An app is a deployable/runnable application composed of modules. It is
created through the Work engine, verified against its spec, promoted,
installed, and then activated. There is no silent auto-install or
auto-execute.

## Security properties

### Creation is through Work, never raw

An artifact is created by a Step inside a Run, under the authority of the
principal that owns the Run. There is no path from a renderer or a model to
`createArtifact` that does not go through a Run.

### Verification is separate from creation

A verifier is a separately registered piece of code that checks an artifact
against its spec and produces evidence. The verdict is derived from the
evidence by the engine, not by the verifier itself, so that a verifier
cannot mark its own work as passed.

### Promotion is explicit and owner-only

A thing that was verified is not thereby promoted; promotion is a separate
decision that requires the owner's explicit authorization.

### Activation is explicit, owner-only, bounded and reversible

A thing that was promoted is not thereby active; activation is a separate
decision that requires the owner's explicit authorization. Activation is
bounded and reversible: an active thing can be deactivated, and deactivation
is explicit and recorded.

### Nothing learned reaches the journal

An artifact's content, its spec, and its verification evidence are measured,
not recorded. The journal holds only ids, hashes, statuses, counts and
lengths.

### Idle Foundry costs nothing

No provider is contacted by anything the Foundry does.

## Red team

The red-team tests attack the Foundry's security boundaries:

1. **Forged verification.** A verifier that claims "passed" without evidence
   must not be able to mark an artifact as verified.
2. **Path escape.** An artifact's content must not be able to escape its
   sanitised boundary.
3. **Capability laundering.** A tool must not be able to launder a
   capability it does not hold.
4. **Fake progress.** A model claim must not be able to mark work as
   verified without evidence.
5. **Stale evidence.** An old verification must not be able to promote an
   artifact that has since changed.
6. **Activation bypass.** An artifact must not be able to become active
   without explicit owner authorization.
7. **Private leakage.** An artifact's content must not leak into the
   journal.
8. **Model-call amplification.** A verifier must not be able to make
   unbounded model calls.

## Files

- `core/foundry/types.ts` — the vocabulary of the Foundry domain
- `core/foundry/state.ts` — the pure fold over the durable journal
- `core/foundry/engine.ts` — the Foundry engine
- `core/foundry/index.ts` — the public API
- `core/protocol/foundry.ts` — the renderer seam
- `tests/core/foundry.test.ts` — unit tests
- `tests/core/foundry-redteam.test.ts` — red-team tests
