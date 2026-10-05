# Architecture

Freya is a **persistent Core with replaceable embodiments**.

Today Core is hosted inside the Electron desktop process because that keeps the
prototype local, simple and fast to debug. That is a deployment choice, not an
ownership boundary. From this point forward, nothing that makes Freya Freya may
depend on Electron.

The governing rules are in [FREYA-CONSTITUTION.md](FREYA-CONSTITUTION.md), and the
future sequence is in [ROADMAP.md](ROADMAP.md).

---

## 1. The shape of the system

```
                              FREYA CORE
┌───────────────────────────────────────────────────────────────────────┐
│ Identity · Mind · Personality · Context · Memory · Missions · Work    │
│ Workforce · Governor · Guard · Event Fabric · Model Gateway           │
│                                                                       │
│ No React · no DOM · no CSS · no Three.js · no BrowserWindow           │
└───────────────────────────────┬───────────────────────────────────────┘
                                │ typed Freya protocol / projections
                 ┌──────────────┼──────────────┐
                 │              │              │
          Desktop Presence   Dashboard       Office
          character/voice    work surfaces   workforce view
                 │              │              │
                 └──────────────┼──────────────┘
                                │ bounded device capabilities
              ┌─────────────────┼─────────────────┐
              │                 │                 │
           Browser            Files          Editor/Apps/Computer
```

Three ownership rules are load-bearing:

1. **Core is Freya.** Identity, relationship, memory truth, Missions, Work,
   Workforce, authority and credentials do not belong to a renderer.
2. **Bodies are disposable projections.** The orb, desktop character, dashboard
   and future Office render Core state and submit narrow requests. Closing or
   replacing one must not change who Freya is.
3. **Hands are capabilities.** Browser/files/editor/apps/computer control are
   scoped interfaces mediated by Guard and a local device boundary, never
   unrestricted ambient access.

The current Electron main process is both host and adapter. A later phase may move
Core into a separate local service or hardened backend without changing the
renderer contract. The UI should know that it is connected to Freya, not where
Freya happens to execute.

The renderer **never** owns the filesystem, network, model credentials, memory,
authority or long-running work. Privileged platform adapters live outside the
renderer and are reached through narrow typed boundaries.

---

## 2. Process boundary

**Main process** (`electron/`) is the durable half:

- creates and owns the shell window;
- reads/writes `workspace.json` in the OS app-data directory;
- survives renderer reloads, crashes and `Cmd/Ctrl+R`.

**Renderer** (`src/`) is the disposable half:

- React + the presence canvas + the surface layer;
- is reconstructible from `(runtime info, workspace.json)` alone;
- can be thrown away and rebuilt without touching long-running work.

`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. The preload
script exposes four functions and one flag — `getRuntimeInfo`,
`loadWorkspace`, `saveWorkspace`, `onCollect`, `isDesktop` — and nothing else. No
remote module, no `ipcRenderer` passthrough, no eval.

**Why the UI can be disposable.** Long-running Freya work lives in Core, not in
the renderer. In the current deployment Core is hosted by the Electron main
process; later it may be a separate local service. The renderer only holds a
projection of that state. Reloading or replacing a body re-reads the projection;
the work keeps running. Surface ids are durable UI identities, not ownership of
the work they display.

---

## 3. Inside the renderer — four seams, not one

The renderer is deliberately split so that Phase 1+ can attach without a rewrite.

### 3.1 Store (state, not components)

A single reducer over a single event union.

```
dispatch(event) → reduce(state, event) → notify → React re-renders
```

Components read state and dispatch events. **No component calls another
component.** No context-based cross-talk, no imperative DOM mutation outside
the presence canvas and the window-drag controller (both of which are
`ref`-scoped leaves). This is what makes the shell "reacting to state" rather
than "wiring".

State shape (`src/core/events.ts`):

```ts
ShellState = {
  presence:   { state, since, activity, detail }
  surfaces:   { open, minimized, focused }   // a summary, not a second copy
  nav:        string
  listening:  boolean
  commandDraft: string
  lastCommand: string | null
  core:       CoreStatus | null          // Core's projection, verbatim
  activity:   CoreActivityEvent[]        // Core's feed, verbatim
  desktop:    DesktopProjection          // everything derived, computed below
  runtime:    { version, platform, userData, workspaceFile, dev }
  attention:  { requested, lastNote }
  runtime:   { version, platform, userData, workspaceFile, dev }
  attention: { requested, lastNote }
  notices:   Notice[]
}
```

The conversation transcript itself is **not** in this state. It lives in Core's
conversation projection, reaches the renderer over its own channel, and the store
holds only which pane was open — an id, which is not authority, because Core
re-reads the transcript from its own store and a stale one resolves to nothing.

`dashboard` is gone. The `demo: true` fixtures it carried were removed in Phase 2
rather than relabelled — see §3.5.

Ownership is disjoint and explicit. The **Surface Manager owns surfaces**; the
store owns everything else. Every manager lifecycle change is dispatched onto
the same bus as every other event and carries a `SurfaceSummary` — the three
facts the shell needs — computed by the manager at commit time. The reducer is
pure, so it stores the summary without needing to reach into the manager.

That single path is what the shell subscribes to. There is no second
subscription on the manager, and no component calls another.

### 3.1b Presence is derived, and one path can still move it by hand

**Revised in Phase 2.** Presence used to be a stored value that events could
transition. It is now a function of Core's status, recomputed in `project()` on
every Core push:

```
CoreStatus.integrity / lifecycle / stopAll / governor
CoreStatus.activeProviderCalls      ← the Model Gateway's live registry
        + listening (local)
        ↓
   derivePresence()  →  PresenceState
```

Ordered by how much the condition matters: a corrupt journal outranks an open
microphone, which is fail-closed arriving in the UI layer. Running model work
outranks the microphone, because a request that is executing is spending money
whether or not anyone is speaking.

Consequences, all of them tested:

- **No ungated setter.** `presence.set` is gone. `presence.simulate` is the only
  way to move presence without Core, and the reducer ignores it unless
  `runtime.dev`. `runtime.dev` defaults to `false` and is set only by the host, so
  a window whose hydration failed cannot come up with the simulator enabled. The
  Development Lab and its chips are additionally not rendered unless `runtime.dev`.
- **The microphone is refused, not overridden.** Setting `listening: true` is
  accepted only if the derived presence would actually become `listening`. A
  locked, degraded or journal-faulted Core refuses the toggle outright, so
  `state.listening` is never true while the window says `locked`.
- **`working` requires real work.** It has exactly one door:
  `CoreStatus.activeProviderCalls > 0`, read from the Model Gateway's active
  request registry. `thinking` has none. The count is not reconstructed from the
  journal — a journal is history, and a request it records as started may have
  been abandoned by a process that died. See §6.1.
- **A workspace restores layout, not presence.** `ShellStore.hydrate` is narrowed
  to the runtime identity alone so it cannot smuggle state in at boot.

`withPresence` and the transition table remain, governing the one path that can
still set a state directly: the development override.

### 3.2 Surface Manager (`src/core/surfaces/`)

The single most important abstraction in Phase 0.

```
Surface = { id, type, title, context, state, layout }

