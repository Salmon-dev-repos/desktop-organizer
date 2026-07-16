# Monitor-aware Layout Preservation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve the canonical (docked) card layout across monitor disconnect/reconnect — never persist an OS-forced move, auto-tidy orphaned cards onto the laptop screen while undocked, restore the exact layout on redock.

**Architecture:** A pure `displayLayout` module holds all geometry/decision logic (unit-tested under `node --test`). A new `displayManager` subscribes to Electron `screen` events, debounces them, and drives `windowManager` primitives to reflow/restore. `windowManager` gains a three-layer persistence guard so OS-forced moves and undocked drags never overwrite `section.bounds`.

**Tech Stack:** Electron 32 (main process), Node's built-in `node:test` runner (no new dependencies).

## Global Constraints

- Windows-targeted app; native pinning is Win32-only and already degrades gracefully off-Windows. Do **not** add code that assumes a display/hardware at test time.
- No new npm dependencies. Tests use `node:test` + `node:assert` only.
- No `config.json` schema change and no migration. `section.bounds` is the canonical layout; the store already persists it.
- `src/main/displayLayout.js` MUST have **zero** `require('electron')` (or any Electron) imports — it must load under plain Node.
- Geometry constants used by the reflow/visibility logic: `HEADER_H = 46`, `GRAB_W = 60`, `MARGIN = 24`, `GAP = 16`.
- Persist-guard rule: a move persists only when NOT displaced AND NOT programmatic-suppressed AND NOT within the settling window.

---

### Task 1: Pure `displayLayout` module + unit tests

**Files:**
- Create: `src/main/displayLayout.js`
- Create: `test/displayLayout.test.js`
- Modify: `package.json` (add `"test"` script)

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces:
  - `isVisible(canonical, displays) → boolean` where `canonical` is `{x,y,width,height}` and each display is `{id, bounds, workArea, scaleFactor}`.
  - `planReflow(orphans, workArea) → [{id, bounds:{x,y,width,height}}]` where `orphans` is `[{id, width, height, ...}]`.
  - `reconcilePlan({sections, displays, displaced, primaryWorkArea}) → {restore:[{id,bounds}], reflow:[{id,bounds}], leave:[id]}`. `sections` is `[{id, bounds, collapsed}]`; `displaced` is a `Set<id>`.
  - `shouldPersistMove({displaced, suppress, settling}) → boolean`.
  - Exported constants: `HEADER_H, GRAB_W, MARGIN, GAP`.

- [ ] **Step 1: Add the test script to `package.json`**

In the `"scripts"` block, add a `test` entry (place it after `"start"`):

```json
    "test": "node --test",
```

- [ ] **Step 2: Write the failing test file**

