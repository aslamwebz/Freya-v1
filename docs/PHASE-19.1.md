# Phase 19.1 — Live projection

The Phase 19 UI foundation became a projection of the actual system.

Phase 19 delivered `src/ui-v2`: a shell, ten workspaces, three themes and a window
system, delivered as a **design preview**. Its `entry.tsx` hardcoded
`createPreviewAdapter()` — a frozen fixture — and every surface said so, honestly, in
a `Design preview · Sample data` label and a disabled composer. That was the correct
thing to ship and it was never wired to anything.

This phase connects it. `src/ui-v2/state/live.ts` is the first UI code in the
repository that reads Phases 0–18. It changes no domain, adds no command and owns no
state: it subscribes to the mirrors the renderer already had and projects them.

## What is real now

| Surface | Projection | Source |
| --- | --- | --- |
| Current focus | `CoreStatus` | `coreMirror()` |
| Mission | `MissionProjection` | `missionMirror()` |
| Workforce | `WorkforceProjection` | `workforceMirror()` |
| Attention | `AttentionProjection` | `attentionMirror()` |
| Recent memory | `CoreActivityEvent[]` | `coreMirror().activity` |

Every field is copied out of a Core projection. The adapter invents nothing, smooths
nothing and defaults nothing into confidence. It is read-only by construction: it
holds no `submit`, no `pause`, no `resume`, and `live.test.ts` asserts their absence.

## What is deliberately absent

This is the substance of the phase. The concept art showed a great deal that the
backend was built *not* to expose, and the adapter omits each of those rather than
filling the gap:

- **No focus percentage.** `FocusState` is a closed union — `focused`, `available`,
  `away`, `unknown` — with no denominator anywhere. The "88% focused" ring was art.
  Live Home renders the state and Core's counts; there is no ring.
- **No Mission titles.** Mission content lives in its own encrypted store under its
  own key, and `coreMissionDetail` is not on `FreyaHostBridge`. The projection carries
  ids, statuses, counts and deadlines. So the Home checklist is omitted and Mission
  cards are identified by status, not by a title the renderer cannot have.
- **No People and no World.** No projection exists for either. Those Home panels
  disappear rather than rendering fixture data next to live data, which would be the
  worst of both.
- **No invented copy.** The taglines and preview narratives are gone from the live
  path.

`contract.ts` records this structurally: `HomeView.focus` is nullable and `goals`,
`people`, `world`, `messages`, `followUps`, `meetingPrep` are optional. A surface
cannot read a domain that does not exist, because the type does not offer it.

## Three states, not two

`Resource<T>` gained no new cases, and that is deliberate. The distinction that
mattered was already there and was being misused:

- `loading` — a projection is on its way.
- `unavailable` — nothing will arrive, with the reason.
- `ready`/`stale` — the data, carrying `source: 'live' | 'preview'`.

The shell reads provenance off the snapshot rather than assuming it, so a live window
labels itself `Live · projected from Freya Core` instead of announcing sample data —
the one claim a person cannot afford to misread.

Two bugs this phase's own tests caught, both of them the same shape of lie:

1. An empty activity feed from a Core that never reported was published as `ready`.
   That conflates *nothing is watching* with *nothing is happening*, which is exactly
   the confusion the Attention protocol's comment warns against. It is now `loading`
   until Core has reported at all.
2. With no bridge, the Core mirror publishes an `ABSENT` status whose lifecycle is
   `booting`. Rendering that said Freya was starting when nothing was there to start.
   The adapter captures bridge availability once and reports `unavailable` with
   `No Freya Core is reachable from this window.`

`npm run dev` has no bridge, so `entry.tsx` uses the preview fixtures there. They
remain labelled as sample data everywhere they appear.

## Integration

`src/main.tsx` loads exactly one renderer:

```
?ui=phase19  →  ui-v2      (live if a Core bridge exists, else preview fixtures)
otherwise    →  legacyEntry (the existing Phase ≤18 UI, untouched)
```

Both entries are static imports from one switch, so Vite code-splits them and the
legacy dashboard is not paid for by the new shell. Nothing under `src/ui/`,
`src/presence/` or `src/core/` was modified.

The recovered test files were not in `temp/` — only in `Freya-Phase-19-UI.zip` —
and are restored at `tests/unit/ui-v2/`.

## Verification

```
tsc -p tsconfig.json --noEmit     clean
eslint .                          clean
vitest run                        185 files, 3209 tests passing
vite build                        succeeds, both entries emitted
```

The 32 delivered Phase 19 tests pass unmodified. They were not rewritten to fit this
phase: the contract changes were additive, and the preview fixtures still satisfy
them.

## Not in this phase

Chat, Memory, Approvals and Settings as surfaces; Chibi Freya; the desktop widget
system; Brain/Core on real telemetry; any 3D character work. Nine of ten workspaces
still have preview data behind them, and the remaining four surfaces named in the
product brief do not exist yet.