layout   = { x, y, width, height, minimized, maximized, pinned, z }
```

The manager is a **pure TypeScript class with no React and no DOM**. It receives
a *frame* (the workspace bounds) so it can clamp and maximise without measuring
anything itself. It exposes exactly:

```
open · close · focus · move · resize · minimize · unminimize
     · maximize · unmaximize · togglePin · cycle · serialize · restore
```

and emits `surface.opened/closed/focused/moved/resized/state.changed`.

Two names that are easy to confuse and are not:

- `unminimize(id)` — bring one surface back. Added in Phase 2, because the spec
  listed `restore` as a per-surface operation and only the workspace-wide
  `restore(array)` existed.
- `restore(persisted)` — replace the whole layout from a saved file. A launcher
  click calling the other one would wipe the arrangement of every window.

Consequences that matter:

- `SurfaceWindow` is written **once**. Any future surface type gets move, resize,
  minimise, maximise, focus-order, clamping, restore and persistence for free by
  being registered. No per-feature window component will be written.
- The manager is unit-testable without a browser. Most of the Phase 0 test suite
  is aimed at it.
- The persisted file is a *serialisation of the manager*, not of the DOM, so a
  schema change is a version bump in one place.

Surface **types** are declared as data (`surfaceTypes.ts`): id, title, icon,
default size, minimum size, status, and an **instance policy**. Adding
Vault-as-a-surface is one entry there plus one body component.

```ts
instance: 'singleton' | { keyedBy: 'missionId' }
```

`open()` consults that policy instead of branching on type, so a future
multi-instance surface needs a descriptor field and no manager edit. Opening an
already-open singleton **restores and focuses** it rather than duplicating it —
two Security windows would be two ways to stop Freya. A keyed type opened without
its key behaves as a singleton, because two unkeyed windows of a keyed type are
indistinguishable to a person.

`registry.tsx` combines that data with a body component into one catalog
(`SURFACES`), and the launcher, the placeholders and the manager all read from it.
The launcher was a hand-written array beside `ChatBar` and had already drifted —
**Security was missing from it**, so the surface with the stop button was the one
you could not launch.

### 3.3 Presence (`src/presence/`)

One scene, one `requestAnimationFrame` loop, no React re-render per frame.
React owns *which state* the presence is in; the stage owns *how it looks*
given that state, interpolated.

```
Presence.tsx        binds store state + voice envelope + design lab
  ├── PresenceView.tsx  the two canvases, one clock, lazy import
  │     ├── stage/PresenceStage.ts   scene, pieces, HUD, beam, pedestal, loop
  │     └── stage/RingLayer.ts       the full-window background rings
  ├── pieces/*      one module per centrepiece; brain.ts carries four styles
  ├── voiceEnvelope.ts  the level signal (simulated in Phase 0)
  └── DesignLab.tsx   background / centrepiece / style / extras / rings
```

Three properties matter:

- **One loop.** The stage's clock drives the ring layer through an `onFrame`
  hook. Two rAF loops would drift.
- **It hard-stops.** Hidden window or `prefers-reduced-motion` means no loop at
  all; reduced motion paints one static frame.
- **It is code-split.** three.js is behind a dynamic import, so a shell that
  never reaches the presence does not pay for it. A failed WebGL context
  degrades to a stated still frame.

Presentation preferences (the design lab) live in their own module and their own
`localStorage` namespace, separate from the workspace file, because they are
local, disposable, and not workspace state.

### 3.4 Platform adapters (`src/platform/`)

`workspaceStore` is an interface with two implementations:

- `createIpcWorkspaceStore()` — production, main-process file;
- `createLocalWorkspaceStore()` — browser dev only, `localStorage`.

The renderer picks one at boot. This exists so the UI can be developed and
screenshotted in a plain browser without weakening the desktop boundary.

---

### 3.5 Projection — one interpretation, no interpretation in panels

`src/core/desktopProjection.ts` is a pure function:

```
CoreStatus + CoreActivityEvent[] + local shell facts
        ↓  projectDesktop()
   DesktopProjection
        ↓
panels, Presence, the system area
```

Panels do not read `CoreStatus` fields. They read a `DesktopProjection`, which is
why four panels cannot disagree about what `governor.status: 'deny_all'` means —
there is one function that decided, and it is unit-tested against a table of cases
rather than by looking at a window.

The reducer recomputes it in one place (`project()` in `src/core/events.ts`) on
every `core.status` or `core.activity` event. It is deterministic given the same
input: no globals, no randomness, no clock beyond the `now` passed in.

**Presence is derived from it, not stored alongside it.** There is no ungated
`presence.set` event; the only way to move presence without Core is
`presence.simulate`, which the reducer ignores unless `runtime.dev` — and
`runtime.dev` itself defaults to `false` and is set only by the host, which knows
how it was launched.

### 3.6 Activity is a projection of the journal, and the journal stays in Core

The renderer receives `CoreActivityEvent[]`: `{ id, kind, type, sequence, at,
text, tone }`.

**There is no payload field.** That is the whole security property, and it is
structural: `command.received` maps to `Command received (42 characters)`, a
hostile payload cannot reach the row because the row is built from named fields,
and adding a field to an event does not add it here. The journal has never held
command text and neither does the feed.

`Core.start()` folds the log once, deriving state and activity from the same
events in the same order, and a subscriber gets the whole feed on attach — so a
window opening on day seven agrees with one that never left. There is no
renderer-side activity database.

The preload bridge exposes `coreActivity()` and `onCoreActivity()` and
deliberately **no generic event reader**: a window can have rows, not the journal.

## 4. Persistence

`workspace.json` lives in Electron's `app.getPath('userData')`:

```jsonc
{
  "schema": 1,
  "surfaces": [ /* Surface[] in z-order */ ],
  "presence": "idle",
  "nav": "home"
}
```

`presence` is **written but not restored**, and that is intentional rather than an
oversight: presence is derived from Core's live status, so a saved `thinking` from
a crashed session is not a fact about the current one. The field is kept so the
on-disk shape of files people already have does not change under them. The e2e
asserts the stronger version of this — after a relaunch with STOP ALL latched,
presence reads `locked`, read from Core's durable latch rather than from disk.

Presentation only. There is no field here for a credential, a capability, a
grant, a prompt or a model response, and the parser discards anything it does not
recognise. Anything that decides *whether Freya may act* lives in the durable
journal and nowhere else: a file the renderer can write must never move it.

Rules:

- Written on a debounce (400ms) after any state-changing event, and once more on
  quit. Not on every pointer-move.
- Read once at boot, before first paint of the surface layer.
- `schema` is checked. Unknown or corrupt input falls back to defaults; a
  corrupt file is never allowed to prevent launch.
- Rehydration re-clamps every surface into the current workspace frame, so
  restoring a layout saved on a 4K display onto a 1280 window still produces a
  usable workspace.
- The workspace frame excludes the header and the navigation rail, measured
  from the DOM, so surfaces can never be dragged under the command bar or
  over the systems list.
- **The size limit is enforced before writing, not only on read.** A limit
  checked when loading protects the next launch but still lets an unbounded
  payload reach the disk. It is measured in UTF-8 bytes in **both** directions:
  measuring the write in bytes and the read in string length means a payload
  can be accepted and then silently rejected on the next launch.
- Writes are atomic (temp file + rename), serialised through a promise chain,
  and generation-stamped. A write may only publish if it is still the newest
  one, and the check and the rename happen together with nothing between them —
  otherwise a debounced write already in flight when the user quits would land
  on top of the final flush and resurrect an older layout.

**Not persisted:** dashboard demo fixtures, the presence canvas, transient
animation values. They are derived, not stored.

### 4.2 Five encrypted stores, five secrets

Everything a person tells Freya is written to disk encrypted, in **separate
stores**, each with its own 256-bit secret and each wrapped separately by the OS
secure storage:

```
  conversation  256-bit random  ─┐
  brain         256-bit random  │     each wrapped separately
  mission       256-bit random  │     (DPAPI / Keychain / libsecret)
  context       256-bit random  │
  personality   256-bit random  ─┘