Create `test/displayLayout.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const layout = require('../src/main/displayLayout');

const LAPTOP = {
  id: 1, scaleFactor: 1,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1040 },
};
const EXTERNAL = {
  id: 2, scaleFactor: 1,
  bounds: { x: 1920, y: 0, width: 1920, height: 1080 },
  workArea: { x: 1920, y: 0, width: 1920, height: 1040 },
};

test('isVisible: external card is hidden when only the laptop is present', () => {
  assert.equal(layout.isVisible({ x: 2400, y: 100, width: 340, height: 280 }, [LAPTOP]), false);
});

test('isVisible: external card is visible when the external is present', () => {
  assert.equal(layout.isVisible({ x: 2400, y: 100, width: 340, height: 280 }, [LAPTOP, EXTERNAL]), true);
});

test('isVisible: laptop card is visible while docked', () => {
  assert.equal(layout.isVisible({ x: 100, y: 100, width: 340, height: 280 }, [LAPTOP, EXTERNAL]), true);
});

test('reconcilePlan: undock orphans the external card, keeps the laptop card, leaves canonical untouched', () => {
  const sections = [
    { id: 'A', bounds: { x: 100, y: 100, width: 340, height: 280 }, collapsed: false },
    { id: 'B', bounds: { x: 2400, y: 100, width: 340, height: 280 }, collapsed: false },
  ];
  const plan = layout.reconcilePlan({
    sections, displays: [LAPTOP], displaced: new Set(), primaryWorkArea: LAPTOP.workArea,
  });
  assert.deepEqual(plan.leave, ['A']);
  assert.equal(plan.reflow.length, 1);
  assert.equal(plan.reflow[0].id, 'B');
  const b = plan.reflow[0].bounds;
  assert.ok(b.x >= LAPTOP.workArea.x && b.x + b.width <= LAPTOP.workArea.x + LAPTOP.workArea.width);
  assert.equal(b.width, 340);
  assert.equal(b.height, 280);
  // the source section bounds must not be mutated
  assert.deepEqual(sections[1].bounds, { x: 2400, y: 100, width: 340, height: 280 });
});

test('reconcilePlan: redock restores a displaced card to its EXACT canonical bounds', () => {
  const sections = [
    { id: 'B', bounds: { x: 2400, y: 100, width: 340, height: 280 }, collapsed: false },
  ];
  const plan = layout.reconcilePlan({
    sections, displays: [LAPTOP, EXTERNAL], displaced: new Set(['B']), primaryWorkArea: LAPTOP.workArea,
  });
  assert.equal(plan.reflow.length, 0);
  assert.equal(plan.restore.length, 1);
  assert.deepEqual(plan.restore[0], { id: 'B', bounds: { x: 2400, y: 100, width: 340, height: 280 } });
});

test('planReflow: multiple orphans get non-overlapping positions inside the work area', () => {
  const orphans = ['A', 'B', 'C'].map((id) => ({ id, width: 340, height: 280 }));
  const out = layout.planReflow(orphans, LAPTOP.workArea);
  assert.equal(out.length, 3);
  for (let i = 0; i < out.length; i++) {
    for (let j = i + 1; j < out.length; j++) {
      const a = out[i].bounds, b = out[j].bounds;
      const overlap = a.x < b.x + b.width && b.x < a.x + a.width &&
                      a.y < b.y + b.height && b.y < a.y + a.height;
      assert.equal(overlap, false, `${out[i].id} overlaps ${out[j].id}`);
    }
  }
});

test('planReflow: wraps to a new row when a card would exceed work-area width', () => {
  const narrow = { x: 0, y: 0, width: 800, height: 1040 };
  const orphans = [0, 1, 2].map((i) => ({ id: `c${i}`, width: 340, height: 280 }));
  const out = layout.planReflow(orphans, narrow);
  const rows = new Set(out.map((o) => o.bounds.y));
  assert.ok(rows.size >= 2, 'expected the third card to wrap onto a second row');
});

test('shouldPersistMove: only a genuine at-home drag persists', () => {
  assert.equal(layout.shouldPersistMove({ displaced: false, suppress: false, settling: false }), true);
  assert.equal(layout.shouldPersistMove({ displaced: true,  suppress: false, settling: false }), false);
  assert.equal(layout.shouldPersistMove({ displaced: false, suppress: true,  settling: false }), false);
  assert.equal(layout.shouldPersistMove({ displaced: false, suppress: false, settling: true  }), false);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/main/displayLayout'`.

- [ ] **Step 4: Implement `displayLayout.js`**

Create `src/main/displayLayout.js`:

```js
// Pure geometry + decisions for monitor-aware layout. NO Electron imports — this
// module must load under plain Node so it is unit-testable without a display.
//
// Vocabulary:
//   canonical  - a section's saved bounds (the docked layout; source of truth)
//   visible    - the canonical rect overlaps some connected display enough to grab
//   orphaned   - not visible on any connected display (its monitor was unplugged)
//   displaced  - currently shown at a transient reflow spot (in-memory flag)

const HEADER_H = 46; // mirrors windowManager.HEADER_H (collapsed card height)
const GRAB_W = 60;   // min horizontal overlap to count a card as grabbable
const MARGIN = 24;   // outer gap from the work-area edges when tidying
const GAP = 16;      // gap between tidied cards

// Signed overlap of two rects on each axis (negative = a gap between them).
function overlap(rect, area) {
  const ix = Math.min(rect.x + rect.width, area.x + area.width) - Math.max(rect.x, area.x);
  const iy = Math.min(rect.y + rect.height, area.y + area.height) - Math.max(rect.y, area.y);
  return { ix, iy };
}

// A card is visible if it overlaps SOME display's workArea by at least GRAB_W
// wide and HEADER_H tall — enough to see and drag its header.
function isVisible(canonical, displays) {
  return displays.some((d) => {
    const { ix, iy } = overlap(canonical, d.workArea);
    return ix >= GRAB_W && iy >= HEADER_H;
  });
}

// Tidy orphaned cards into a left-to-right, top-to-bottom grid inside workArea.
// Each card keeps its own width/height. Wraps to a new row at the right edge and
// clamps the header on-screen if it would overflow the bottom.
function planReflow(orphans, workArea) {
  const out = [];
  const left = workArea.x + MARGIN;
  const rightLimit = workArea.x + workArea.width - MARGIN;
  const bottomLimit = workArea.y + workArea.height - MARGIN;
  let x = left;
  let y = workArea.y + MARGIN;
  let rowH = 0;
  for (const o of orphans) {
    if (x + o.width > rightLimit && x > left) {
      x = left;
      y += rowH + GAP;
      rowH = 0;
    }
    const cy = Math.min(y, Math.max(workArea.y, bottomLimit - HEADER_H));
    out.push({ id: o.id, bounds: { x, y: cy, width: o.width, height: o.height } });
    x += o.width + GAP;
    rowH = Math.max(rowH, o.height);
  }
  return out;
}

// Decide, per section, what to do given the current display set. Pure — never
// mutates the inputs; returns intended actions only.
function reconcilePlan({ sections, displays, displaced, primaryWorkArea }) {
  const restore = [];
  const leave = [];
  const orphanInputs = [];
  for (const s of sections) {
    const c = s.bounds;
    if (isVisible(c, displays)) {
      if (displaced.has(s.id)) {
        restore.push({ id: s.id, bounds: { x: c.x, y: c.y, width: c.width, height: c.height } });
      } else {
        leave.push(s.id);
      }
    } else {
      orphanInputs.push({
        id: s.id, x: c.x, y: c.y,
        width: c.width, height: s.collapsed ? HEADER_H : c.height,
      });
    }
  }
  // Preserve rough reading order so the tidy grid feels familiar.
  orphanInputs.sort((a, b) => (a.y - b.y) || (a.x - b.x));
  const reflow = planReflow(orphanInputs, primaryWorkArea);
  return { restore, reflow, leave };
}

// A move is only persisted when it is a genuine, at-home user drag.
function shouldPersistMove({ displaced, suppress, settling }) {
  return !displaced && !suppress && !settling;
}

module.exports = {
  HEADER_H, GRAB_W, MARGIN, GAP,
  isVisible, planReflow, reconcilePlan, shouldPersistMove,
};
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — all 8 tests green.

- [ ] **Step 6: Commit**

```bash
git add src/main/displayLayout.js test/displayLayout.test.js package.json
git commit -m "feat: pure displayLayout module (visibility, reflow, persist-guard) + tests"
```

---

### Task 2: `windowManager` persistence guard + apply primitives

**Files:**
- Modify: `src/main/windowManager.js`

**Interfaces:**
- Consumes: `displayLayout.shouldPersistMove` (Task 1).
- Produces (new exports for Task 3):
  - `beginSettling(ms = 2000)` — start the settling window and flush pending move-persists.
  - `applyTransientBounds(id, bounds)` — move a card to a transient (reflow) spot; marks it displaced, never persists.
  - `restoreCanonical(id)` — move a card back to its stored bounds; clears displaced.
  - `displacedIds() → Set<id>` — ids currently displaced.

- [ ] **Step 1: Import `displayLayout` and add settling state**

In `src/main/windowManager.js`, after the existing `const desktopPin = require('./desktopPin');` line (near line 14), add:

```js
const displayLayout = require('./displayLayout');
```

Then, next to the other module-level state (near `const movedTimers = new Map();`, line 23), add:

```js
let settlingUntil = 0; // Date.now() ms until which OS-forced moves are ignored
```

- [ ] **Step 2: Gate `scheduleMovedPersist` behind the guard**

Replace the body of `scheduleMovedPersist` (currently lines ~215-227). The only change is the added guard check at the top of the timer callback:

```js
function scheduleMovedPersist(id, win) {
  clearTimeout(movedTimers.get(id));
  movedTimers.set(id, setTimeout(() => {
    if (win.isDestroyed()) return;
    // Never let an OS-forced move (monitor unplug), a programmatic reflow/restore,
    // or a drag while displaced overwrite the canonical layout.
    const persist = displayLayout.shouldPersistMove({
      displaced: !!win.__displaced,
      suppress: !!win.__suppressPersist,
      settling: Date.now() < settlingUntil,
    });
    if (!persist) return;
    const s = store.getSection(id);
    if (!s) return;
    const wb = win.getBounds();
    const patch = { x: wb.x, y: wb.y, width: wb.width };
    if (!s.collapsed) patch.height = wb.height; // preserve expanded height while collapsed
    store.patchSection(id, { bounds: { ...s.bounds, ...patch } });
    pushState(id);
  }, 140));
}
```

- [ ] **Step 3: Add `beginSettling` and the apply primitives**

Insert these functions immediately after `scheduleMovedPersist` (before `liveState`):

```js
// Called synchronously the moment a display change is detected: suppress move
// persistence for a window of time AND flush any queued move-persists, so an
// OS-forced relocation that already fired can't be written before we react.
function beginSettling(ms = 2000) {
  settlingUntil = Date.now() + ms;
  for (const t of movedTimers.values()) clearTimeout(t);
  movedTimers.clear();
}

