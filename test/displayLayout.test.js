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

test('planReflow: overflow cascades so every header stays on-screen and positions are distinct', () => {
  const area = { x: 0, y: 0, width: 900, height: 700 };
  const orphans = Array.from({ length: 20 }, (_, i) => ({ id: `o${i}`, width: 300, height: 250 }));
  const out = layout.planReflow(orphans, area);
  assert.equal(out.length, 20);
  // every position is distinct (no two cards land on the same spot)
  const seen = new Set();
  for (const o of out) {
    const key = `${o.bounds.x},${o.bounds.y}`;
    assert.ok(!seen.has(key), `duplicate position ${key} for ${o.id}`);
    seen.add(key);
  }
  // every title bar (HEADER_H tall, full width) is fully within the work area
  for (const o of out) {
    const b = o.bounds;
    assert.ok(b.x >= area.x, `${o.id} off left`);
    assert.ok(b.x + b.width <= area.x + area.width, `${o.id} off right`);
    assert.ok(b.y >= area.y, `${o.id} off top`);
    assert.ok(b.y + layout.HEADER_H <= area.y + area.height, `${o.id} header off bottom`);
  }
});

test('planReflow: heavy overflow fills distinct cascade slots across multiple columns', () => {
  const area = { x: 0, y: 0, width: 700, height: 400 };
  const orphans = Array.from({ length: 40 }, (_, i) => ({ id: `o${i}`, width: 200, height: 150 }));
  const out = layout.planReflow(orphans, area);
  assert.equal(out.length, 40);
  const seen = new Set();
  for (const o of out) {
    const key = `${o.bounds.x},${o.bounds.y}`;
    assert.ok(!seen.has(key), `duplicate position ${key} for ${o.id}`);
    seen.add(key);
  }
  for (const o of out) {
    const b = o.bounds;
    assert.ok(b.x >= area.x && b.x + b.width <= area.x + area.width, `${o.id} off horizontally`);
    assert.ok(b.y >= area.y && b.y + layout.HEADER_H <= area.y + area.height, `${o.id} header off vertically`);
  }
});