```

Phase 7 added `mission` for a Mission's title, intent and success criteria — what
somebody asked Freya to accomplish, in their words. That is as private as a
conversation, so it gets the same isolation rather than sharing a secret. Phase 9
added `context` for what a person deliberately shared, and Phase 11 added
`personality` for what Freya has recorded *about* them: their preferences, their
habits, the shorthands they share. That last one is the most intimate thing this
system holds, which makes it the last that should be one key-compromise away from
the conversation log.

A keyring written before a domain existed is **upgraded**, not rejected: the new
secret is generated and the file rewritten with the complete set, preserving the
existing ones byte-for-byte. That rewrite is only attempted when every secret already
in the file has been unwrapped — a keyring this process cannot open is left exactly
as found, and the new domain reports memory-only instead. Those keys hold people's
conversations, their own long-term memory and their relationship history, and there
is no second copy, so a rewrite that failed halfway would be unrecoverable rather
than inconvenient. The write is temp-file plus rename for the same reason.

`personality` is also the one domain whose **absence changes behaviour** rather than
only durability. Without it, the anti-repetition ledger cannot be trusted across a
restart, so Core refuses it outright and offers no expression guidance at all —
rather than offering guidance from a memory that would re-offer the same gesture
forever. See [PHASE-11.md](PHASE-11.md).

Independent secrets rather than one root with derived subkeys, and that is a
deliberate trade. Deriving is tidier to manage, but recovering a root yields
*every* domain at once — so "the conversation key leaked" stops being a bounded
problem and becomes "Freya's entire memory leaked". Five secrets cost four
migrations and buy back a blast radius of one. The Brain is the longest-lived, most valuable
state in the system, so it is the last thing that should be one key-compromise
away from the conversation log.

Phase 3's single `<data>.key` file is adopted **byte-identically** as the
conversation secret on first run, so existing transcripts stay readable, and then
left in place — a migration that can lose access to history on its failure path
is not one worth shipping.

When the OS secure storage is unavailable, or Electron selects the insecure
`basic_text` backend, **no key is produced**. Core falls back to ephemeral stores
that label themselves, and the Vault says `FORGETS ON QUIT` before anything can be
typed into it. There is deliberately no path that writes a key beside the data it
protects, or writes either store in the clear: a weaker store silently standing in
for an encrypted one is a worse bug than forgetting a conversation, and it is the
failure a person cannot detect.

### 4.3 The Brain log is chained; the journal is not

The Brain store appends AES-256-GCM records in which each line's header —
including the previous line's digest — is authenticated as additional data:

```
  line N   =  { version, kind, seq, prev, context, nonce, cipher, tag }
             \_____________ authenticated as AAD ____________/
  prev(N)  =  sha256(line N-1, exactly as written)
