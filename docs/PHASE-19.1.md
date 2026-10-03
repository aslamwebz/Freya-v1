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
| Recent activity | `CoreActivityEvent[]` | `coreMirror().activity` |

Every field is copied out of a Core projection. The adapter invents nothing, smooths
nothing and defaults nothing into confidence. It is read-only by construction: it
holds no `submit`, no `pause`, no `resume`, and `live.test.ts` asserts their absence.

## What is deliberately absent

This is the substance of the phase. The concept art showed a great deal that the
backend was built *not* to expose, and the adapter omits each of those rather than
filling the gap:

- **No focus percentage.** `FocusState` is a closed union — `focused`, `available`,
  `away`, `unknown` — with no denominator anywhere. The "88% focused" ring was art.
  Live Home renders the state and Core's counts; there is no ring. The live adapter
  carries `focused: null`, never a synthetic `0`.
- **No Mission titles.** Mission content lives in its own encrypted store under its
  own key, and `coreMissionDetail` is not on `FreyaHostBridge`. The projection carries
  ids, statuses, counts and deadlines. So the Home checklist is omitted and Mission
  cards are identified by their real id, not by a title the renderer cannot have. The
  concept-art name map and the "completed steps" percentage are preview-only.
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

The shell reads provenance off the snapshot through `uiMode` rather than assuming it,
so a live window labels itself `Live` instead of announcing sample data — the one claim
a person cannot afford to misread. The live label is deliberately **not**
`Live · projected from Freya Core` for the whole shell: several workspaces are not
wired to a live Core yet, and each of those declares its own pending state. The shell
only claims the mode it is in.

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

## Static workspaces declare their own pending state

Five workspaces shipped as finished *concept art* with no domain behind them: World,
Life, Forge, Relay and Mind. In a browser that is correct — it is the Phase 19 design
preview, labelled as such. In a live desktop window it would be a lie, because the owner
would read sample people, conversations and history as Freya's real world.

So a live window replaces each of those surfaces with a truthful `PendingView` that
says the domain is not wired yet and names the phase that will wire it, while a preview
window keeps the finished concept design untouched. The same rule applies inside the
wired workspaces: Brain / Core drops the Freya portrait (it is cognition telemetry, not
Adult Freya's face or body) and reports Memory as not wired rather than sample counts,
and the Home activity feed is labelled `Recent activity`, not autobiographical `memory`,
because Core activity is not Freya's life history.

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
system; any 3D character work. World, Life, Forge, Relay and Mind still have only the
concept design behind them in a live window — each declares its own pending state until
its domain lands (Phase 20 Mind, Phase 21 Life, Phase 22 World, the connector phases
Relay and Foundry). The broad wiring the product brief describes is deliberately
deferred until after the SQLCipher correction and the adapted Phases 21/22/20, per the
master plan.