// Move a card to a transient (auto-tidy) position. Marks it displaced and
// suppresses persistence so section.bounds (the canonical layout) is untouched.
function applyTransientBounds(id, bounds) {
  const win = sectionWindows.get(id);
  if (!win || win.isDestroyed()) return;
  win.__displaced = true;
  win.__suppressPersist = true;
  win.setBounds({
    x: Math.round(bounds.x), y: Math.round(bounds.y),
    width: Math.round(bounds.width), height: Math.round(bounds.height),
  });
  applyPin(win); // keep embedded/WorkerW cards on the desktop layer
  setImmediate(() => { if (!win.isDestroyed()) win.__suppressPersist = false; });
}

// Move a card back to its stored (canonical) bounds and clear the displaced flag.
function restoreCanonical(id) {
  const win = sectionWindows.get(id);
  const s = store.getSection(id);
  if (!win || win.isDestroyed() || !s) return;
  win.__suppressPersist = true;
  win.setBounds({
    x: Math.round(s.bounds.x), y: Math.round(s.bounds.y),
    width: Math.round(s.bounds.width),
    height: s.collapsed ? HEADER_H : Math.round(s.bounds.height),
  });
  applyPin(win);
  win.__displaced = false;
  setImmediate(() => { if (!win.isDestroyed()) win.__suppressPersist = false; });
}

// Ids of windows currently shown at a transient position.
function displacedIds() {
  const out = new Set();
  for (const [id, win] of sectionWindows) {
    if (!win.isDestroyed() && win.__displaced) out.add(id);
  }
  return out;
}
```

- [ ] **Step 4: Export the new functions**

In the `module.exports = { ... }` block (near line 370), add the four new names. Change:

```js
  setBoundsFromRenderer, setCollapsed,
```

to:

```js
  setBoundsFromRenderer, setCollapsed,
  beginSettling, applyTransientBounds, restoreCanonical, displacedIds,
```

- [ ] **Step 5: Syntax-check the file and re-run unit tests**

Run: `node --check src/main/windowManager.js`
Expected: no output (exit 0 = parses cleanly).

Run: `npm test`
Expected: PASS — Task 1 tests still green (this task adds no new pure logic; behavioral verification of the glue happens in Task 5's manual dev-trigger test).

- [ ] **Step 6: Commit**

```bash
git add src/main/windowManager.js
git commit -m "feat: persistence guard + transient/restore primitives in windowManager"
```

---

### Task 3: `displayManager` module + wire into app startup

**Files:**
- Create: `src/main/displayManager.js`
- Modify: `src/main/main.js`

**Interfaces:**
- Consumes: `windowManager.{beginSettling, applyTransientBounds, restoreCanonical, displacedIds}` (Task 2); `displayLayout.reconcilePlan` (Task 1); `store.listSections`; Electron `screen`.
- Produces:
  - `start()` — subscribe to display events + run one initial reconcile.
  - `simulate(mode)` — `'undock'` reconciles against `[primary]`; anything else reconciles against all displays. Dev/test entry point.

- [ ] **Step 1: Create `displayManager.js`**

Create `src/main/displayManager.js`:

```js
// Watches the monitor configuration and keeps cards visible + faithful to the
// canonical (docked) layout. On undock, orphaned cards are auto-tidied onto the
// laptop screen (transient, never saved); on redock they snap back exactly.
const { screen } = require('electron');
const store = require('./store');
const wm = require('./windowManager');
const layout = require('./displayLayout');