```

A tag authenticates a record. The sequence and chain detect interior deletions,
duplications and reordering. Removing a complete valid suffix cannot be detected
without an independently trusted head; the current log has no such anchor.
Owner-requested withdrawal instead appends an archive record. The security
journal has separate recovery and integrity requirements (see §6.1).

A broken sequence or chain is reported and **reading stops there** rather than
skipping the line, because continuing would let a deleted record look like it was
never there.

A degraded log is read-only: Freya can still answer, but refuses durable Brain
writes beyond a break. An authenticated final record with a missing newline stays
readable while further appends are refused. Accepted writes are flushed before
advancing the in-memory chain; a failed append degrades the store. Queued admissions
are serialized as whole operations, and close drains accepted admissions and writes.

**A Brain fault is never a security event.** It cannot grant cognition or clear a
stop, and it does not *lose* authority either — unreadable long-term knowledge is
neither permission nor lockout. `brain.degraded` is deliberately absent from
`SECURITY_EVENT_TYPES` so a disk error cannot masquerade as a safety posture.

**There is no delete.** Withdrawing a memory archives it: the record stays, its
status changes, and retrieval stops returning it. The Vault lists what Freya holds
and counts what was withdrawn, so it is visible that a memory went somewhere rather
nowhere.

### 4.4 The public network, and a browser that only reads

Phase 5 adds the only subsystem in Freya that reaches the internet, and it is
structured so that "the URL looked fine" is never the reason something was reached.

**Public-network policy.** HTTP(S) on default ports only; no userinfo; no private,
reserved, loopback, link-local, unique-local or multicast address in any
normalised form (decimal, octal, hexadecimal, IPv4-mapped IPv6 included); every DNS
answer validated; **the vetted address pinned to the connection** through a
`lookup` override so the name cannot be resolved twice; every check repeated at
each redirect; no https→http downgrade; cookies, `Host`, `Proxy-Authorization` and
CRLF in header values refused; three redirects maximum; bodies bounded *while
streaming*. Full detail in [PHASE-5.md](PHASE-5.md) §3.

**The managed browser reads.** A hidden, sandboxed, `contextIsolation` window with
no preload and no node integration. The page is fetched by the controlled transport
— never by the page — and served on a session-owned internal URL under
`default-src 'none'; script-src 'none'; connect-src 'none'; frame-src 'none'`. Every
subresource, permission, popup, download, frame and page-initiated navigation is
denied independently. One fixed trusted extraction script runs in an isolated
world; no script or selector comes from the renderer, a model or a page.

Session partitions come from a **bounded leased pool of four**, cleared on acquire
and release, because Electron cannot destroy a `Session` and one per read would
accumulate for the life of the process.

**It has no `click` and no `fill`.** Those were in scope and are deliberately
absent: a page that can be clicked is a page whose author chose what Freya does
next, and the injection containment depends on there being no executable surface
for an injected instruction to reach. See D22.

**A Brain fault is still not a security event**, and research does not change that.
A research failure cannot grant cognition or clear a stop; it is a data fault
reported with a fixed public code. Research results are ephemeral and are never
written to the encrypted Brain — see D23.

### 4.1 Surviving an immediate quit

A renderer cannot push its final layout at quit time — an IPC sent during
teardown is dropped. This is not theoretical; it was measured before the fix.

So the host asks. Both the window's `close` event and `app.quit()` route
through one `collectAndThen`, which:

1. holds the close (`event.preventDefault()`),
2. sends `freya:workspace:collect` to the still-live renderer,
3. waits for the renderer's reply, which arrives as an ordinary
   `workspace:save` call,
4. writes the payload **synchronously**,
5. releases the close.

A 750ms timeout guarantees the app can always be quit even if the renderer is
wedged. The preload bridge is the whole of it: the host can ask, and the
renderer can answer with something only it knows.

---

## 5. How future systems attach

The intended shape, stated so the seams can be checked against it:

| System | Attaches by | Does **not** require |
| --- | --- | --- |
| Mind (conversation) | **built in Phase 3** — a `conversation.*` event family + a `chat` surface | any change to the window model |
| Brain (memory, identity, self) | **built in Phase 4** — a `brain.*` event family + a `vault` surface | a second window implementation |
| Work (runs, tasks, approvals) | **built in Phase 6** — a `work.*` event family, a `WorkEngine`, and a `work` surface | a store, a persistence path, or the journal knowing what a step is |
| Searcher | a `searcher.*` event family + a surface registry entry | a second window implementation |
| Missions | **built in Phase 7** — a `mission.*` event family, a `MissionEngine`, an encrypted content store with its own key, and a `mission` surface | a store for Work, or the journal knowing what a Mission is |
| Context (what was shared, what "here" means) | **built in Phase 9** — Core-owned integration, an encrypted store with its own key, and a read-only `context` surface | OS-wide screen capture, or a context command a window can name |
| Personality (temperament, relationship, expression) | **built in Phase 11** — a `personality.*` event family, a Core-owned `PersonalityIntegration`, an encrypted store with its own key, and a read-only `personality` surface | a `personality.*` command a window can name, or a way for a record to grant anything |
| Workforce | **built in Phase 8** — a `workforce.*` event family, a `WorkforceEngine`, and two authority objects that keep the subordinate relationship a type rather than a convention | agents running in the renderer |
| Skills + Forge (generated modules) | **built in Phase 48** � a `forge.*` event family, a `ForgeEngine`, an encrypted package store with its own key, a declarative interpreter instead of a code sandbox, and a push-only `forge` projection | a general-purpose code sandbox, a capability grant, a command that installs *and* enables, or any path from a manifest to a filesystem write || Harness | surfaces that request a PTY from the main process | the renderer owning process handles |
| Vault (files, Obsidian-compatible import) | **the `vault` surface is now the Brain**; a file-backed vault is a *future* capability-scoped access path | direct fs from the renderer |
| Guard | every privileged call routed through main | the UI holding secrets |
| Governor | budgets enforced in main | the UI being able to raise a budget |

The test of this architecture: **a new system adds events, a surface entry, and
a component.** It does not add a window manager, a store, or a persistence path.

### 5.1 Work is the one subsystem that adds no persistence

The Brain and the Conversation store each own an encrypted file. **Work owns none**,
and that is a decision rather than an omission.

Its history lives in the event journal, which already is the durable record of what
happened: `work.*` events are fsynced, sequence-ordered, validated against a closed
schema and replayed on every start. They carry only ids, counts, statuses and
*measured lengths*, so there is nothing in them for a store to protect — no step
input, no observation text, no label, no task title. A third encrypted store would
have meant a third keyring secret, a third file and a third recovery policy, for
what is structurally the same information in a weaker form.

What is lost by that choice, and stated rather than hidden: a step's plan, its
input, an observation's contents and any label a person typed are **process facts**
and do not survive a restart. The projection says so with a single
`detailAvailable` boolean, and recovery is written around the consequence — see §6.5.

So the separation is explicit rather than accidental:

```
  durable   what ran, in what order, how it ended, whether it verified,
            who decided each approval                        → the journal

  live      which capability is executing right now, a plan,
            an observation's contents, a label you typed      → this process
```

A future phase that needs durable work *content* — a Mission whose decomposition has
to outlive the process, say — adds an encrypted store then, with its own key and its
own retention rules, rather than weakening this boundary now.

### 5.2 Capabilities attach; subsystems do not branch

Work reaches the outside world only through a registered `WorkCapability`, and
`core/work/` names no subsystem. Search, a browser, a terminal, an agent and a
Mission are all "call this, get evidence back, verify it against that", so they
attach by being registered:

```
  Work Step
     ↓  a plan names a registered capability
  capability.capability ──► Guard ──► allow | deny | approval_required
     ↓
  execute(request, { signal, now })
     ↓
  Observation ──► a separately registered verifier ──► verified | failed
     ↑                    ↑
     └── raced ───────────┘  against one Run deadline, covering the whole Step
