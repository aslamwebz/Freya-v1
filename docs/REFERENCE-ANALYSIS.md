# Reference analysis — `References/`

> **Authoritative source.** `References/uiplan.md` is the product and visual plan
> and wins wherever this document disagrees with it. In particular, `uiplan.md`
> §Visual Language (lines 185–209) **avoids heavy gold** and makes light blue/aqua
> the identity with soft lilac for cognition. The gold-centric guidance in earlier
> versions of this file is superseded; see the revised §2.

Scope: `References/index.html` (HTML/Three.js prototype), `References/*.png` (two
design renders), `References/assets/*` (atmosphere photo, agent avatars, earth texture).

The prototype is authored as **Athena OS**. It is a *design reference for Freya*.
Nothing in it is copied as production architecture.

---

## 1. What the reference actually is

A single opaque-free full-viewport dashboard:

```
┌──────────────────────────────────────────────────────────────────────┐
│ brand │        command + mic bar (centre)         │ clock · status  │  header 88px
├────────┬──────────────────────┬────────────────────┬─────────────────┤
│ nav    │  live state cards    │   presence         │  live state     │  4-column grid
│ 176px  │  focus / work /      │   (WebGL core,     │  cards          │
│        │  attention           │    HUD, dock)      │                 │
└────────┴──────────────────────┴────────────────────┴─────────────────┘
```

Three ingredients carry the identity:

1. **A photographic atmosphere** (blurred night city) behind everything.
2. **A single luminous intelligence** in the optical centre, rendered in 3D.
3. **Dark glass instrument panels** floating over that atmosphere.

Everything else is furniture.

---

## 2. Design language (plan-first, authoritative)

`References/uiplan.md` §Visual Language is authoritative. The prototype's gold
`:root` is no longer the identity: Freya avoids heavy gold. The roles below are the
ones implemented in the typed manifest `src/ui-v2/theme/tokens.ts`, which generates
`src/ui-v2/theme/tokens.css`.

| Role | Meaning |
| --- | --- |
| ground (`bg`, `panel`, `panelRaised`) | obsidian / graphite / deep-navy near-black |
| text (`ink`, `muted`, `heading`) | three readable levels on the ground |
| `line`, `glass`, `glassEdge` | hairlines + the dark smoked-glass recipe |
| `intelligence` — blue/aqua | data, telemetry, presence; the identity light |
| `cognition` — soft lilac/aurora | thought and creativity |
| `positive` — mint | healthy / trusted / success |
| `attention` — amber | rare and functional only; never a brand colour |
| `danger` — red | errors and destructive state |
| `glow` | activity emission; none when idle |
| type | Inter for body; Montserrat for the wordmark, uppercase, tracked |
| shape | consistent radii; dense but breathable spacing |

**One accent, rarely.** Gold is gone. Aqua is the identity light, lilac is
cognition, mint is healthy, and amber appears only for attention. Colour carries
meaning rather than decorating every object, and mixing accents in one element is
what the plan warns against.

**Glass.** Dark smoked glass — a dark gradient body, a subtle *luminous* hairline
and an inset top highlight. Panels read as *dark smoked glass*, never as
30%-opacity white. Panel bodies stay dark and text stays opaque so contrast survives.

**Depth.** Panels cast a large soft shadow. Nothing else does; the presence is the
only other depth cue.

**The active item.** An accent gradient wash + a luminous hairline + a solid inset
bar on the leading edge. Used for nav, dock, and dock buttons alike — in the theme's
`intelligence` accent, not gold.

---

## 3. Central intelligence

The reference renders one of five WebGL centrepieces. The render references
(`ChatGPT Image…png`, `Screenshot…png`) show a **luminous neural sphere**: a
dense point lattice with visible edges, a warm core, blue/cyan structure,
a few bright vertices, and *two or three thin instrument rings* around it with
short tick marks, plus a small **wireframe globe** on the right.

A second reference (`Screenshot…png`) shows a sparser, colder variant: a force
graph with 2–3 concentric tick/arc rings, labels pushed to the outside on
hairline leaders, and everything in `#7fcfff`.

**All five centrepieces ship, and the design lab's full option set works.** The
reusable idea, not reusable code: **presence is a luminous point field with
instrument rings, and it is the only saturated thing on screen.**

Supporting devices, all kept:

- **HUD labels** — uppercase 9.5px micro-labels with a live numeric value,
  anchored to the presence on 1px leaders, `mix-blend-mode: screen`. The single
  strongest "this is equipment" signal.
