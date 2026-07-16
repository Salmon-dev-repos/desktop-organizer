# Monitor-aware layout preservation

**Date:** 2026-07-16
**Status:** Approved design — ready for implementation plan
**Component:** `src/main` (Electron main process)

## Problem

The app runs on a laptop that is frequently docked to / undocked from external
monitors. When an external monitor disconnects, the section layout is destroyed:
cards that lived on the (usually right-hand) external monitor get pushed off the
visible screen, and **their displaced positions are persisted to disk**, so
reconnecting the monitor does not bring the layout back. The user has to
re-organize every card on that side after every undock.

### Root cause

Two behaviors combine, and there is **no display-change handling anywhere in the
app** (no listeners on Electron's `screen` module for `display-added` /
`display-removed` / `display-metrics-changed`):

1. **OS-forced moves are persisted as if user-initiated.**
   `windowManager.js` wires `win.on('moved', () => scheduleMovedPersist(...))`.
   This fires for *any* move, including the relocations Windows forces when a
   monitor is removed. `scheduleMovedPersist` writes the new x/y to
   `config.json` ~140 ms later, overwriting the real layout.

2. **`clampBounds` only runs at window-creation time and clamps, not restores.**
   Off-screen cards are yanked to `area.x + area.width - 60` (a pile at the edge
   of the remaining screen), not to where they belonged.

Because the store keeps a single flat set of absolute virtual-desktop
coordinates, the app cannot distinguish a "2-monitor layout" from a
"laptop-only layout" — whichever event touched the coordinates last wins.

## Goal / chosen behavior

(Confirmed with the user.)

- **`section.bounds` is the canonical layout** — the docked arrangement, treated
  as read-only truth. It is written only by a genuine user drag/resize while the
  card is "at home."
- **On undock:** cards whose canonical position is no longer on any connected
  display ("orphaned") are **auto-tidied** into a neat grid on the laptop screen
  for visibility. This is transient and never written to `section.bounds`.
- **On redock:** the canonical layout is restored **exactly**.
- **Dragging a card while undocked** is transient and discarded on redock
  (because redock must restore the docked layout exactly).

Explicitly **out of scope** (user chose auto-tidy over this): remembering a
distinct, hand-arranged layout per monitor configuration. The design keeps this
extensible but does not build it (YAGNI).

## Constraints

- Windows-specific runtime behavior (native monitor hotplug, `koffi`/`user32`
  desktop pinning). Development happens on Linux, so the fix must be verifiable
  without physical monitor hotplug — via automated tests and an in-app dev
  trigger.
- No `config.json` schema change and no migration: the store already holds the
  canonical layout in `section.bounds`; the bug is only that OS-forced moves
  overwrite it.

## Architecture

Approach A: a dedicated main-process module owns all monitor-config logic, with
the pure decision logic factored out for testability. `windowManager.js` gains a
few small primitives it calls. Dependencies flow one way:
`displayManager → windowManager → store`; both `displayManager` and
`windowManager` import the pure `displayLayout` module. All edges point "down"
toward the pure/data layers — no import cycle.

### Modules

**`src/main/displayLayout.js` — NEW. Pure functions, zero Electron imports.**
Everything here is deterministic and unit-testable under plain `node --test` on
any OS.

- `isVisible(canonical, displays)` → boolean. A canonical rect is
  "visible/grabbable" if it overlaps some display's `workArea` by at least
  `GRAB_W` (≈60 px) horizontally and `HEADER_H` (46 px) vertically — enough to
  see and drag the header.
- `planReflow(orphans, primaryWorkArea)` → `Map<id, bounds>`. Grid layout for
  orphaned cards: sort by canonical `(y, then x)` to preserve rough reading
  order; place left-to-right, top-to-bottom with a margin (≈24 px) and gap
  (≈16 px), wrapping to a new row when the next card would exceed the work-area
  width; cascade with a small offset if it would overflow vertically so nothing
  lands fully off-screen. Each card keeps its canonical width/height (collapsed
  cards use `HEADER_H`).
- `reconcilePlan({ sections, liveBounds, displays, displaced, primaryWorkArea })`
  → `{ restore: [{id, bounds}], reflow: [{id, bounds}], leave: [id] }`.
  Pure decision function, no side effects:
  - For each section: if `isVisible(canonical, displays)` → if it is currently
    `displaced`, add to `restore` with its canonical bounds; else `leave`.
  - Collect the not-visible sections as orphans; feed them to `planReflow` and
    add the results to `reflow`.
- `shouldPersistMove({ displaced, suppress, settling })` → boolean.
  `false` if any of the three guards is active; otherwise `true`.

**`src/main/displayManager.js` — NEW. Electron glue.**

- `start()` — subscribe to `screen` `display-added` / `display-removed` /
  `display-metrics-changed`; run one initial `reconcile()` (idempotent, so safe
  even though section windows open asynchronously). Capture the current display
  signature.
- On any display event: **synchronously** call `windowManager.beginSettling()`
  (see guard below), then debounce (~300 ms — docking fires a burst of events)
  a single `reconcile()`.
- `reconcile(displays = screen.getAllDisplays())`:
  - Compute `signatureOf(displays)`; if unchanged from last applied, skip.
  - Gather `sections` from `store.listSections()`, `liveBounds` and the
    `displaced` set from `windowManager`, and `primaryWorkArea` from
    `screen.getPrimaryDisplay().workArea` (see open question below).
  - Call `displayLayout.reconcilePlan(...)`.
  - Apply: `windowManager.restoreCanonical(id)` for each `restore`;
    `windowManager.applyTransientBounds(id, bounds)` for each `reflow`; nothing
    for `leave`.
  - Schedule `endSettling()` shortly after applying.