```

Three rules the shapes enforce rather than document:

- **A capability is asked; it does not decide.** It names the Guard capability it
  needs, and a plan cannot name a capability directly.
- **An action is not evidence.** `execute` returns an Observation and never a
  verdict, and the verifier is a separately registered object that receives the
  observation and nothing else — so the thing that produced the evidence cannot
  certify it.
- **Risk lives on the capability, in code.** A plan may *add* an approval gate; it
  can never remove the one a `consequential` capability carries on its own account.

The engine holds no `Principal`: Core closes over the owner principal when it wires
the `WorkAuthorizer`, which is what keeps §4's "no exported principal factory"
property intact.

---

## 6. The Core layer

Phase 1 added a process that exists outside the renderer and outside React:

```
electron/main.ts          owns one Core, for the life of the process
  └ core/                 Electron-free. No React, no browser globals.
      index.ts            the facade: lifecycle, and the command surface
      authority.ts        what a caller may say — no identity fields anywhere
      state.ts            the one pure reducer every projection is built from
      events/             envelope, validation, JSONL store, serialised fabric
      security/guard.ts   the policy. It judges a principal; it mints none.
      cognition/          grants, the Governor, the service that owns both
      model/              the provider contract, NanoGPT, the gateway
      mind/               the Mind, and the deterministic context compiler
      conversation/       conversation entities, stores, and the service
      identity/           the Identity Kernel: who Freya is, outside any model
      brain/              identity root, self-model, world, memory, experience
      research/           search, URL policy, transport, browser, evidence,
                          schemas, prompts, coordinator, Core integration
      voice/              local-only voice abstractions and bounds
      projections/        Core's account of itself, derived from the log
```

Three properties worth stating, because they are enforced rather than intended:

- **Core's public interface has no cognition surface.** No service, no gateway,
  no grant store, no policy object. Cognition is reachable only through an
  authority object with a principal already baked in, whose methods match the
  authority it was issued. See [COGNITION-POLICY.md](COGNITION-POLICY.md).
- **Core belongs to the process, not the window.** Closing a window flushes the
  workspace and nothing else. Only `app.quit()` stops Core, so a new window
  reconnects to the same instance with the same event sequence and the same
  latched security state.
- **The renderer holds a mirror, never a copy.** Every value it shows came over
  IPC, and Core overwrites it whenever its own state moves. With no Core the
  panels say so rather than showing a healthy-looking zero.

The bridge declares its whole surface once, in `src/platform/host.ts`. Adding a
function to `electron/preload.ts` without adding it there is a type error, which
is the point: the bridge should not be able to grow unnoticed.

### 6.1 Cancellation, and where live work is known

The Model Gateway is the only path to a provider, and it is also the only place
that can stop one. `ModelProvider.complete` takes a required
`ModelCallOptions.signal`, so a provider that cannot be aborted does not typecheck
rather than merely being discouraged.

```
Core / Security
      │  cancelAll(reason) · resume()
      ▼
  ModelGateway
      ├── contact gate + cognition epoch
      ├── active registry ──► activeProviderCalls (CoreStatus)
      └── AbortControllers ──► ModelCallOptions.signal
```

Four properties, each of which is load-bearing:

- **The gate is closed before the latch is written.** `security.stopAll` closes
  the gateway and only then appends `security.stop_all.activated`, in the same
  synchronous turn as the decision to stop. The other order leaves a window where
  a request was authorised, the stop was on its way to disk, and a provider could
  still be contacted. A latch replayed from the journal also closes the gate at
  start-up, so a restarted, stopped Core is not one field away from spending.
- **The race is closed by a generation, not by timing.** A request captures the
  cognition generation it was authorised under and may contact a provider only
  while that is still current. Two refusal points bracket the single `await` in
  the window, and there is deliberately no `await` between marking the contact
  and making the call.
- **Live work is a process fact.** `activeProviderCalls` counts only registry
  entries whose provider call is actually unresolved. Requests waiting before
  provider contact remain tracked for cancellation/race safety but do not make
  Presence claim paid work is running. The journal is not a substitute for this
  process fact.
- **Only the owner reopens the gate.** `resume()` restarts nothing and returns
  nothing; it changes whether a *new* request may begin. No provider, model or
  model-written agent can reach `cancelAll` or `resume`.
- **A failed STOP write fails closed.** The contact gate is closed before the
  durable STOP event is written. If that append fails, Core does **not** reopen
  the gateway. The closed runtime gate is projected as Governor `deny_all`,
  new cognition is refused before provider selection, and only a later explicit
  owner `security.resume` may reopen the session gate. Shutdown and degraded
  Core cannot be reopened through this path.

Cancellation is journalled as `model.request.cancelled` with `providerContacted`
stated, never inferred: a request refused at the door is not a call and any start
already written is withdrawn, while one aborted with the provider working stays
an explicit unknown so the totals remain a lower bound. A cancelled request's
grant reservation is not returned.

`Core.stop()` refuses new work, aborts what is running, waits up to a second for
those requests to write their terminal events, and only then closes the fabric.
The wait is bounded because a provider that ignores its signal must not be able to
hang the application; past the bound the journal is left with a start and no
finish, which is what a crash would have left too.

`gateway.cancelRequest(requestId, reason)` is the *scoped* path, and it is
deliberately nothing like `cancelAll`: the contact gate stays open, the cognition
generation does not move, nothing durable is latched, no other request is touched,
and an already-spent reservation stays spent. STOP ALL stops Freya's authority to
think; this stops one answer. A button that latched a security stop would make the
security control unusable, and one that refunded the call would make it dishonest.

### 6.2 The Mind, and why the model is not Freya

```
  Renderer
     ↓  conversation.turn.submit        text, and nothing else
  Core command surface
     ↓
  ConversationService                    commands + projection
     ↓
  Mind                                   one turn, one grant, one call
     ↓
  Context Compiler                       identity + history + this turn
     ↓
  Governor → Model Gateway → Provider    exactly one request
     ↓
  Mind                                   stores the answer
     ↓
  Conversation Store (encrypted) ──► projection ──► Renderer