const DEBOUNCE_MS = 300; // docking fires a burst of display events; collapse them

let started = false;
let debounceTimer = null;
let lastSignature = '';

// Stable string identifying a display configuration, so we can skip no-op churn.
function signatureOf(displays) {
  return displays
    .map((d) => `${d.id}:${d.bounds.x},${d.bounds.y},${d.bounds.width},${d.bounds.height}@${d.scaleFactor}`)
    .sort()
    .join('|');
}

// Where to tidy orphaned cards: the OS primary display, falling back to whatever
// display is actually in the given set (simulate('undock') passes a subset).
// NOTE (spec open question): swap to "largest remaining display" here if the
// laptop panel is not the Windows primary while docked.
function reflowArea(displays) {
  const primary = screen.getPrimaryDisplay();
  const target = displays.find((d) => d.id === primary.id) || displays[0] || primary;
  return target.workArea;
}

function reconcile(displays, opts = {}) {
  const list = displays || screen.getAllDisplays();
  const sig = signatureOf(list);
  if (!opts.force && sig === lastSignature) return;
  const plan = layout.reconcilePlan({
    sections: store.listSections(),
    displays: list,
    displaced: wm.displacedIds(),
    primaryWorkArea: reflowArea(list),
  });
  for (const r of plan.restore) wm.restoreCanonical(r.id);
  for (const r of plan.reflow) wm.applyTransientBounds(r.id, r.bounds);
  lastSignature = sig;
}

function onDisplayEvent() {
  wm.beginSettling(); // synchronous: stop OS-forced moves from being persisted
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => reconcile(), DEBOUNCE_MS);
}

function start() {
  if (started) return;
  started = true;
  screen.on('display-added', onDisplayEvent);
  screen.on('display-removed', onDisplayEvent);
  screen.on('display-metrics-changed', onDisplayEvent);
  // Initial pass covers launching while already undocked. Delayed so section
  // windows (opened asynchronously) exist; reconcile is idempotent regardless.
  setTimeout(() => reconcile(undefined, { force: true }), 500);
}

// Dev/test trigger — drive the whole flow without unplugging hardware.
function simulate(mode) {
  wm.beginSettling();
  if (mode === 'undock') reconcile([screen.getPrimaryDisplay()], { force: true });
  else reconcile(screen.getAllDisplays(), { force: true });
}

module.exports = { start, simulate };
```

- [ ] **Step 2: Wire `displayManager.start()` into `main.js`**

In `src/main/main.js`, add the require alongside the other module requires (after `const portal = require('./folderPortal');`, line 8):

```js
const displayManager = require('./displayManager');
```

Then in `start()`, immediately after the `portal.startAll();` line (line 82), add:

```js
  displayManager.start();
```

- [ ] **Step 3: Syntax-check both files and re-run unit tests**

Run: `node --check src/main/displayManager.js && node --check src/main/main.js`
Expected: no output (both parse cleanly).

Run: `npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/main/displayManager.js src/main/main.js
git commit -m "feat: displayManager watches monitor changes and reflows/restores cards"
```

---

### Task 4: Developer "Simulate undock/redock" tray items

**Files:**
- Modify: `src/main/tray.js`

**Interfaces:**
- Consumes: `displayManager.simulate` (Task 3); Electron `app.isPackaged`.
- Produces: no new exports (menu wiring only).

- [ ] **Step 1: Require `displayManager` in the tray**

In `src/main/tray.js`, after `const autostart = require('./autostart');` (line 8), add:

```js
const displayManager = require('./displayManager');
```

- [ ] **Step 2: Add the Developer submenu (dev builds only)**

In the `template` array in `rebuild()`, insert a Developer block just before the final separator + Quit entry. Change:

```js
    { type: 'separator' },
    { label: 'Quit Desktop Organizer', click: () => { app.isQuiting = true; app.quit(); } },
  ];