- **Beam / pedestal** — a vertical light column and stacked floor rings that
  ground the presence and give the composition a floor.
- **The background ring layer** — three full-window rings behind every panel,
  pinned to the centrepiece's screen position, whose outermost ring erodes into
  particles while anyone is speaking. This is what makes the presence feel like
  it is *in* a room rather than pasted onto a page.
- **The design lab** — background, centrepiece, brain style, extras and outer
  rings, persisted locally, with its keyboard shortcuts.

---

## 4. Surrounding live state

The reference fills the flanks with cards. The information design is good;
the *density* is not portable.

What to keep:

- One **primary card** (current focus) with a progress bar and three inline
  sub-stats separated by hairlines. This is the strongest card pattern.
- **Row lists** with a leading monogram/avatar, a bold title, a dim subtitle,
  a right-aligned status, and a hairline between rows. Used for work, agents,
  and activity.
- **Attention rows** that switch accent by severity (red / amber), each with a
  circular icon chip.
- **Restrained meters**: a 6px rounded bar, accent fill with a soft glow.

What Freya should *not* copy:

- The reference is three columns of stacked analytics. Freya's flanks must show
  **what Freya is doing and what it needs**, not a fake business dashboard.
  Proportion matters: roughly 300–360px of panel column, and a hard cap of
  ~5 visible cards per column before scrolling.
- The reference's left column is the busiest. In Freya the *centre* must win;
  flanks are secondary.

---

## 5. Voice in the header

The command bar is the primary control, not a search box.

- Round mic button at the left, a 1px accent separator, then a large (16px) input.
- A **26-bar waveform** on the right, scaled by live level. Idle → bars frozen
  and dim; listening → bars animate in the intelligence accent. This is the cheapest honest voice
  affordance: it shows *level*, and idle means *no microphone is being read*.
- The placeholder text is the state readout: "Tap the mic, or type what you
  want to do." → "I'm listening…". Copy, not colour, tells the user the state.
- The bar itself gets a stronger accent border and an outer glow when live.

**Keep this.** It is the best single idea in the reference.

---

## 6. Navigation & dock

- **Left rail**, 176px, no card chrome, 56px rows, 24px stroke icons, 15px labels.
  Collapses to 72px icon-only under 1360px.
- **Bottom dock**, a glass pill centred under the presence, 96×70 buttons, accent
  when pressed. In the reference it is a mode selector; **in Freya it should be
  the surface launcher** — the dock is the visible half of the Surface Manager.

---

## 7. Ambiguities I resolved

| Question | Decision |
| --- | --- |
| Is the photo background part of the identity or decoration? | Atmosphere, but not as a photograph. All five treatments ship as pure CSS gradient stacks; the city is drawn as light, not captured. Deep space is the default. |
| Reference shows a sculpted brain mesh and four brain styles. | Used. five centrepieces and four brain styles, ported into `src/presence/pieces/` with three.js rather than copied as one file. |
| Agent avatars are stock photos of named people. | **No.** Freya's workforce is not five stock humans. Use deterministic monogram discs with the accent ring the reference already uses. |
| Globe / "World state" card. | Dropped. "World" is a Freya system that does not exist in Phase 0; a spinning globe would be exactly the kind of fake functionality to avoid. |
| Wordmark is "ATHENA". | Freya gets its own mark — an aperture — and its own wordmark, same typographic treatment. |
| Reference has no detached windows at all. | The glass panel is Freya's **work surface**. Reuse the panel material verbatim for a real windowing system. |
| The reference's icons. | **No.** Drawn in house on a shared grammar. See DECISIONS D3. |

---

## 8. Explicitly not copied into production architecture

- One 1,900-line `index.html` containing markup, CSS, and three.js together. The
  port is split by concern: lab state, shader primitives, one module per
  centrepiece, the stage, the ring layer, the React binding.
- The reference's `window.athena` export being assigned twice — a reminder that
  prototype code accumulates defects and is not a safe base.
- The reference's `localStorage` as the source of truth for layout. In a
  desktop app the main process owns the file. (The design lab's *presentation*
  preferences do live in `localStorage`, which is correct: they are local,
  disposable, and not workspace state.)
- The reference's backdrop photograph and icon sprite.
- Global keystrokes bound without checking for a text field. Freya ignores
  B/P/1-4/C/R while an input has focus.