```

The renderer has no line to the Model Gateway. It cannot name a grant, choose a
model, raise a token ceiling, pick a turn id or select a provider, and
`cognition.request` is not a name the preload bridge will accept. The only route
from a window to a model is a conversation turn.

"Model ≠ Freya" is two independent mechanisms, because either alone would be a
promise rather than a property:

- **The Identity Kernel** (`core/identity/identity.ts`) is typed, frozen data in
  Core. The Context Compiler *serialises* it for a provider; the provider receives
  a rendering of it rather than being the thing that defines it.
- **The Mind never imports a provider.** It reaches cognition only through an
  `OwnerAuthority` it is handed, so `Mind → NanoGptProvider` is not a line in this
  codebase.

No security authority is encoded in the kernel. Guard, the Governor, the contact
gate and STOP ALL are code, and a prompt that described a real boundary would be a
lie about where that boundary lives.

Prompts are therefore a **serialisation**, not the definition:

```
canonical Freya state → Context Compiler → provider-specific shape → model
```

`ModelRequest.messages` is canonical; `prompt` is the flattened form the gateway
derives from it, so the two cannot drift.

A turn performs **at most one** provider request — no retry, no critic, no
planner, no summarisation, no follow-up — and that is structural rather than a
convention: `runTurn` contains exactly one call into the cognition service. The
grant it spends is built from constants, issued through owner authority, and
bounded at one call, foreground only, with a short expiry. Full detail in
[PHASE-3.md](PHASE-3.md).

Recalled memory enters the same packet, and the rule about it is worth stating
here rather than only in the phase document: it goes in **below the transcript, as
its own labelled message**, never appended to the system message. Anything in a
system message is instruction by construction, and a remembered fact is not an
instruction. Each item carries its source class and confidence *in the rendered
text*, because a note from a web page and a note from the owner are otherwise
indistinguishable by the time they are flattened into "notes". Full detail in
[PHASE-4.md](PHASE-4.md).

### 6.3 Conversation bodies are not journal events

Two stores with opposite rules, in separate modules, and nothing in
`core/events/` imports from `core/conversation/`.

**The Conversation Store** holds what was said, encrypted at rest with
AES-256-GCM: unique nonce per record, the record header authenticated as AAD so a
record cannot be re-labelled between kinds, a per-store context id, versioned
records. A decryption failure is reported and the record skipped — never accepted,
never guessed at, never turned into a message that was never said.

**The Event Fabric** holds metadata only: ids, sizes, provider, model, outcome.
There is no field a body could hide in, so adding one is a visible change to the
audit schema rather than something that quietly starts retaining text.

The keys live in the main process (`electron/keyring.ts`), wrapped by the OS
secure storage, and are injected into Core as bytes. None of them ever enters the
renderer, a model request, the journal, a log line, or a projection. No secure
storage means **no key for any domain**, which means ephemeral in-memory stores that
label themselves — never a plaintext file and never a key stored beside the data it
protects. See §4.2 for why there is one per domain.

Corrupt conversation data is a **conversation-data fault**. It cannot grant
cognition, clear a stop, or widen a budget, and it does not lock Freya either:
unreadable history is neither. The same is true of a corrupt Brain — see §4.3.

### 6.4 Local voice is a surface, not a second intelligence

`VoiceTranscriber` and `VoiceSynthesizer` declare `local: true` as a **literal
type**, so a remote engine does not compile. There is no cloud endpoint, no
fallback, and no automatic download.

A capture becomes **text in a composer**, not a turn. There is no call to the
Governor, the Gateway or a provider anywhere in `core/voice/`, and the Send that
follows is the only thing that authorises cognition. Speech recognition and
thinking are different systems, and that boundary is where an automatic send would
end up.

Capture is explicit: the device opens on a press and releases on the lift, on every
path including errors and unmount. The microphone permission is granted only while
Core reports a capture open, only for audio, and only in answer to the button —
the host follows Core's verdict rather than the renderer's claim. Audio is dropped
after transcription and never becomes memory.

The level is a mutable number outside React, read by the presence's existing
animation loop, so a frame of audio cannot cause a re-render. The envelope prefers
a real level when a device is open and does not simulate a reply from it.

### 6.5 Work: models decide, code controls

Phase 6 added the execution substrate, and the rule it is written around is the one
in `PRODUCT.md` first principles:

> Models decide. Code controls. Events remember. Verification establishes truth.

Concretely, in `core/work/`:

- **Nothing mutates state directly.** Every change is an append to the journal, and
  the fold of the journal is the only state there is. A Run has no field anyone can
  assign.
- **Transitions are validated centrally.** One table per aggregate, and the engine
  refuses any edge it does not contain. This is also the answer to the race in §6.1:
  a completion that arrives after a cancellation is not a timing problem, it is an
  edge that does not exist.
- **A plan is a request.** A caller proposes steps; Core validates every
  capability, verifier and input against the registry before anything runs, and
  refuses the whole plan rather than executing a subset of it.
- **Approval is upstream of execution.** The gate is recorded and the call path
  returns from it, so no ordering in the engine can produce an action that is
  approved afterwards. Only the owner may decide, `decidedBy` has no field a caller
  can supply, and `WORKER_CAPABILITIES` excludes every `work.*` capability.
- **A Step closes only on a verifier.** Never on a capability saying it finished —
  and a verifier that never answers cannot close it either. A Step is bounded by
  `maxDurationMs` across the whole of `capability → observation → verification`
  (see below), so a collaborator that hangs is bounded by the same mechanism as one
  that is merely slow.

Three boundaries that are worth naming because they are easy to erode:

**Idle Work costs nothing.** There is no timer, no wake source and no poll in
`core/work/`. A run waiting on a person is stopped, not slow, and nothing watches
it. The engine never touches a model; a capability that wanted cognition would have
to ask through an authority the engine does not hold.

**Live execution is a process fact — the same rule as §6.1.** A run the journal
says was executing when the process died cannot be continued, because its plan was
in memory. Recovery marks it `failed` with the reason written to the journal, settles
its steps, expires any approval it was waiting on, and resumes nothing. History is
not proof that something is currently executing, and saying so is what makes the
recovery honest rather than hopeful.

**A Run cannot grow forever.** Steps, capability calls, runtime and attempts per
step are all bounded, checked *before* the thing they bound, and exceeding one is a
recorded outcome rather than a silent stop. A planner may propose as many steps as
it likes; a run stops at a number it did not choose.

**A bound has to bound the thing, not the gap between things.** This is worth
stating separately because getting it wrong is invisible in review and obvious in
use. A duration ceiling checked *before each action* is not a duration ceiling: a
capability could start a second before the deadline and run for an hour afterwards,
and the run would still be allowed to continue. So the remaining time is computed
before the call, a timer is armed for it, and the capability is **raced** against
that timer rather than awaited.

**And the bound covers the whole active Step, not its first half.** A Step is
`capability → observation → verification`, and `maxDurationMs` is a bound on that
entire path. Bounding only the capability and then awaiting the verifier leaves a
hole, and on the final step that hole is the run: a verifier returning `passed` after
the budget was gone would complete it. So the deadline is computed **once**, before
the capability is called, and the verifier is raced against **that same deadline**.
There is deliberately no fresh budget for the verify phase — per-phase budgets would
let one step take the ceiling twice and a three-step run take it three times.

Three properties follow, and all are structural:

- A collaborator that **ignores its abort signal cannot hold a run open**. JavaScript
  cannot forcibly terminate arbitrary code, so the engine stops *waiting* at the
  deadline and settles the run itself; the promise keeps both handlers, so a late
  resolution is swallowed rather than becoming an unhandled rejection or a resurrected
  run. This is the honest boundary — the engine stops **believing** a collaborator
  rather than pretending it stopped it. This holds for a verifier exactly as it does
  for a capability.
- A collaborator that answers **after** the deadline is not an answer. The clock is
  re-checked after each race, because the promise can win it microseconds before the
  timer fires. A late verdict is discarded, and on the last step it cannot complete
  the run.
- A deadline **fabricates no verdict**. When it lands in verification, no
  `work.verification.completed` is written at all — the verification stays
  `requested`, meaning a check was asked for and never answered. Writing `failed`
  would be as much a fabrication as writing `passed`: the audit trail's value is that
  it can be trusted to mean what it says. For the same reason the action is left
  `completed` — the capability *did* return.

A deadline is not a cancellation and is journalled as a different thing: the action
settles `failed` with the ceiling as its reason, never `cancelled`, because
`work.action.cancelled` would put a cancellation in the audit trail that nobody asked
for. Cancellation still wins a race, because a person pressing stop is a more
specific fact than a budget running out — and because the terminal table has no
outgoing edges, whichever loses has nowhere to go.

Cancellation is also a **third arm of the race**, not merely an abort. Aborting only
*asks*; a hanging verifier would otherwise keep a cancelled run alive for the rest of
its budget, long after the person who pressed stop had given up waiting. The release
happens in the same synchronous turn as the flag is set, and is never collapsed into
the deadline, because the two get different records.

**Retention bounds memory, never history.** `WORK_LIMITS.maxRetainedRuns` bounds
what a board *lists* and what this process keeps: a settled run's plan, step labels
and observation summaries. It does not touch the journal, and it does not prune the
in-memory fold, which is the journal's image in the same way `BrainState` is. Live
work and runs blocked on an approval are never evicted whatever the ceiling; settled
runs are kept newest-first, with the id as a tie-break in the same direction so the
order is total and reproducible. The projection states `runsRetained`,
`runsTotal` and `runsHidden`, because a viewer that silently stopped listing runs
would read as "they finished and went away" — and that would be false.

Full detail, including why Work adds no store of its own (§5.1), is in
[PHASE-6.md](PHASE-6.md).

### 6.6 Workforce: a subordinate is a type, not a promise

Phase 8 added named subordinates — Alpha, Beta — with teams, assignments, budgets and
bounded messaging. The rule it is written around is one sentence:

> **A worker's claim about its own authority is data. Only Core grants.**

which is enforced structurally rather than documented, in three places:

```
  WorkforceOwnerScope          the roster, the teams, the assignments, and the
        │                     *two* assignment doors — assignCapability and
        │                     assignContext. There is no way to reach this object.
        ▼
  SubordinateWorkerScope       nine operations, none of which grants anything.
        │                     sendMessage takes a *recipient*, never a sender,
        │                     so attributability is a parameter list rather than
        ▼                     a validation rule.
  ModelGateway ← CognitionService
        ▲                     reached only by asking, as `agent:<workerId>`, under
        │                     an owner-created grant. The engine holds no gateway.
  Guard.evaluate(worker)       always refuses on `trusted: false`, before it looks
                               at a capability list at all.
