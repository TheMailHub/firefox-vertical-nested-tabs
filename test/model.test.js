"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const M = require("../chrome/vertical-nested-tabs-model.js");

// Tabs are plain objects; identity is what matters.
function tabs(names) {
  return Object.fromEntries(names.map(n => [n, { name: n }]));
}

// Build a tree from an indented spec like ["A", " a1", "  a1x", " a2", "B"].
function build(spec) {
  const order = [];
  const parentOf = new Map();
  const stack = []; // [{ item, depth }]
  const byName = {};
  for (const line of spec) {
    const depth = line.length - line.trimStart().length;
    const name = line.trim();
    const item = { name };
    byName[name] = item;
    while (stack.length && stack[stack.length - 1].depth >= depth) {
      stack.pop();
    }
    parentOf.set(item, stack.length ? stack[stack.length - 1].item : null);
    stack.push({ item, depth });
    order.push(item);
  }
  return { order, parentOf, t: byName };
}

const names = arr => arr.map(x => x.name);

test("depthOf / ancestorsOf / isAncestor", () => {
  const { order, parentOf, t } = build(["A", " a1", "  a1x", "B"]);
  assert.equal(M.depthOf(parentOf, t.A), 0);
  assert.equal(M.depthOf(parentOf, t.a1), 1);
  assert.equal(M.depthOf(parentOf, t.a1x), 2);
  assert.deepEqual(names(M.ancestorsOf(parentOf, t.a1x)), ["a1", "A"]);
  assert.equal(M.isAncestor(parentOf, t.A, t.a1x), true);
  assert.equal(M.isAncestor(parentOf, t.a1x, t.A), false);
  assert.equal(M.isAncestor(parentOf, t.A, t.A), false);
  assert.equal(order.length, 4);
});

test("depthOf survives an accidental cycle", () => {
  const { A, B } = tabs(["A", "B"]);
  const parentOf = new Map([[A, B], [B, A]]);
  assert.equal(M.depthOf(parentOf, A), 1);
  assert.deepEqual(names(M.ancestorsOf(parentOf, A)), ["B"]);
});

test("childrenOf / descendantsOf / lastDescendant / subtree", () => {
  const { order, parentOf, t } = build(["A", " a1", "  a1x", " a2", "B", " b1"]);
  assert.deepEqual(names(M.childrenOf(order, parentOf, t.A)), ["a1", "a2"]);
  assert.deepEqual(names(M.descendantsOf(order, parentOf, t.A)), ["a1", "a1x", "a2"]);
  assert.equal(M.lastDescendant(order, parentOf, t.A), t.a2);
  assert.equal(M.lastDescendant(order, parentOf, t.b1), t.b1);
  assert.deepEqual(names(M.subtree(order, parentOf, t.A)), ["A", "a1", "a1x", "a2"]);
  assert.equal(M.hasChildren(order, parentOf, t.B), true);
  assert.equal(M.hasChildren(order, parentOf, t.b1), false);
});

test("isSubtreeContiguous and contiguityFixes", () => {
  const { order, parentOf, t } = build(["A", " a1", " a2", "B"]);
  assert.equal(M.isSubtreeContiguous(order, parentOf, t.A), true);
  // Move a2 to the end: A a1 B a2
  const broken = [t.A, t.a1, t.B, t.a2];
  assert.equal(M.isSubtreeContiguous(broken, parentOf, t.A), false);
  const fixes = M.contiguityFixes(broken, parentOf);
  assert.equal(fixes.length, 1);
  assert.equal(fixes[0].after, t.A);
  assert.deepEqual(names(fixes[0].items), ["a1", "a2"]);
  assert.deepEqual(M.contiguityFixes(order, parentOf), []);
});

test("reconcile drops links that no longer fit the strip order", () => {
  const { parentOf, t } = build(["A", " a1", "  a1x", "B", " b1"]);
  // Valid order: nothing dropped.
  assert.equal(M.reconcile([t.A, t.a1, t.a1x, t.B, t.b1], parentOf).size, 0);
  // a1 moved after B: A a1x B a1 b1.
  //  - a1x: its parent a1 comes later → dropped.
  //  - a1: its parent A is no longer an open ancestor (B intervened) → dropped, becomes a root.
  //  - b1: a1 is now a root sitting between B and b1, so B's subtree is not contiguous → dropped.
  const drop = M.reconcile([t.A, t.a1x, t.B, t.a1, t.b1], parentOf);
  assert.deepEqual(names([...drop]).sort(), ["a1", "a1x", "b1"]);
  // Same strip but with a1 kept as a child of B is valid: A a1x B a1(→B) b1.
  const p2 = new Map(parentOf);
  p2.set(t.a1, t.B);
  assert.deepEqual(names([...M.reconcile([t.A, t.a1x, t.B, t.a1, t.b1], p2)]), ["a1x"]);
  // Parent not in order at all → dropped.
  const drop2 = M.reconcile([t.a1, t.a1x], parentOf);
  assert.deepEqual(names([...drop2]), ["a1"]);
  assert.equal(drop2.has(t.a1x), false, "a1x still follows its parent a1");
});

