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