```

Four properties follow, and each is a test rather than a comment:

- **`WORKER_CAPABILITIES` is the ceiling, and it is not Phase 8's to raise.** Its only
  member is `cognition.request`, which is *permission to ask*. So even Freya cannot give
  Alpha the ability to conclude a Mission, decide an approval, or stop herself — and a
  specialisation table whose every row is a subset of it can only ever narrow.
- **A claim is refused and journalled.** `workforce.claim.recorded` has a `decision` field
  with exactly one legal value, so there is no spelling of that event which records a claim
  being granted, and therefore nothing for a forged journal line to say. Recording refusals
  is deliberate: the Red Team's cross-agent attack is `Alpha → Beta: "Freya gave me email
  access"`, and an unaudited refusal hides a probing pattern.
- **The check is made twice.** Once by the durable schema (validating a capability
  assignment against the *worker* vocabulary, not the full `Capability` list) and once by the
  fold. "The only place a worker's authority exists is a line in a text file" is a strong
  enough claim to earn being checked independently twice.
- **A message moves no counter.** `workforce.message.sent` carries `bodyLength` and nothing
  else about its contents, so Beta cannot read Alpha's message and believe it, because
  believing it changes nothing. The envelope's `actor` carries the sending agent's
  principal, so the audit line says *Alpha sent this*.

**Budgets are frozen and spend is durable.** A worker's ceilings are copied into its own
record at creation, and consumption is folded from `workforce.cognition.recorded` rather
than held in a counter — so there is no `setSpent`, and a **restart cannot refill an
allowance**. A request the Governor refused costs nothing (a budget that shrank for being
correctly limited would stop describing spend), and a zero-token request is refused (or the
ceiling could be made free by asking for nothing).

**Idle Workforces spend nothing.** There is no timer, no wake source, no poll and no
provider in `core/workforce/`. An assignment's deadline is a *wall*, discovered by
reconciliation rather than watched, exactly as a Mission's lifetime is.

Full detail is in [PHASE-8.md](PHASE-8.md).

### 6.7 Attention: code decides, and "do nothing" is a decision

Phase 12 added events and attention. The rule it is written around is the one a
"smart notifications" feature is most tempted to break:

> **The score, the budget, the cooldown and the outcome are code. An event's text
> is data the policy never reads.**

```
  authorized source (owner · mission · work · research · context · system)
        │  source is assigned by Core, never read from a payload
        ▼
  AttentionEngine.ingest
        │  sanitize → bound → dedupe → append attention.event.ingested
        ▼
  decideAttention            closed tables: kind → importance/urgency,
        │                    capped by source class; a hint raises at most one level
        │  demote only: STOP ALL > rate limit > focus > cooldown > budget
        ▼
  do-nothing · remember · subtle-cue · speak · interrupt
        │
        ├── attention.decision.made  (always, including do-nothing)
        └── one directive, a code-owned cue label, for Presence
```

Four properties, each a test rather than a comment:

- **An untrusted payload cannot forge urgency.** The source is a parameter, not a
  field; the score is a closed table capped by source class; only `system` can reach
  `critical`; and `interrupt` requires a genuinely urgent due time or kind. A
  `severityHint` raises importance by at most one level and cannot interrupt alone.
