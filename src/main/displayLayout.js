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
// While cards fit, they form a clean non-overlapping grid. Once the grid can no
// longer fit a full card above the bottom edge, the remaining cards CASCADE
// (stacked-window style): each is offset by HEADER_H vertically so every title
// bar stays visible and grabbable, and no two share a position.
function planReflow(orphans, workArea) {
  const out = [];
  const left = workArea.x + MARGIN;
  const top = workArea.y + MARGIN;
  const rightLimit = workArea.x + workArea.width - MARGIN;
  const bottomLimit = workArea.y + workArea.height - MARGIN;

  let x = left;
  let y = top;
  let rowH = 0;
  let i = 0;

  // Phase 1 — clean grid for as many cards as fully fit.
  for (; i < orphans.length; i++) {
    const o = orphans[i];
    if (x + o.width > rightLimit && x > left) { x = left; y += rowH + GAP; rowH = 0; }
    const atOrigin = (x === left && y === top);
    if (y + o.height > bottomLimit && !atOrigin) break; // no room for a full card -> cascade
    out.push({ id: o.id, bounds: { x, y, width: o.width, height: o.height } });
    x += o.width + GAP;
    rowH = Math.max(rowH, o.height);
  }

  // Phase 2 — cascade the overflow into a bounded slot grid: rows step by
  // HEADER_H (title bars peek out), columns step sideways. Every (col,row) slot
  // is a distinct on-screen position, so cascade positions are unique up to
  // rows*cols cards (hundreds on a real screen). Beyond that capacity slots are
  // reused — an inherent limit of a finite area, far past any real section count.
  if (i < orphans.length) {
    const stepY = HEADER_H;
    const stepX = Math.max(1, Math.round(HEADER_H * 0.6));
    const originX = left + stepX; // offset so the first cascade card isn't hidden
    const originY = top + stepY;  // under the first grid card
    let maxW = 0;
    for (let j = i; j < orphans.length; j++) maxW = Math.max(maxW, orphans[j].width);
    const rows = Math.max(1, Math.floor((bottomLimit - HEADER_H - originY) / stepY) + 1);
    const cols = Math.max(1, Math.floor((rightLimit - maxW - originX) / stepX) + 1);
    const slots = rows * cols;
    for (let k = 0; i < orphans.length; i++, k++) {
      const o = orphans[i];
      const slot = k % slots;
      const row = slot % rows;
      const col = Math.floor(slot / rows);
      // The clamps are a no-op inside the computed slot grid; they only guard a
      // work area too small to hold even one on-screen slot.
      const cx = Math.min(originX + col * stepX, Math.max(left, rightLimit - o.width));
      const cy = Math.min(originY + row * stepY, Math.max(top, bottomLimit - HEADER_H));
      out.push({ id: o.id, bounds: { x: cx, y: cy, width: o.width, height: o.height } });
    }
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