- `simulate(mode)` — dev/test entrypoint. `'undock'` → `reconcile([primary])`;
  `'redock'` → `reconcile(screen.getAllDisplays())`. Lets the whole flow be
  driven live without unplugging hardware.
- `signatureOf(displays)` — stable string from each display's `id` + `bounds` +
  `scaleFactor`, used to detect real config changes and skip redundant work.

**`src/main/windowManager.js` — EDIT.** Gains the persist guard (it already owns
`movedTimers` and `scheduleMovedPersist`) and the apply primitives:

- Module-level `settlingUntil = 0`.
- `beginSettling(ms = 2000)` — set `settlingUntil = Date.now() + ms` **and clear
  all pending `movedTimers`** (flush queued OS-shove persists before they write).
  (`Date.now()` is fine in the app runtime.)
- `scheduleMovedPersist` fire-time callback consults
  `displayLayout.shouldPersistMove({ displaced: win.__displaced,
  suppress: win.__suppressPersist, settling: Date.now() < settlingUntil })`
  and bails without writing if it returns `false`.
- `applyTransientBounds(id, bounds)` — set `win.__displaced = true` and
  `win.__suppressPersist = true`, `win.setBounds(bounds)`, re-apply desktop pin
  (so embedded/WorkerW cards stay on the wallpaper layer), then clear
  `__suppressPersist` on the next tick.
- `restoreCanonical(id)` — `win.setBounds(store.getSection(id).bounds)` under the
  same suppression, re-apply pin, then clear `win.__displaced`.
- Expose a way to read live bounds + the displaced set for `reconcile` (e.g.
  `liveBoundsMap()` and `displacedIds()`), plus the existing `allIds()`.

**`src/main/main.js` — EDIT.** In `start()`, after seeding/creating section
windows, call `displayManager.start()`.

**`src/main/tray.js` — EDIT.** When `!app.isPackaged`, add a **Developer**
submenu with *"Simulate undock (laptop only)"* and *"Simulate redock"*, calling
`displayManager.simulate('undock' | 'redock')` directly (tray runs in the main
process — no IPC needed). Absent from the shipped installer.

**`package.json` — EDIT.** Add `"test": "node --test"`.

## Persistence guard (the correctness core)

Three layers, checked at the moment a persist would fire:

1. **Settling window.** The first display event synchronously sets
   `settlingUntil` and cancels pending `movedTimers`. A persist that fires inside
   the window is skipped. This absorbs OS-forced moves that happen around a dock
   change, including ones whose 140 ms timer was queued just before we detected
   the event.
2. **Displaced guard.** A `moved` on a `__displaced` card never persists →
   dragging while undocked is transient and discarded on redock.
3. **Programmatic guard.** `__suppressPersist` moves (our own reflow/restore)
   never persist.

A genuine user drag while docked/home trips none of these and persists exactly
as today.

## Data flow

**Undock:** `display-removed` fires → `beginSettling()` (flush pending persists)
→ debounce → `reconcile([remaining displays])` → orphaned right-side cards →
`applyTransientBounds` tidies them onto the laptop, `section.bounds` untouched →
persist stays suppressed.

**Redock:** `display-added` fires → `beginSettling()` → debounce →
`reconcile([all displays])` → each displaced card's canonical bounds are visible
again → `restoreCanonical` puts every card back to its exact saved spot →
`__displaced` cleared.

## Edge cases

- **Locked layout** still reflows/restores (lock only blocks *user* moves).
- **Collapsed cards** reflow at `HEADER_H` height.
- **Embedded/WorkerW cards** get re-pinned after each programmatic move.
- **2+ monitors, partial unplug** — only cards on the removed monitor orphan;
  the rest are `leave`.
- **Startup while undocked** — the initial idempotent `reconcile()` tidies any
  cards seeded/created off-screen; canonical bounds stay intact.
- **Rapid dock/undock** — absorbed by the ~300 ms debounce plus the
  display-signature equality check.

## Verification

**Automated (`test/displayLayout.test.js`, `node:test`, runs on Linux):**

1. Card fully on external (x≈2400) with `displays = [laptop]` → orphaned.
2. Card on laptop (x≈100) while docked → visible, `leave`.
3. Undock: orphan gets an on-screen, non-overlapping reflow position; canonical
   bounds unchanged in the plan.
4. Redock: a displaced card whose canonical is visible again appears in
   `restore` with its **exact** canonical bounds.
5. `planReflow`: N orphans get non-overlapping positions that wrap into rows and
   stay within the work area.
6. `shouldPersistMove` truth table: displaced / suppress / settling each force
   `false`; a genuine drag returns `true`.

**Manual (dev trigger, on the real laptop):** Tray → Developer → *Simulate
undock* → cards on the external monitor reflow onto the laptop screen; *Simulate
redock* → they snap back exactly. Plus a real plug/unplug test when convenient.

## Files

- NEW `src/main/displayLayout.js`
- NEW `src/main/displayManager.js`
- NEW `test/displayLayout.test.js`
- EDIT `src/main/windowManager.js`
- EDIT `src/main/main.js`
- EDIT `src/main/tray.js`
- EDIT `package.json`
- OPTIONAL `README.md` note on monitor-aware behavior

## Open questions / defaults chosen

- **Reflow target display.** Default: the OS **primary** display. If the laptop
  panel is not the Windows "primary" when docked, switch to "the largest
  remaining display after the drop." (Decide during implementation; trivial to
  swap since `reconcilePlan` takes `primaryWorkArea` as an argument.)
- **Settling window length.** Default ~2 s; tune if a slow dock takes longer to
  settle.