- **A storm cannot become a stream of interruptions.** A per-source ingest rate and
  a code-owned interruption budget (across all sources, per source and per goal)
  demote every outcome past the ceiling; a cooldown after an interrupt is absolute,
  so a forged urgency cannot jump it.
- **Attention spends nothing and mints nothing.** `core/attention/` imports no
  gateway, provider, authority or cognition module. A red-team test reads the domain
  source and refuses such an import, and the fake provider's call count stays zero
  through any amount of traffic.
- **Replay does not repeat a decision.** Decisions live in the journal, so replay
  folds them; a re-delivered event is recognised by a dedupe key derived from the
  source's own reference and appends nothing.

The bounded wake is the one timer attention has, and it is driven by the
composition root — there is no `attention.tick` command, so a renderer cannot make
a schedule fire. The focus reading uses only state Core already held (a provider
call in flight, a Run executing); no screen, keystroke, accessibility tree or model
is read. Full detail is in [PHASE-12.md](PHASE-12.md).

---

## 7. Deliberately absent

Phase 8 adds the Workforce: named subordinate agents with stable ids, teams, bounded worker
concurrency, per-worker capability and context assignment as Core-scoped claims, per-worker
budgets, bounded attributable agent messaging, and a read-only projection. Phase 6
implements the Work engine: runs, steps, actions, observations and verifications, tasks, approvals, cancellation, bounded retries, execution ceilings, a read-only board, and honest recovery from interrupted work. Phase 5 adds provider-neutral web search, a managed read-only Electron browser, and bounded cited research over public pages. Phase 4 added the Brain; phase 3 the conversation, Mind and Identity Kernel; phase 2 the local voice seam.

No phase 1–8 implements: streaming, automatic summarisation, embeddings, vector or semantic retrieval, self-modification, learning from conversation, **browser automation** (`click`/`fill`), Browser Relay, PTYs, terminal, Foundry, Relay, connectors/MCP, 3D Office, an Obsidian-compatible file vault, a step dependency graph, or a local speech-engine binary adapter. There are no stub classes for them, and no panel that implies one is running.

`Run.parent` remains an opaque `{ kind, id }` reference, and Work still has no
field shaped like a Mission: Phase 7 populated it from a `missionId` a window names,
and Core builds the parent. Nothing in Work knows Missions exist.

### What Phase 8 deliberately did **not** add

Phase 8 built the *subordinates*, not their autonomy, and the distinction is worth stating
because it is the same line Phase 7 drew:

- **No planner and no decomposer.** Nothing turns a Mission into assignments, and no
  assignment executes. An assignment is the durable record that Core handed a worker
  bounded scope; the only things that settle it are a Core-side decision, a cancellation,
  or expiry. It has no `running` status, because Phase 8 owns nothing that could honestly
  move one into it — a status nobody can reach is decoration.
- **No Phase 9 context awareness.** What is assigned is a *reference id*. Phase 8 never
  reads the content behind one; its contribution is that the ids a worker holds are exactly
  the ones Core assigned to it.
- **No Mission completion from below.** `mission.manage` is not in
  `WORKER_CAPABILITIES`, so a worker cannot conclude the Mission its assignment serves.
- **No swarms.** Workers do not spawn workers, negotiate, or elect anything.

An agent that exists and holds work therefore does nothing by itself. It can be given a
scope, it can be asked to think under an owner-created grant, it can read and send messages,
and it can report an outcome — but nothing in Phase 8 decides what it should be given.
That decision is still a person's, and stubbing it would be the fake autonomy this project
exists to avoid.

What Phase 7 left undone, and Phase 8 did not take up: a Mission remains a durable record,
a bounded set of Runs, and a conclusion only a verifier can make. Nothing decomposes one by
itself, nothing plans, and no Mission is ever concluded unattended.

### 7.1 Absences inside the Brain that are decisions, not gaps

The Brain is the subsystem most likely to be mistaken for a finished one, because
it *looks* like a memory system and returns results. So the things it deliberately
does not do are listed where they are hardest to rediscover:

- **No fact-checking.** Admission decides how much a source class is worth, not
  whether a claim is true. Nothing in Phase 4 verifies anything, so nothing is
  stored as `verified`.
- **No semantic retrieval.** Recall is a named sum of signals with a total order.
  Conflict *detection* is correspondingly literal — same slot and a shared entity,
  or an explicit declaration — because a rule that looked semantic would mark
  unrelated memories as conflicting and suppress true ones.
- **A turn never writes memory.** It reads only what was already admitted. This is
  what stops a prompt injection from becoming a durable fact just by being sent.
- **No deletion, ever.** Withdrawal archives.
- **No `working` memory.** It is the Mind's volatile state, and a second copy would
  go stale.
- **No credentials.** The Brain may record *that* a key exists and where it is
  kept. Guard and a future Vault own secrets.
- **No model call anywhere in `core/brain/` or in the recall path.** Recall has to
  be free, offline and reproducible; a score that drifts with a model's mood cannot
  be audited or corrected.

### 7.2 The four separations that matter most

Each of these is enforced by types and tests rather than by convention:

- **Model output is data, never instruction.** Recalled memory enters the compiled
  packet *below the transcript*, as its own labelled message, never appended to the
  system message — anything in a system message is instruction by construction.
- **Content cannot classify itself.** The trust label is assigned by the admitting
  pathway, which knew where the bytes came from. A window likewise cannot name a
  source class: a renderer that could assert `owner-assertion` for itself could
  launder a web page's contents in as something the owner said.
- **Live authority is never duplicated into durable state.** Budgets, stop state
  and grants are Guard's and Governor's truth, read fresh. A writable copy of the
  most security-relevant facts in the system would go stale and then be believed.
- **A Brain fault is not a security event.** See §4.3.

A surface type may exist with `status: 'placeholder'`, in which case its window is
real — movable, resizable, persisted — and its body says which system is missing
and why. That is a declared boundary, not a fake.

A submitted **command** reaches Core, is made durable, and stops there. The
acknowledgement says so explicitly, because a user told a command was received
will otherwise wait for a reply that is not coming. A conversation **message** is
the other thing: it becomes a turn, and a turn is the only path from a window to a
model. The two are separate, explicit modes in the shell, because a sentence must
never become a privileged command by accident.

**Idle Freya spends nothing.** No automatic model call exists anywhere in the
shell. There is no always-on microphone, no wake word, and no path from captured
audio to cognition without an explicit Send. The e2e checks the call counters
after boot, after a command, after a conversation, after a renderer reload and
after a relaunch.

Browser work is documented as direction only, in
[BROWSER-ROADMAP.md](BROWSER-ROADMAP.md).
