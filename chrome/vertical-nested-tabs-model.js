/* Vertical Nested Tabs — pure tree model.
 *
 * No DOM, no Firefox APIs. Everything takes:
 *   order    — array of items (tabs) in tab-strip order (unpinned region only)
 *   parentOf — Map<item, item|null> parent pointers
 * so it can be unit-tested in Node and reused from the chrome script.
 *
 * Invariant the rest of the add-on maintains: a subtree is contiguous and
 * depth-first, immediately after its parent. Firefox's tab strip cannot hold
 * wrapper elements, so the tree is only parent pointers + flat DOM order.
 *
 * Loaded into the browser window with `var` so it becomes a window global,
 * and exported for Node's test runner.
 */
var NestedTabsModel = {
  /** Depth of `item` (0 = root). Guards against accidental cycles. */
  depthOf(parentOf, item) {
    let depth = 0;
    const seen = new Set([item]);
    let p = parentOf.get(item);
    while (p) {
      if (seen.has(p)) {
        break;
      }
      seen.add(p);
      depth++;
      p = parentOf.get(p);
    }
    return depth;
  },

  /** Ancestors of `item`, nearest first. */
  ancestorsOf(parentOf, item) {
    const out = [];
    const seen = new Set([item]);
    let p = parentOf.get(item);
    while (p && !seen.has(p)) {
      out.push(p);
      seen.add(p);
      p = parentOf.get(p);
    }
    return out;
  },

  /** True if `ancestor` is a strict ancestor of `item`. */
  isAncestor(parentOf, ancestor, item) {
    if (!ancestor || ancestor === item) {
      return false;
    }
    return this.ancestorsOf(parentOf, item).includes(ancestor);
  },

  /** Direct children of `item`, in strip order. */
  childrenOf(order, parentOf, item) {
    return order.filter(t => parentOf.get(t) === item);
  },

  /** All descendants of `item`, in strip order. */
  descendantsOf(order, parentOf, item) {
    return order.filter(t => this.isAncestor(parentOf, item, t));
  },

  hasChildren(order, parentOf, item) {
    return order.some(t => parentOf.get(t) === item);
  },

  /** Last descendant in strip order, or `item` itself when it has none. */
  lastDescendant(order, parentOf, item) {
    const desc = this.descendantsOf(order, parentOf, item);
    return desc.length ? desc[desc.length - 1] : item;
  },

  /** `[item, ...descendants]` in strip order (what closing a subtree closes). */
  subtree(order, parentOf, item) {
    return [item, ...this.descendantsOf(order, parentOf, item)];
  },

  /**
   * True if `item`'s descendants occupy exactly the slots right after it.
   */
  isSubtreeContiguous(order, parentOf, item) {
    const start = order.indexOf(item);
    if (start < 0) {
      return false;
    }
    const desc = this.descendantsOf(order, parentOf, item);
    for (let i = 0; i < desc.length; i++) {
      if (order[start + 1 + i] !== desc[i]) {
        return false;
      }
    }
    return true;
  },

  /**
   * Walk the strip in order and return the set of items whose parent link is
   * invalid for a depth-first layout (parent missing, later in the strip, or
   * not an "open" ancestor at that point). Dropping those links makes the tree
   * match the current order without moving any tab.
   */
  reconcile(order, parentOf) {
    const drop = new Set();
    const inOrder = new Set(order);
    let stack = [];
    for (const item of order) {
      const p = parentOf.get(item);
      if (!p || !inOrder.has(p) || p === item) {
        if (p) {
          drop.add(item);
        }
        stack = [item];
        continue;
      }
      while (stack.length && stack[stack.length - 1] !== p) {
        stack.pop();
      }
      if (!stack.length) {
        drop.add(item);
        stack = [item];
        continue;
      }
      stack.push(item);
    }
    return drop;
  },

  wouldCreateCycle(parentOf, item, newParent) {
    if (!newParent) {
      return false;
    }
    return newParent === item || this.isAncestor(parentOf, item, newParent);
  },

  /**
   * Parent for a tab that appeared at `index` with no known parent.
   *  - nothing before it → root
   *  - nothing after it and no opener → root (plain "New Tab" appends)
   *  - the next tab is a descendant of the previous one → the previous tab
   *    (it landed between a parent and its first child)
   *  - otherwise → the previous tab's parent (a sibling after it)
   */
  parentForInsertedTab(order, parentOf, index, hasOpener) {
    const prev = index > 0 ? order[index - 1] : null;
    const next = index + 1 < order.length ? order[index + 1] : null;
    if (!prev) {
      return null;
    }
    if (!next) {
      return hasOpener ? parentOf.get(prev) || null : null;
    }
    if (this.isAncestor(parentOf, prev, next)) {
      return prev;
    }
    return parentOf.get(prev) || null;
  },

  /**
   * Parent and anchor for a plain (non-hold) drop next to `target`.
   *  - before target → target's parent, placed before target
   *  - after target that is expanded with children → target, as first child
   *  - after target otherwise → target's parent, after target's whole subtree
   * Returns { parent, after, before } where exactly one of after/before is set.
   */
  placementForDrop(order, parentOf, target, dropBefore, targetCollapsed) {
    if (dropBefore) {
      return { parent: parentOf.get(target) || null, before: target, after: null };
    }
    if (!targetCollapsed && this.hasChildren(order, parentOf, target)) {
      return { parent: target, before: null, after: target };
    }
    return {
      parent: parentOf.get(target) || null,
      before: null,
      after: this.lastDescendant(order, parentOf, target),
    };
  },

  /**
   * Per-item render state.
   * Returns Map<item, { level, hasChildren, collapsed, hidden }>.
   * `hidden` is true when any ancestor is collapsed.
   */
  computeRenderState(order, parentOf, collapsedSet) {
    const state = new Map();
    const childCount = new Map();
    for (const t of order) {
      const p = parentOf.get(t);
      if (p) {
        childCount.set(p, (childCount.get(p) || 0) + 1);
      }
    }
    for (const t of order) {
      const ancestors = this.ancestorsOf(parentOf, t);
      state.set(t, {
        level: ancestors.length,
        hasChildren: (childCount.get(t) || 0) > 0,
        collapsed: collapsedSet.has(t) && (childCount.get(t) || 0) > 0,
        hidden: ancestors.some(a => collapsedSet.has(a)),
      });
    }
    return state;
  },

  /**
   * Given the strip order, return the list of moves needed so every subtree is
   * contiguous: [{ items: [...descendants], after: parent }]. Only the roots of
   * broken subtrees are reported; applying moves in order fixes nested cases.
   */
  contiguityFixes(order, parentOf) {
    const fixes = [];
    for (const item of order) {
      if (!this.hasChildren(order, parentOf, item)) {
        continue;
      }
      if (this.isSubtreeContiguous(order, parentOf, item)) {
        continue;
      }
      fixes.push({ items: this.descendantsOf(order, parentOf, item), after: item });
    }
    return fixes;
  },
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = NestedTabsModel;
}