test("wouldCreateCycle", () => {
  const { parentOf, t } = build(["A", " a1", "  a1x", "B"]);
  assert.equal(M.wouldCreateCycle(parentOf, t.A, t.a1x), true);
  assert.equal(M.wouldCreateCycle(parentOf, t.A, t.A), true);
  assert.equal(M.wouldCreateCycle(parentOf, t.a1x, t.B), false);
  assert.equal(M.wouldCreateCycle(parentOf, t.a1x, null), false);
});

test("parentForInsertedTab: neighbor rule", () => {
  const { order, parentOf, t } = build(["A", " a1", " a2", "B"]);
  const N = { name: "new" };
  const at = i => [...order.slice(0, i), N, ...order.slice(i)];
  // First in strip → root.
  assert.equal(M.parentForInsertedTab(at(0), parentOf, 0, true), null);
  // Appended at end, no opener → root (plain New Tab).
  assert.equal(M.parentForInsertedTab(at(4), parentOf, 4, false), null);
  // Appended at end with opener B → sibling of B (B is root) → root.
  assert.equal(M.parentForInsertedTab(at(4), parentOf, 4, true), null);
  // Between A and a1 (next is A's child) → child of A.
  assert.equal(M.parentForInsertedTab(at(1), parentOf, 1, false), t.A);
  // Between a1 and a2 → sibling of a1 → parent A.
  assert.equal(M.parentForInsertedTab(at(2), parentOf, 2, false), t.A);
  // Between a2 and B (after last descendant) → sibling of a2 → A.
  assert.equal(M.parentForInsertedTab(at(3), parentOf, 3, false), t.A);
  // Appended after a child at the very end with opener → that child's parent.
  const { order: o2, parentOf: p2, t: t2 } = build(["A", " a1"]);
  assert.equal(M.parentForInsertedTab([...o2, N], p2, 2, true), t2.A);
  assert.equal(M.parentForInsertedTab([...o2, N], p2, 2, false), null);
});

test("placementForDrop", () => {
  const { order, parentOf, t } = build(["A", " a1", "  a1x", " a2", "B"]);
  // Before a1 → parent A, before a1.
  assert.deepEqual(M.placementForDrop(order, parentOf, t.a1, true, false), {
    parent: t.A, before: t.a1, after: null,
  });
  // After expanded parent with children → first child.
  assert.deepEqual(M.placementForDrop(order, parentOf, t.A, false, false), {
    parent: t.A, before: null, after: t.A,
  });
  // After collapsed parent → sibling after its whole subtree.
  assert.deepEqual(M.placementForDrop(order, parentOf, t.A, false, true), {
    parent: null, before: null, after: t.a2,
  });
  // After a leaf → sibling of the leaf.
  assert.deepEqual(M.placementForDrop(order, parentOf, t.a1x, false, false), {
    parent: t.a1, before: null, after: t.a1x,
  });
  // After a1 (expanded, has child a1x) → first child of a1.
  assert.deepEqual(M.placementForDrop(order, parentOf, t.a1, false, false), {
    parent: t.a1, before: null, after: t.a1,
  });
});

test("computeRenderState", () => {
  const { order, parentOf, t } = build(["A", " a1", "  a1x", " a2", "B"]);
  const state = M.computeRenderState(order, parentOf, new Set([t.a1, t.B]));
  assert.deepEqual(state.get(t.A), { level: 0, hasChildren: true, collapsed: false, hidden: false });
  assert.deepEqual(state.get(t.a1), { level: 1, hasChildren: true, collapsed: true, hidden: false });
  assert.deepEqual(state.get(t.a1x), { level: 2, hasChildren: false, collapsed: false, hidden: true });
  assert.deepEqual(state.get(t.a2), { level: 1, hasChildren: false, collapsed: false, hidden: false });
  // Collapsed flag on a childless tab is ignored.
  assert.deepEqual(state.get(t.B), { level: 0, hasChildren: false, collapsed: false, hidden: false });
});

test("collapsed ancestor hides the whole subtree", () => {
  const { order, parentOf, t } = build(["A", " a1", "  a1x", "   deep"]);
  const state = M.computeRenderState(order, parentOf, new Set([t.A]));
  assert.equal(state.get(t.a1).hidden, true);
  assert.equal(state.get(t.a1x).hidden, true);
  assert.equal(state.get(t.deep).hidden, true);
  assert.equal(state.get(t.A).hidden, false);
});