```

to:

```js
    ...(!app.isPackaged ? [
      { type: 'separator' },
      {
        label: 'Developer',
        submenu: [
          { label: 'Simulate undock (laptop only)', click: () => displayManager.simulate('undock') },
          { label: 'Simulate redock', click: () => displayManager.simulate('redock') },
        ],
      },
    ] : []),
    { type: 'separator' },
    { label: 'Quit Desktop Organizer', click: () => { app.isQuiting = true; app.quit(); } },
  ];
```

- [ ] **Step 3: Syntax-check the file**

Run: `node --check src/main/tray.js`
Expected: no output (parses cleanly).

- [ ] **Step 4: Commit**

```bash
git add src/main/tray.js
git commit -m "feat: dev-only tray items to simulate undock/redock"
```

---

### Task 5: Full verification + README note

**Files:**
- Modify: `README.md`

**Interfaces:** none.

- [ ] **Step 1: Run the full unit suite**

Run: `npm test`
Expected: PASS — all displayLayout tests green.

- [ ] **Step 2: Manual verification on the Windows laptop (dev build)**

Document result inline in the PR/commit. Steps:
1. `npm run dev` with the external monitor **connected**. Place 2-3 cards on the external monitor and note their positions.
2. Tray → **Developer → Simulate undock (laptop only)**. Expected: the external-monitor cards tidy into a grid on the laptop screen; laptop cards stay put; `config.json` is unchanged (canonical bounds intact).
3. Tray → **Developer → Simulate redock**. Expected: every card snaps back to its exact original position.
4. Real hardware pass when convenient: physically unplug the monitor (expect auto-tidy), then replug (expect exact restore).

- [ ] **Step 3: Add a short README note**

In `README.md`, under the **Features** list, add a bullet after the "Persistent" line (line ~31):

```markdown
- **Monitor-aware** — undock a laptop and cards from a disconnected monitor
  auto-tidy onto the remaining screen; redock and every card snaps back to its
  exact saved position. Your layout is never lost on a monitor change.
```

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: note monitor-aware layout behavior in README"
```

---

## Self-Review

**Spec coverage:**
- Canonical `section.bounds` never overwritten by OS moves → Task 2 guard (settling + displaced + suppress). ✓
- Auto-tidy orphaned cards on the laptop → Task 1 `planReflow`/`reconcilePlan` + Task 3 apply. ✓
- Exact restore on redock → Task 1 `reconcilePlan` restore branch + Task 2 `restoreCanonical`. ✓
- Drag-while-undocked is transient → Task 2 displaced guard (covered by `shouldPersistMove` test). ✓
- No schema change → confirmed; only in-memory `__displaced`/`__suppressPersist` flags. ✓
- Display detection + debounce + signature skip → Task 3. ✓
- Dev trigger → Task 4. ✓
- Automated tests (any OS) → Task 1. ✓
- Edge cases (locked, collapsed, embedded, partial unplug, startup-undocked, rapid toggles) → collapsed handled in `reconcilePlan`/`restoreCanonical`; embedded via `applyPin`; startup via initial reconcile; rapid via debounce+signature; locked/partial fall out of canonical-based visibility. ✓

**Placeholder scan:** none — every code step contains full code.

**Type consistency:** `reconcilePlan` returns `{restore, reflow, leave}`; consumers in Task 3 read `plan.restore[].id`, `plan.reflow[].{id,bounds}`. `applyTransientBounds(id, bounds)` / `restoreCanonical(id)` / `displacedIds()` / `beginSettling()` names match across Tasks 2-3. `shouldPersistMove({displaced, suppress, settling})` keys match Task 2's call site. Note: `reconcilePlan` intentionally does **not** take `liveBounds` (the spec mentioned it, but the decision is canonical-based; dropped as unused — YAGNI).
