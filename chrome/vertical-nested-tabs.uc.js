/* Vertical Nested Tabs
 *
 * Nested (tree) tabs for Firefox's native vertical tab strip. This file is a
 * privileged chrome script loaded into every browser window by loader/config.js.
 * It is inert when tabs are horizontal.
 *
 * Design in one paragraph: Firefox's tab strip cannot hold wrapper elements, so
 * the tree is just parent pointers plus flat tab order. A subtree is always
 * contiguous and depth-first right after its parent. Indentation, the twisty
 * and hiding are attributes + CSS; hiding also patches `tab.visible` so
 * keyboard navigation and drag indices agree with what is on screen. Parent
 * links and collapsed state persist through SessionStore custom tab values.
 *
 * Verified against Firefox 156 (release). Internal names it relies on:
 *   gBrowser.tabContainer.verticalMode / [orient] / [expanded]
 *   window.TabDragAndDrop (handle_dragstart/dragover/drop/dragend,
 *     _triggerDragOverGrouping, _getDragTarget, _resetGroupTarget)
 *   gBrowser.removeTab / removeTabs / moveTabsAfter / addTrustedTab
 *   SessionStore custom tab values, TabContextMenu, gContextMenu
 */
(function () {
  "use strict";

  const VERSION = "0.1.0";
  const TAG = "[vertical-nested-tabs]";
  const BROWSER_URL = "chrome://browser/content/browser.xhtml";

  if (window.location.href !== BROWSER_URL || !window.gBrowser) {
    return;
  }
  if (window.VerticalNestedTabs) {
    return;
  }

  const K_ID = "nestedTabs:id";
  const K_PARENT = "nestedTabs:parent";
  const K_COLLAPSED = "nestedTabs:collapsed";
  const K_POS = "nestedTabs:pos"; // position inside a subtree closed as one unit
  const HOLD_DELAY_MS = 100; // hold a dragged tab still over another tab this long to nest
  const HOLD_JITTER_PX = 4; // pointer movement below this keeps the hold alive
  const NEST_OVERLAP = 0.35; // fraction of a tab's height the dragged tab must visibly cover
  const MAX_VISUAL_LEVEL = 8; // deeper levels keep this indent
  const DROP_SETTLE_MAX_MS = 2000; // native drop animation grace

  const log = (...args) => console.log(TAG, ...args);
  const warnings = []; // last few warnings, readable from the Browser Console via VerticalNestedTabs._state
  const warn = (...args) => {
    console.warn(TAG, ...args);
    warnings.push(args.map(a => (a && a.stack) || String(a)).join(" "));
    if (warnings.length > 20) {
      warnings.shift();
    }
  };

  // ---------------------------------------------------------------------------
  // Dependencies
  // ---------------------------------------------------------------------------

  function loadModel() {
    if (window.NestedTabsModel) {
      return window.NestedTabsModel;
    }
    const file = Services.dirsvc.get("UChrm", Ci.nsIFile);
    file.append("vertical-nested-tabs-model.js");
    if (!file.exists()) {
      throw new Error(`missing ${file.path}`);
    }
    Services.scriptloader.loadSubScriptWithOptions(
      Services.io.newFileURI(file).spec,
      { target: window, ignoreCache: true, allowUnsafeURL: true }
    );
    if (!window.NestedTabsModel) {
      throw new Error("model did not define NestedTabsModel");
    }
    return window.NestedTabsModel;
  }

  function loadSessionStore() {
    try {
      if (window.SessionStore) {
        return window.SessionStore;
      }
    } catch (e) {}
    for (const url of [
      "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs",
      "resource:///modules/sessionstore/SessionStore.sys.mjs",
    ]) {
      try {
        return ChromeUtils.importESModule(url).SessionStore;
      } catch (e) {}
    }
    throw new Error("SessionStore unavailable");
  }

  let Model, SS;
  try {
    Model = loadModel();
    SS = loadSessionStore();
  } catch (e) {
    warn("not starting:", e);
    return;
  }

  const gBrowser = window.gBrowser;
  const tabContainer = gBrowser.tabContainer;
  const dnd = tabContainer.tabDragAndDrop;
  const TAB_DROP_TYPE = window.TAB_DROP_TYPE || "application/x-moz-tabbrowser-tab";
  const NEW_TAB_URL = window.BROWSER_NEW_TAB_URL || "about:newtab";

  const isTab = el => !!el && (gBrowser.isTab ? gBrowser.isTab(el) : el.tagName == "tab");

  /** Can this tab take part in the tree at all? */
  function eligible(tab) {
    if (!isTab(tab) || !tab.isConnected || tab.closing) {
      return false;
    }
    if ("isOpen" in tab && !tab.isOpen) {
      return false;
    }
    return !tab.pinned && !tab.splitview;
  }

  /** Eligible tabs in strip order. This is the `order` the model works on. */
  const unpinnedOrder = () => gBrowser.tabs.filter(eligible);

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  const state = {
    active: false,
    parentOf: new Map(), // tab -> parent tab | null
    collapsed: new Set(), // tabs whose children are hidden (persisted)
    tempCollapsed: null, // parent collapsed only for the duration of a drag
    idOf: new Map(), // tab -> uuid (mirror of the SessionStore value)
    restoring: false, // between SSWindowStateBusy and SSWindowStateReady
    busy: 0, // > 0 while we move tabs ourselves
    inDrop: false, // native drop handler running
    closingSubtree: null, // Set of tabs being closed as one subtree
    adoptingOut: null, // Set of descendants following a parent to another window
    pendingParent: null, // parent for the very next TabOpen we cause
    rebuildTimer: null,
    renderTimer: null,
    drag: null, // { draggedTab, lastX, lastY, candidate, timer, nestTarget }
    undo: [],
    warnings,
  };

  // ---------------------------------------------------------------------------
  // SessionStore helpers
  // ---------------------------------------------------------------------------

  function getVal(tab, key) {
    try {
      return SS.getCustomTabValue(tab, key) || "";
    } catch (e) {
      return "";
    }
  }

  function setVal(tab, key, value) {
    try {
      if (value) {
        SS.setCustomTabValue(tab, key, String(value));
      } else {
        SS.deleteCustomTabValue(tab, key);
      }
    } catch (e) {
      warn("setCustomTabValue failed", key, e);
    }
  }

  const mintId = () => Services.uuid.generateUUID().toString();

  function cachedId(tab) {
    return state.idOf.get(tab) || getVal(tab, K_ID) || "";
  }

  function findById(id, except) {
    if (!id) {
      return null;
    }
    for (const t of gBrowser.tabs) {
      if (t !== except && cachedId(t) === id) {
        return t;
      }
    }
    return null;
  }

  /** Ensure the tab has a unique id; returns it. */
  function ensureId(tab) {
    let id = getVal(tab, K_ID);
    if (!id || findById(id, tab)) {
      id = mintId();
      setVal(tab, K_ID, id);
    }
    state.idOf.set(tab, id);
    return id;
  }

  // ---------------------------------------------------------------------------
  // Tree mutation primitives
  // ---------------------------------------------------------------------------

  function parentOf(tab) {
    return state.parentOf.get(tab) || null;
  }

  function setParentRaw(tab, parent) {
    state.parentOf.set(tab, parent || null);
    setVal(tab, K_PARENT, parent ? ensureId(parent) : "");
  }

  /** Validated re-parenting. Returns true when the link was set. */
  function setParent(tab, parent) {
    if (!eligible(tab)) {
      return false;
    }
    if (parent && (!eligible(parent) || Model.wouldCreateCycle(state.parentOf, tab, parent))) {
      return false;
    }
    setParentRaw(tab, parent);
    return true;
  }

  function forget(tab) {
    state.parentOf.delete(tab);
    state.collapsed.delete(tab);
    state.idOf.delete(tab);
  }

  /** Children of `tab` move up one level. */
  function promoteChildren(tab) {
    const gp = parentOf(tab);
    const order = unpinnedOrder();
    for (const child of Model.childrenOf(order, state.parentOf, tab)) {
      if (state.closingSubtree?.has(child) || state.adoptingOut?.has(child)) {
        continue; // its stored parent link must keep pointing at `tab`
      }
      setParentRaw(child, gp && eligible(gp) ? gp : null);
    }
  }

  function withBusy(fn) {
    state.busy++;
    try {
      return fn();
    } finally {
      state.busy--;
    }
  }

  /** Make every subtree contiguous by moving descendants right after parents. */
  function fixContiguity() {
    for (let round = 0; round < 6; round++) {
      const fixes = Model.contiguityFixes(unpinnedOrder(), state.parentOf);
      if (!fixes.length) {
        return;
      }
      withBusy(() => {
        for (const fix of fixes) {
          try {
            gBrowser.moveTabsAfter(fix.items, fix.after);
          } catch (e) {
            warn("moveTabsAfter failed", e);
          }
        }
      });
    }
  }

  /**
   * Drop links that cannot hold: gone/ineligible tabs, parents in another
   * native group, cycles, aborted subtree closes.
   */
  function sanitize() {
    const order = unpinnedOrder();
    const inTree = new Set(order);
    for (const [tab, parent] of [...state.parentOf]) {
      if (state.adoptingOut?.has(tab)) {
        continue; // on its way to another window; links are resolved there
      }
      if (!inTree.has(tab)) {
        if (tab.isConnected && !tab.closing) {
          // pinned / split view: leave the tree, children move up
          promoteChildren(tab);
          setParentRaw(tab, null);
          state.parentOf.delete(tab);
          state.collapsed.delete(tab);
        } else if (!tab.isConnected) {
          forget(tab);
        }
        continue;
      }
      if (!parent) {
        continue;
      }
      if (state.closingSubtree?.has(tab)) {
        continue;
      }
      if (
        !inTree.has(parent) ||
        parent.group !== tab.group ||
        Model.wouldCreateCycle(state.parentOf, tab, parent)
      ) {
        setParentRaw(tab, null);
      }
    }
    if (state.closingSubtree) {
      for (const t of [...state.closingSubtree]) {
        if (!t.isConnected || (!t.closing && !t._closedInMultiselection)) {
          state.closingSubtree.delete(t);
        }
      }
      if (!state.closingSubtree.size) {
        state.closingSubtree = null;
      }
    }
  }

  /**
   * Rebuild parent links from SessionStore values. Never moves tabs; links
   * that do not fit the current order are dropped.
   */
  function rebuild() {
    state.rebuildTimer = null;
    const order = unpinnedOrder();
    const byId = new Map();
    const storedParent = new Map();
    for (const tab of order) {
      let id = getVal(tab, K_ID);
      if (!id || byId.has(id)) {
        id = mintId();
        setVal(tab, K_ID, id);
      }
      state.idOf.set(tab, id);
      byId.set(id, tab);
      storedParent.set(tab, getVal(tab, K_PARENT));
    }
    state.parentOf = new Map();
    state.collapsed = new Set();
    for (const tab of order) {
      const pid = storedParent.get(tab);
      const parent = pid ? byId.get(pid) : null;
      state.parentOf.set(tab, parent && parent !== tab ? parent : null);
      if (getVal(tab, K_COLLAPSED) === "1") {
        state.collapsed.add(tab);
      }
    }
    for (const tab of Model.reconcile(order, state.parentOf)) {
      setParentRaw(tab, null);
    }
    sanitize();
    restoreSubtreeOrder();
    render();
  }

  /** Put reopened subtrees back in the order they had when closed. */
  function restoreSubtreeOrder() {
    const order = unpinnedOrder();
    const posOf = new Map();
    for (const tab of order) {
      const v = getVal(tab, K_POS);
      if (v !== "") {
        posOf.set(tab, Number(v));
      }
    }
    if (!posOf.size) {
      return;
    }
    const done = new Set();
    for (const tab of order) {
      if (!posOf.has(tab) || done.has(tab)) {
        continue;
      }
      // Walk up to the top of the reopened block.
      let top = tab;
      while (parentOf(top) && posOf.has(parentOf(top))) {
        top = parentOf(top);
      }
      const current = unpinnedOrder();
      const desc = Model.descendantsOf(current, state.parentOf, top);
      const members = [top, ...desc];
      members.forEach(t => done.add(t));
      const sorted = desc
        .slice()
        .sort((a, b) => (posOf.get(a) ?? 1e9) - (posOf.get(b) ?? 1e9) || current.indexOf(a) - current.indexOf(b));
      if (sorted.some((t, i) => t !== desc[i])) {
        withBusy(() => {
          try {
            gBrowser.moveTabsAfter(sorted, top);
          } catch (e) {
            warn("moveTabsAfter failed", e);
          }
        });
      }
    }
    for (const tab of posOf.keys()) {
      setVal(tab, K_POS, "");
    }
  }

  function scheduleRebuild() {
    if (state.rebuildTimer) {
      return;
    }
    state.rebuildTimer = setTimeout(() => {
      try {
        rebuild();
      } catch (e) {
        warn("rebuild failed", e);
      }
    }, 0);
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  const ATTRS = ["nested-level", "nested-haschildren", "nested-collapsed", "nested-hidden"];

  function clearTabAttributes(tab) {
    const changed = tab.hasAttribute("nested-hidden");
    for (const a of ATTRS) {
      tab.removeAttribute(a);
    }
    tab.style.removeProperty("--nested-level");
    if (tab.hasAttribute("aria-expanded")) {
      tab.removeAttribute("aria-expanded");
    }
    return changed;
  }

  function ensureTwisty(tab) {
    let twisty = tab.querySelector(".tab-nest-twisty");
    if (twisty) {
      return twisty;
    }
    const closeButton = tab.querySelector(".tab-close-button");
    if (!closeButton) {
      return null;
    }
    twisty = document.createXULElement("image");
    twisty.className = "tab-nest-twisty";
    twisty.setAttribute("role", "button");
    twisty.setAttribute("keyNav", "false");
    twisty.hidden = true;
    const count = document.createXULElement("label");
    count.className = "tab-nest-count";
    count.setAttribute("role", "presentation");
    count.hidden = true;
    closeButton.before(count, twisty);
    return twisty;
  }

  function render() {
    state.renderTimer = null;
    const collapsedSet = new Set(state.collapsed);
    if (state.tempCollapsed) {
      collapsedSet.add(state.tempCollapsed);
    }
    const order = unpinnedOrder();
    const renderState = state.active
      ? Model.computeRenderState(order, state.parentOf, collapsedSet)
      : null;
    let visibilityChanged = false;
    for (const tab of gBrowser.tabs) {
      const s = renderState?.get(tab);
      if (!s) {
        if (clearTabAttributes(tab)) {
          visibilityChanged = true;
        }
        const twisty = tab.querySelector(".tab-nest-twisty");
        if (twisty) {
          twisty.hidden = true;
        }
        const count = tab.querySelector(".tab-nest-count");
        if (count) {
          count.hidden = true;
        }
        continue;
      }
      tab.setAttribute("nested-level", s.level);
      tab.style.setProperty("--nested-level", Math.min(s.level, MAX_VISUAL_LEVEL));
      tab.toggleAttribute("nested-haschildren", s.hasChildren);
      tab.toggleAttribute("nested-collapsed", s.collapsed);
      if (tab.hasAttribute("nested-hidden") !== s.hidden) {
        tab.toggleAttribute("nested-hidden", s.hidden);
        visibilityChanged = true;
      }
      // Native uses aria-level 1 (plain) / 2 (grouped); nesting adds depth.
      tab.setAttribute("aria-level", (tab.group ? 2 : 1) + s.level);
      if (s.hasChildren) {
        tab.setAttribute("aria-expanded", s.collapsed ? "false" : "true");
      } else if (tab.hasAttribute("aria-expanded")) {
        tab.removeAttribute("aria-expanded");
      }
      const twisty = ensureTwisty(tab);
      if (twisty) {
        twisty.hidden = !s.hasChildren;
        twisty.setAttribute(
          "tooltiptext",
          s.collapsed ? "Expand nested tabs" : "Collapse nested tabs"
        );
        const count = tab.querySelector(".tab-nest-count");
        if (count) {
          const n = s.collapsed ? Model.descendantsOf(order, state.parentOf, tab).length : 0;
          count.hidden = !n;
          count.setAttribute("value", n ? String(n) : "");
          count.setAttribute("tooltiptext", n ? `${n} hidden nested tab${n === 1 ? "" : "s"}` : "");
        }
      }
    }
    if (visibilityChanged) {
      tabContainer._invalidateCachedVisibleTabs?.();
    }
  }

  function scheduleRender() {
    if (state.renderTimer) {
      return;
    }
    state.renderTimer = setTimeout(() => {
      try {
        sanitize();
        render();
      } catch (e) {
        warn("render failed", e);
      }
    }, 0);
  }

  /** sanitize → contiguity → render, synchronously. */
  function relayout() {
    sanitize();
    fixContiguity();
    sanitize();
    render();
  }

  // ---------------------------------------------------------------------------
  // Collapse / expand
  // ---------------------------------------------------------------------------

  function setCollapsed(tab, collapsed) {
    const order = unpinnedOrder();
    if (collapsed && !Model.hasChildren(order, state.parentOf, tab)) {
      collapsed = false;
    }
    if (collapsed) {
      const selected = gBrowser.selectedTab;
      if (selected !== tab && Model.isAncestor(state.parentOf, tab, selected)) {
        gBrowser.selectedTab = tab;
      }
      state.collapsed.add(tab);
      setVal(tab, K_COLLAPSED, "1");
    } else {
      state.collapsed.delete(tab);
      setVal(tab, K_COLLAPSED, "");
    }
    render();
  }

  function expandAncestors(tab) {
    let changed = false;
    for (const a of Model.ancestorsOf(state.parentOf, tab)) {
      if (state.collapsed.has(a)) {
        state.collapsed.delete(a);
        setVal(a, K_COLLAPSED, "");
        changed = true;
      }
    }
    if (changed) {
      render();
    }
  }

  // ---------------------------------------------------------------------------
  // Nesting operations used by drag & drop and menus
  // ---------------------------------------------------------------------------

  /** Block of tabs = the given roots plus their descendants, in strip order. */
  function blockOf(roots) {
    const order = unpinnedOrder();
    const set = new Set();
    for (const r of roots) {
      set.add(r);
      for (const d of Model.descendantsOf(order, state.parentOf, r)) {
        set.add(d);
      }
    }
    return order.filter(t => set.has(t));
  }

  /** Make `roots` the last children of `parent` (moves whole subtrees). */
  function nestUnder(roots, parent, { expand = true } = {}) {
    if (!eligible(parent)) {
      return false;
    }
    const accepted = [];
    for (const r of roots) {
      if (r === parent || Model.wouldCreateCycle(state.parentOf, r, parent)) {
        continue;
      }
      if (setParent(r, parent)) {
        accepted.push(r);
      }
    }
    if (!accepted.length) {
      return false;
    }
    const block = blockOf(accepted);
    const blockSet = new Set(block);
    const rest = unpinnedOrder().filter(t => !blockSet.has(t));
    const anchor = Model.lastDescendant(rest, state.parentOf, parent);
    withBusy(() => {
      try {
        gBrowser.moveTabsAfter(block, anchor);
      } catch (e) {
        warn("moveTabsAfter failed", e);
      }
    });
    if (expand && state.collapsed.has(parent)) {
      state.collapsed.delete(parent);
      setVal(parent, K_COLLAPSED, "");
    }
    relayout();
    return true;
  }

  function openNewNestedTab(parent) {
    if (!eligible(parent)) {
      return;
    }
    window.focus();
    const anchor = Model.lastDescendant(unpinnedOrder(), state.parentOf, parent);
    let tab = null;
    state.pendingParent = parent;
    try {
      tab = gBrowser.addTrustedTab(NEW_TAB_URL, {
        tabIndex: anchor.index + 1,
        tabGroup: parent.group || undefined,
        userContextId: parent.userContextId,
        focusUrlBar: true,
      });
    } finally {
      state.pendingParent = null;
    }
    if (!tab) {
      return;
    }
    setParent(tab, parent);
    if (state.collapsed.has(parent)) {
      state.collapsed.delete(parent);
      setVal(parent, K_COLLAPSED, "");
    }
    gBrowser.selectedTab = tab;
    relayout();
  }

  function openLinkInNestedTab() {
    const ctx = window.gContextMenu;
    if (!ctx || !ctx.linkURL) {
      return;
    }
    const parent = ctx.browser && gBrowser.getTabForBrowser(ctx.browser);
    if (!parent || !eligible(parent)) {
      return;
    }
    let params = { userContextId: parent.userContextId };
    try {
      params = ctx._openLinkInParameters({
        userContextId: parent.userContextId,
        eventDetail: { containerSource: "content_context_menu" },
        ...(ctx._getGlobalHistoryOptions?.() || {}),
      });
    } catch (e) {
      warn("_openLinkInParameters failed, using defaults", e);
    }
    params.relatedToCurrent = true;
    params.openerBrowser = ctx.browser;
    const created = new Promise(resolve => {
      params.resolveOnNewTabCreated = resolve;
    });
    state.pendingParent = parent;
    try {
      window.openLinkIn(ctx.linkURL, "tab", params);
    } finally {
      state.pendingParent = null;
    }
    created.then(browser => {
      const tab = browser && gBrowser.getTabForBrowser(browser);
      if (tab && eligible(tab) && eligible(parent)) {
        nestUnder([tab], parent);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Tab lifecycle
  // ---------------------------------------------------------------------------

  function onTabOpen(tab, detail) {
    if (state.restoring) {
      scheduleRebuild();
      return;
    }
    if (detail?.adoptedTab) {
      // SessionStore moves the custom values over during this same event;
      // read them once that has happened.
      setTimeout(() => {
        try {
          adoptedTabSettled(tab);
        } catch (e) {
          warn("adopted tab handling failed", e);
        }
      }, 0);
      return;
    }
    if (!eligible(tab)) {
      scheduleRender();
      return;
    }
    ensureId(tab);
    let parent = null;
    if (state.pendingParent && eligible(state.pendingParent)) {
      parent = state.pendingParent;
      state.pendingParent = null;
    } else {
      const pid = getVal(tab, K_PARENT);
      if (pid) {
        const p = findById(pid, tab);
        parent = p && eligible(p) && !Model.wouldCreateCycle(state.parentOf, tab, p) ? p : null;
      } else {
        const order = unpinnedOrder();
        parent = Model.parentForInsertedTab(
          order,
          state.parentOf,
          order.indexOf(tab),
          !!tab.openerTab
        );
      }
    }
    setParentRaw(tab, parent);
    scheduleRender();
  }

  function onTabClose(tab, detail) {
    if (state.adoptingOut?.has(tab)) {
      state.adoptingOut.delete(tab);
      if (!state.adoptingOut.size) {
        state.adoptingOut = null;
      }
    } else if (state.closingSubtree?.has(tab)) {
      state.closingSubtree.delete(tab);
      if (!state.closingSubtree.size) {
        state.closingSubtree = null;
      }
    } else if (detail?.adoptedBy) {
      if (!startAdoptingDescendants(tab, detail.adoptedBy)) {
        promoteChildren(tab);
      }
    } else {
      promoteChildren(tab);
    }
    forget(tab);
    scheduleRender();
  }

  // ---------------------------------------------------------------------------
  // Moving a subtree to another window
  //
  // Firefox adopts only the dragged tab. When it does, we adopt its
  // descendants right behind it in the other window and re-link them there.
  // Parent links travel as SessionStore custom values, so the other window's
  // copy of this script can resolve them; _afterAdopt makes it explicit.
  // ---------------------------------------------------------------------------

  function startAdoptingDescendants(tab, adoptedBy) {
    // `ownerGlobal` is not exposed through the cross-window wrapper; use the document.
    const targetWin = adoptedBy?.ownerDocument?.defaultView || adoptedBy?.ownerGlobal;
    if (!targetWin || targetWin === window || targetWin.closed) {
      return false;
    }
    const descendants = Model.descendantsOf(unpinnedOrder(), state.parentOf, tab);
    if (!descendants.length) {
      return false;
    }
    const counterpart = new Map([[tab, adoptedBy]]);
    state.adoptingOut = new Set([...(state.adoptingOut || []), ...descendants]);
    setTimeout(() => {
      adoptDescendants(descendants, counterpart, targetWin).catch(e =>
        warn("adopting descendants failed", e)
      );
    }, 0);
    return true;
  }

  async function adoptDescendants(descendants, counterpart, targetWin) {
    try {
      await targetWin.delayedStartupPromise;
    } catch (e) {}
    let api = null;
    for (let i = 0; i < 50 && !targetWin.closed; i++) {
      api = targetWin.VerticalNestedTabs;
      if (api && api.version) {
        break;
      }
      await new Promise(r => setTimeout(r, 100));
    }
    const targetBrowser = targetWin.gBrowser;
    let anchor = counterpart.values().next().value; // the adopted parent
    for (const d of descendants) {
      if (targetWin.closed) {
        break;
      }
      const srcParent = state.parentOf.get(d) || null;
      const newParent = srcParent ? counterpart.get(srcParent) : null;
      if (!d.isConnected || d.closing) {
        // Already adopted natively (multi-select drag); nothing to move.
        state.adoptingOut?.delete(d);
        continue;
      }
      let newTab = null;
      try {
        const index = anchor?.isConnected ? anchor.index + 1 : undefined;
        newTab = targetBrowser.adoptTab(d, { tabIndex: index, selectTab: false });
      } catch (e) {
        warn("adoptTab failed", e);
      }
      if (!newTab) {
        state.adoptingOut?.delete(d);
        continue;
      }
      counterpart.set(d, newTab);
      anchor = newTab;
      if (api && newParent?.isConnected) {
        try {
          api._afterAdopt(newTab, newParent);
        } catch (e) {
          warn("_afterAdopt failed", e);
        }
      }
    }
    if (state.adoptingOut && !state.adoptingOut.size) {
      state.adoptingOut = null;
    }
    relayout();
  }

  /** Target-window side: link an adopted child under its adopted parent. */
  function afterAdopt(child, parent) {
    if (!eligible(child) || !eligible(parent) || child === parent) {
      return;
    }
    ensureId(child);
    if (getVal(child, K_COLLAPSED) === "1") {
      state.collapsed.add(child);
    }
    if (parentOf(child) !== parent || child.group !== parent.group) {
      nestUnder([child], parent, { expand: false });
    } else {
      relayout();
    }
  }

  /** Target-window side: an adopted tab whose values have now arrived. */
  function adoptedTabSettled(tab) {
    if (!eligible(tab)) {
      scheduleRender();
      return;
    }
    ensureId(tab);
    if (getVal(tab, K_COLLAPSED) === "1") {
      state.collapsed.add(tab);
    }
    if (!state.parentOf.has(tab)) {
      const pid = getVal(tab, K_PARENT);
      const p = pid ? findById(pid, tab) : null;
      if (p && eligible(p) && !Model.wouldCreateCycle(state.parentOf, tab, p)) {
        setParentRaw(tab, p);
      } else {
        const order = unpinnedOrder();
        setParentRaw(
          tab,
          Model.parentForInsertedTab(order, state.parentOf, order.indexOf(tab), false)
        );
      }
    }
    relayout();
  }

  function onTabMove(tab) {
    if (state.busy || state.inDrop || !eligible(tab)) {
      return;
    }
    // Subtrees travel with their parent.
    fixContiguity();
    const order = unpinnedOrder();
    const drop = Model.reconcile(order, state.parentOf);
    for (const t of drop) {
      if (t === tab) {
        state.parentOf.set(t, null);
        const idx = order.indexOf(t);
        setParentRaw(t, Model.parentForInsertedTab(order, state.parentOf, idx, false));
      } else {
        setParentRaw(t, null);
      }
    }
    relayout();
  }

  function detach(tab) {
    promoteChildren(tab);
    if (state.parentOf.has(tab)) {
      setParentRaw(tab, null);
    }
    state.collapsed.delete(tab);
    setVal(tab, K_COLLAPSED, "");
  }

  function onTabSelect(tab) {
    if (state.active && tab.hasAttribute("nested-hidden")) {
      expandAncestors(tab);
    }
  }

  // Closing a collapsed parent closes its whole subtree in one bulk operation,
  // so Firefox's own "Reopen Closed Tabs (N)" brings the subtree back.
  const origRemoveTab = gBrowser.removeTab;
  function removeTabWrapper(tab, options = {}) {
    try {
      if (
        state.active &&
        isTab(tab) &&
        eligible(tab) &&
        !tab._closedInMultiselection &&
        state.collapsed.has(tab)
      ) {
        const subtree = Model.subtree(unpinnedOrder(), state.parentOf, tab);
        if (subtree.length > 1) {
          // Firefox reopens closed tabs by remembered index, which can
          // interleave siblings; remember the subtree order to restore it.
          subtree.forEach((t, i) => setVal(t, K_POS, String(i)));
          state.closingSubtree = new Set([...(state.closingSubtree || []), ...subtree]);
          return this.removeTabs(subtree, {
            animate: false,
            suppressWarnAboutClosingWindow: true,
            skipPermitUnload: options.skipPermitUnload,
            skipSessionStore: options.skipSessionStore,
            metricsContext: options.metricsContext,
          });
        }
      }
    } catch (e) {
      warn("removeTab wrapper failed", e);
    }
    return origRemoveTab.call(this, tab, options);
  }

  // ---------------------------------------------------------------------------
  // Drag & drop
  // ---------------------------------------------------------------------------

  function draggedTabFrom(event) {
    const dt = event.dataTransfer;
    try {
      if (dt.mozTypesAt(0)[0] !== TAB_DROP_TYPE) {
        return null;
      }
      const tab = dt.mozGetDataAt(TAB_DROP_TYPE, 0);
      if (!tab || tab.ownerDocument !== document || !isTab(tab) || !tab._dragData) {
        return null;
      }
      return tab;
    } catch (e) {
      return null;
    }
  }

  function clearHoldTimer() {
    if (state.drag?.timer) {
      clearTimeout(state.drag.timer);
      state.drag.timer = null;
    }
  }

  function clearNestTarget() {
    const d = state.drag;
    if (!d) {
      return;
    }
    if (d.nestTarget) {
      d.nestTarget.removeAttribute("dragover-nestTarget");
      d.nestTarget = null;
    }
    tabContainer.removeAttribute("movingtab-nest");
    const dd = d.draggedTab?._dragData;
    if (dd) {
      delete dd.nestParent;
    }
    if (d.draggedTab?.isConnected) {
      const lvl = d.draggedTab.getAttribute("nested-level");
      if (lvl !== null) {
        d.draggedTab.style.setProperty("--nested-level", Math.min(+lvl, MAX_VISUAL_LEVEL));
      }
    }
  }

  /**
   * While dragging without holding, show which tab the drop rules would make
   * the parent (dashed highlight) and preview the resulting indent. Firefox
   * already tracks the drop element and side in the drag data.
   */
  function updateDropParentPreview(draggedTab) {
    const d = state.drag;
    const dd = draggedTab?._dragData;
    if (!d || !dd) {
      return;
    }
    let parent = null;
    if (!d.nestTarget) {
      const el = dd.dropElement;
      const moving = new Set(dd.movingTabs || [draggedTab]);
      if (isTab(el) && eligible(el) && !moving.has(el)) {
        const order = unpinnedOrder().filter(t => !moving.has(t));
        const placement = Model.placementForDrop(
          order,
          state.parentOf,
          el,
          !!dd.dropBefore,
          state.collapsed.has(el)
        );
        parent = placement.parent;
        if (
          parent &&
          [...moving].some(m => m === parent || Model.wouldCreateCycle(state.parentOf, m, parent))
        ) {
          parent = null;
        }
      }
    }
    setDropParentPreview(parent, draggedTab);
  }

  function setDropParentPreview(parent, draggedTab) {
    const d = state.drag;
    if (!d) {
      return;
    }
    if (d.dropParent !== parent) {
      d.dropParent?.removeAttribute("dragover-nestParent");
      d.dropParent = parent || null;
      if (parent) {
        parent.toggleAttribute("dragover-nestParent", true);
      }
    }
    if (!d.nestTarget && draggedTab?.isConnected) {
      const depth = parent ? Model.depthOf(state.parentOf, parent) + 1 : 0;
      draggedTab.style.setProperty("--nested-level", Math.min(depth, MAX_VISUAL_LEVEL));
    }
  }

  function armNestTarget(target, draggedTab) {
    const d = state.drag;
    const dd = draggedTab._dragData;
    if (!d || !dd || !target.isConnected || !eligible(target)) {
      return;
    }
    setDropParentPreview(null, null);
    d.timer = null;
    d.nestTarget = target;
    dd.nestParent = target;
    target.toggleAttribute("dragover-nestTarget", true);
    tabContainer.toggleAttribute("movingtab-nest", true);
    // Take over from the native "create group" offer, if it fired.
    tabContainer.removeAttribute("movingtab-group");
    try {
      dnd._resetGroupTarget?.(document.querySelector("[dragover-groupTarget]"));
    } catch (e) {}
    delete dd.shouldCreateGroupOnDrop;
    const depth = Model.depthOf(state.parentOf, target) + 1;
    draggedTab.style.setProperty("--nested-level", Math.min(depth, MAX_VISUAL_LEVEL));
  }

  function endDrag() {
    clearHoldTimer();
    clearNestTarget();
    state.drag?.dropParent?.removeAttribute("dragover-nestParent");
    const restore = state.tempCollapsed;
    state.drag = null;
    state.tempCollapsed = null;
    if (restore || state.active) {
      render();
    }
  }

  /**
   * The tab the dragged tab visibly overlaps, if it covers at least
   * NEST_OVERLAP of that tab's height. Visual boxes are used on purpose: once
   * Firefox slides a tab out of the way, the overlap is gone and so is the
   * offer, so the empty gap never nests.
   */
  function overlapTargetTab(draggedTab) {
    const moving = new Set(draggedTab._dragData.movingTabs || [draggedTab]);
    const d = draggedTab.getBoundingClientRect();
    if (!d.height) {
      return null;
    }
    let best = null;
    let bestOverlap = 0;
    for (const tab of gBrowser.visibleTabs) {
      if (moving.has(tab) || !eligible(tab)) {
        continue;
      }
      const r = tab.getBoundingClientRect();
      if (!r.height || d.right <= r.left || d.left >= r.right) {
        continue;
      }
      const overlap = Math.min(d.bottom, r.bottom) - Math.max(d.top, r.top);
      const fraction = overlap / Math.min(d.height, r.height);
      if (fraction > bestOverlap) {
        bestOverlap = fraction;
        best = tab;
      }
    }
    if (!best || bestOverlap < NEST_OVERLAP) {
      return null;
    }
    for (const m of moving) {
      if (m === best || Model.wouldCreateCycle(state.parentOf, m, best)) {
        return null;
      }
    }
    return best;
  }

  const origDragStart = dnd.handle_dragstart;
  function dragStartWrapper(event) {
    let temp = null;
    if (state.active) {
      try {
        const tab = this._getDragTarget(event, { findClosestTarget: false });
        if (
          isTab(tab) &&
          eligible(tab) &&
          !state.collapsed.has(tab) &&
          Model.hasChildren(unpinnedOrder(), state.parentOf, tab)
        ) {
          // Hide the subtree while dragging so it travels with its parent.
          temp = tab;
          state.tempCollapsed = tab;
          render();
        }
        state.drag = { draggedTab: tab, lastX: event.screenX, lastY: event.screenY };
      } catch (e) {
        warn("dragstart wrapper failed", e);
      }
    }
    origDragStart.call(this, event);
    if (temp && !temp._dragData) {
      // No drag actually started; undo the temporary collapse.
      state.tempCollapsed = null;
      state.drag = null;
      render();
    }
  }

  const origDragOver = dnd.handle_dragover;
  function dragOverWrapper(event) {
    origDragOver.call(this, event);
    if (!state.active) {
      return;
    }
    try {
      const draggedTab = draggedTabFrom(event);
      if (!draggedTab || draggedTab.pinned || draggedTab._dragData.fromTabList) {
        clearHoldTimer();
        clearNestTarget();
        setDropParentPreview(null, draggedTab);
        return;
      }
      let effect = "";
      try {
        effect = this.getDropEffectForTabDrag(event);
      } catch (e) {}
      if (effect !== "move") {
        clearHoldTimer();
        clearNestTarget();
        setDropParentPreview(null, draggedTab);
        return;
      }
      state.drag ??= { draggedTab, lastX: event.screenX, lastY: event.screenY };
      const d = state.drag;
      const target = overlapTargetTab(draggedTab);
      const moved =
        Math.abs(event.screenX - d.lastX) > HOLD_JITTER_PX ||
        Math.abs(event.screenY - d.lastY) > HOLD_JITTER_PX;
      if (target !== d.candidate || moved) {
        d.lastX = event.screenX;
        d.lastY = event.screenY;
        d.candidate = target;
        clearHoldTimer();
        if (d.nestTarget && d.nestTarget !== target) {
          clearNestTarget();
        }
        if (target && !d.nestTarget) {
          d.timer = setTimeout(() => {
            try {
              armNestTarget(target, draggedTab);
            } catch (e) {
              warn("armNestTarget failed", e);
            }
          }, HOLD_DELAY_MS);
        }
      }
      updateDropParentPreview(draggedTab);
    } catch (e) {
      warn("dragover wrapper failed", e);
    }
  }

  // Native "hold to create a group" is replaced by "hold to nest" for tab
  // targets in vertical mode. Group labels keep their native behaviour.
  const origTriggerGrouping = dnd._triggerDragOverGrouping;
  function triggerGroupingWrapper(dropElement) {
    if (state.active && isTab(dropElement)) {
      return;
    }
    origTriggerGrouping.call(this, dropElement);
  }

  function waitForDropToSettle(movingTabs) {
    return new Promise(resolve => {
      const start = Date.now();
      const check = () => {
        const animating = movingTabs.some(
          t => t.isConnected && t.hasAttribute("tabdrop-samewindow")
        );
        if (!animating || Date.now() - start > DROP_SETTLE_MAX_MS) {
          // The native move runs in a microtask after the animation ends.
          setTimeout(resolve, 0);
        } else {
          setTimeout(check, 40);
        }
      };
      check();
    });
  }

  function afterDrop(snap) {
    const moving = snap.movingTabs.filter(t => isTab(t) && eligible(t));
    if (!moving.length) {
      relayout();
      return;
    }
    const movingSet = new Set(moving);
    const roots = moving.filter(t => !movingSet.has(parentOf(t)));

    if (snap.nestParent && eligible(snap.nestParent) && !movingSet.has(snap.nestParent)) {
      if (nestUnder(roots, snap.nestParent)) {
        return;
      }
    }

    const el = snap.dropElement;
    if (snap.fromTabList || !el) {
      const order = unpinnedOrder();
      for (const r of roots) {
        state.parentOf.set(r, null);
        setParentRaw(r, Model.parentForInsertedTab(order, state.parentOf, order.indexOf(r), false));
      }
    } else if (isTab(el) && eligible(el) && !movingSet.has(el)) {
      const order = unpinnedOrder().filter(t => !movingSet.has(t));
      const placement = Model.placementForDrop(
        order,
        state.parentOf,
        el,
        !!snap.dropBefore,
        state.collapsed.has(el)
      );
      for (const r of roots) {
        if (placement.parent && Model.wouldCreateCycle(state.parentOf, r, placement.parent)) {
          setParentRaw(r, null);
        } else {
          setParentRaw(r, placement.parent);
        }
      }
      if (placement.after && placement.after !== el) {
        // Dropped after a collapsed parent: land after its hidden subtree.
        withBusy(() => {
          try {
            gBrowser.moveTabsAfter(blockOf(roots), placement.after);
          } catch (e) {
            warn("moveTabsAfter failed", e);
          }
        });
      }
    } else {
      // group label, group element, split view wrapper → top level
      for (const r of roots) {
        setParentRaw(r, null);
      }
    }
    relayout();
  }

  const origDrop = dnd.handle_drop;
  function dropWrapper(event) {
    let snap = null;
    if (state.active) {
      try {
        const draggedTab = draggedTabFrom(event);
        const dd = draggedTab?._dragData;
        if (draggedTab && dd && !draggedTab.pinned && event.dataTransfer.dropEffect === "move") {
          if (dd.shouldCreateGroupOnDrop && isTab(dd.dropElement)) {
            delete dd.shouldCreateGroupOnDrop;
          }
          snap = {
            draggedTab,
            movingTabs: [...(dd.movingTabs || [draggedTab])],
            dropElement: dd.dropElement,
            dropBefore: dd.dropBefore,
            nestParent: dd.nestParent || null,
            fromTabList: !!dd.fromTabList,
          };
        }
      } catch (e) {
        warn("drop snapshot failed", e);
      }
    }
    clearHoldTimer();
    // Firefox performs the actual move only after its drop animation, so the
    // drop stays "in progress" (TabMove ignored) until afterDrop has run.
    state.inDrop = true;
    try {
      origDrop.call(this, event);
    } catch (e) {
      state.inDrop = false;
      throw e;
    }
    if (!snap) {
      state.inDrop = false;
      endDrag();
      return;
    }
    waitForDropToSettle(snap.movingTabs).then(() => {
      try {
        afterDrop(snap);
      } catch (e) {
        warn("afterDrop failed", e);
      } finally {
        state.inDrop = false;
        endDrag();
      }
    });
  }

  const origDragEnd = dnd.handle_dragend;
  function dragEndWrapper(event) {
    try {
      origDragEnd.call(this, event);
    } finally {
      // A same-window drop is finished by dropWrapper after its animation.
      const dragged = state.drag?.draggedTab;
      const dropping =
        dragged?.isConnected && dragged.hasAttribute("tabdrop-samewindow");
      if (!dropping && !state.inDrop) {
        clearHoldTimer();
        clearNestTarget();
        if (state.tempCollapsed || state.drag) {
          endDrag();
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Twisty clicks (capture phase so the tab does not get selected)
  // ---------------------------------------------------------------------------

  const isTwisty = event => !!event.target?.classList?.contains("tab-nest-twisty");

  function onTwistyMouseDown(event) {
    if (isTwisty(event) && event.button === 0) {
      event.stopPropagation();
      event.preventDefault();
    }
  }

  function onTwistyClick(event) {
    if (!isTwisty(event) || event.button !== 0) {
      return;
    }
    event.stopPropagation();
    event.preventDefault();
    const tab = event.target.closest("tab");
    if (tab && eligible(tab)) {
      setCollapsed(tab, !state.collapsed.has(tab));
    }
  }

  function onTwistySwallow(event) {
    if (isTwisty(event)) {
      event.stopPropagation();
      event.preventDefault();
    }
  }

  // ---------------------------------------------------------------------------
  // Context menus
  // ---------------------------------------------------------------------------

  const tabMenu = document.getElementById("tabContextMenu");
  const contentMenu = document.getElementById("contentAreaContextMenu");

  const newNestedItem = document.createXULElement("menuitem");
  newNestedItem.id = "context_newNestedTab";
  newNestedItem.setAttribute("label", "New Nested Tab");
  newNestedItem.hidden = true;

  const linkNestedItem = document.createXULElement("menuitem");
  linkNestedItem.id = "context-openlinkinnestedtab";
  linkNestedItem.setAttribute("label", "Open Link in Nested Tab");
  linkNestedItem.hidden = true;

  function onTabMenuShowing(event) {
    if (event.target !== tabMenu) {
      return;
    }
    const ref = document.getElementById("context_openANewTab");
    const ctxTab = window.TabContextMenu?.contextTab;
    const show =
      state.active &&
      !!ref &&
      !!ctxTab &&
      eligible(ctxTab) &&
      !window.TabContextMenu?.multiselected;
    if (show) {
      ref.after(newNestedItem); // re-place every time: Firefox re-arranges this menu
    }
    newNestedItem.hidden = !show;
  }

  function onContentMenuShowing(event) {
    if (event.target !== contentMenu) {
      return;
    }
    const ref = document.getElementById("context-openlinkintab");
    const ctx = window.gContextMenu;
    const owner = ctx?.browser && gBrowser.getTabForBrowser(ctx.browser);
    const show =
      state.active &&
      !!ref &&
      !!ctx &&
      (ctx.onSaveableLink || ctx.onPlainTextLink) &&
      !!owner &&
      eligible(owner);
    if (show) {
      ref.after(linkNestedItem);
    }
    linkNestedItem.hidden = !show;
  }

  // ---------------------------------------------------------------------------
  // Activation
  // ---------------------------------------------------------------------------

  function syncActive() {
    const want = !!tabContainer.verticalMode;
    if (want === state.active) {
      return;
    }
    state.active = want;
    if (want) {
      rebuild();
    } else {
      clearHoldTimer();
      clearNestTarget();
      state.drag = null;
      state.tempCollapsed = null;
      render(); // clears every nested-* attribute
    }
    log(want ? "active (vertical tabs)" : "inactive (horizontal tabs)");
  }

  // ---------------------------------------------------------------------------
  // CSS
  // ---------------------------------------------------------------------------

  const CSS = `
#tabbrowser-tabs[orient="vertical"] {
  /* Collapsed subtrees hide the same way collapsed tab groups do. */
  .tabbrowser-tab[nested-hidden] {
    display: none;
  }

  &[expanded] {
    .tabbrowser-tab[nested-level] {
      /* Mirrors the native tab-group indent; grouped tabs keep their own step. */
      --nested-group-offset: 0;
      margin-inline-start: calc((var(--nested-level, 0) + var(--nested-group-offset)) * var(--space-medium, 12px));
    }
    tab-group > .tabbrowser-tab[nested-level] {
      --nested-group-offset: 1;
    }
  }

  &:not([expanded]) .tab-nest-twisty,
  &:not([expanded]) .tab-nest-count {
    display: none;
  }

  /* Firefox hides the close button until hover; keep its space on parent tabs
     so the arrow does not jump when the button appears. */
  &[expanded] .tabbrowser-tab[nested-haschildren]:not(:hover) .tab-close-button:not([selected]) {
    display: revert;
    visibility: hidden;
  }

  /* Hold-to-nest target highlight. */
  &[movingtab-nest] .tabbrowser-tab[dragover-nestTarget] > .tab-stack > .tab-background {
    outline: 2px solid var(--focus-outline-color, AccentColor);
    outline-offset: -2px;
    background-color: color-mix(in srgb, var(--focus-outline-color, AccentColor) 15%, transparent);
  }

  /* The tab a plain drop would nest under (may be far from the pointer). */
  &[movingtab]:not([movingtab-nest]) .tabbrowser-tab[dragover-nestParent] > .tab-stack > .tab-background {
    outline: 2px dashed color-mix(in srgb, var(--focus-outline-color, AccentColor) 70%, transparent);
    outline-offset: -2px;
    background-color: color-mix(in srgb, var(--focus-outline-color, AccentColor) 8%, transparent);
  }
}

#tabbrowser-tabs:not([orient="vertical"]) .tab-nest-twisty,
#tabbrowser-tabs:not([orient="vertical"]) .tab-nest-count {
  display: none;
}

/* Number of hidden descendants, shown on a collapsed parent. */
.tab-nest-count {
  margin: 0;
  margin-inline-end: 2px;
  padding: 0 6px;
  min-width: 1em;
  font-size: 0.8em;
  line-height: 1.6;
  text-align: center;
  border-radius: var(--border-radius-circle, 999px);
  background-color: color-mix(in srgb, currentColor 12%, transparent);
}

.tab-nest-twisty {
  -moz-context-properties: fill, fill-opacity;
  fill: currentColor;
  width: 24px;
  height: 24px;
  box-sizing: border-box;
  padding: var(--tab-close-button-padding, 6px);
  border-radius: calc(var(--tab-border-radius, 4px) - 3px);
  list-style-image: url("chrome://global/skin/icons/arrow-up.svg");

  .tabbrowser-tab[nested-collapsed] & {
    list-style-image: url("chrome://global/skin/icons/arrow-down.svg");
  }
  &:hover {
    background-color: color-mix(in srgb, currentColor 10%, transparent);
  }
  &:hover:active {
    background-color: color-mix(in srgb, currentColor 20%, transparent);
  }
}
`;

  function injectCSS() {
    const id = "vertical-nested-tabs-style";
    if (document.getElementById(id)) {
      return;
    }
    const style = document.createElementNS("http://www.w3.org/1999/xhtml", "style");
    style.id = id;
    style.textContent = CSS;
    document.documentElement.appendChild(style);
    state.undo.push(() => style.remove());
  }

  // ---------------------------------------------------------------------------
  // Install
  // ---------------------------------------------------------------------------

  function patch(obj, name, wrapper) {
    const original = obj[name];
    if (typeof original !== "function") {
      throw new Error(`${name} is not a function`);
    }
    obj[name] = wrapper;
    state.undo.push(() => {
      if (obj[name] === wrapper) {
        delete obj[name];
        if (obj[name] !== original) {
          obj[name] = original;
        }
      }
    });
  }

  function listen(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    state.undo.push(() => target.removeEventListener(type, handler, options));
  }

  function install() {
    injectCSS();

    // `tab.visible` drives visibleTabs, drag indices and keyboard navigation.
    const TabProto = customElements.get("tabbrowser-tab")?.prototype;
    const desc = TabProto && Object.getOwnPropertyDescriptor(TabProto, "visible");
    if (desc?.get && !desc.get.__vntPatched) {
      const getter = function () {
        return desc.get.call(this) && !this.hasAttribute("nested-hidden");
      };
      getter.__vntPatched = true;
      Object.defineProperty(TabProto, "visible", { ...desc, get: getter });
      state.undo.push(() => Object.defineProperty(TabProto, "visible", desc));
    } else if (!desc?.get) {
      throw new Error("tabbrowser-tab has no `visible` getter");
    }

    patch(gBrowser, "removeTab", removeTabWrapper);
    patch(dnd, "handle_dragstart", dragStartWrapper);
    patch(dnd, "handle_dragover", dragOverWrapper);
    patch(dnd, "handle_drop", dropWrapper);
    patch(dnd, "handle_dragend", dragEndWrapper);
    patch(dnd, "_triggerDragOverGrouping", triggerGroupingWrapper);

    const tabEvents = {
      TabOpen: e => onTabOpen(e.target, e.detail),
      TabClose: e => onTabClose(e.target, e.detail),
      TabMove: e => onTabMove(e.target),
      TabPinned: e => {
        detach(e.target);
        scheduleRender();
      },
      TabUnpinned: e => {
        if (state.parentOf.has(e.target)) {
          setParentRaw(e.target, null);
        }
        scheduleRender();
      },
      TabSelect: e => onTabSelect(e.target),
      TabGrouped: () => scheduleRender(),
      TabUngrouped: () => scheduleRender(),
      TabGroupCollapse: () => scheduleRender(),
      TabGroupExpand: () => scheduleRender(),
      SplitViewCreated: () => scheduleRender(),
    };
    for (const [type, handler] of Object.entries(tabEvents)) {
      listen(tabContainer, type, handler);
    }

    listen(tabContainer, "mousedown", onTwistyMouseDown, true);
    listen(tabContainer, "click", onTwistyClick, true);
    listen(tabContainer, "dblclick", onTwistySwallow, true);
    listen(tabContainer, "dragstart", onTwistySwallow, true);

    listen(window, "SSWindowStateBusy", () => {
      state.restoring = true;
    });
    listen(window, "SSWindowStateReady", () => {
      state.restoring = false;
      scheduleRebuild();
    });
    listen(window, "SSWindowRestored", () => scheduleRebuild());
    listen(window, "SSTabRestoring", () => scheduleRebuild());

    if (tabMenu) {
      listen(tabMenu, "popupshowing", onTabMenuShowing);
      listen(newNestedItem, "command", () => openNewNestedTab(window.TabContextMenu?.contextTab));
      state.undo.push(() => newNestedItem.remove());
    }
    if (contentMenu) {
      listen(contentMenu, "popupshowing", onContentMenuShowing);
      listen(linkNestedItem, "command", () => openLinkInNestedTab());
      state.undo.push(() => linkNestedItem.remove());
    }

    const observer = new MutationObserver(() => syncActive());
    observer.observe(tabContainer, { attributes: true, attributeFilter: ["orient", "expanded"] });
    state.undo.push(() => observer.disconnect());

    state.active = !!tabContainer.verticalMode;
    rebuild();
    log(`v${VERSION} loaded;`, state.active ? "active (vertical tabs)" : "inactive (horizontal tabs)");
  }

  function uninstall() {
    while (state.undo.length) {
      try {
        state.undo.pop()();
      } catch (e) {
        warn("uninstall step failed", e);
      }
    }
    state.active = false;
    for (const tab of gBrowser.tabs) {
      clearTabAttributes(tab);
      tab.querySelector(".tab-nest-twisty")?.remove();
      tab.querySelector(".tab-nest-count")?.remove();
    }
    tabContainer._invalidateCachedVisibleTabs?.();
    try {
      delete window.VerticalNestedTabs;
    } catch (e) {
      window.VerticalNestedTabs = undefined;
    }
    // Loaded with `var`, so it cannot be deleted; a falsy value makes loadModel() reload it.
    try {
      window.NestedTabsModel = undefined;
    } catch (e) {}
  }

  try {
    install();
  } catch (e) {
    warn("install failed, rolling back:", e);
    uninstall();
    return;
  }

  // Small API for the Browser Console / tests.
  window.VerticalNestedTabs = {
    version: VERSION,
    get active() {
      return state.active;
    },
    parentOf,
    childrenOf: tab => Model.childrenOf(unpinnedOrder(), state.parentOf, tab),
    descendantsOf: tab => Model.descendantsOf(unpinnedOrder(), state.parentOf, tab),
    isCollapsed: tab => state.collapsed.has(tab),
    setParent(tab, parent) {
      if (parent) {
        return nestUnder([tab], parent);
      }
      const ok = setParent(tab, null);
      relayout();
      return ok;
    },
    setCollapsed,
    openNewNestedTab,
    rebuild,
    uninstall,
    _state: state,
    _afterAdopt: afterAdopt,
    _afterDrop: afterDrop,
    _overlapTargetTab: overlapTargetTab,
    _updateDropParentPreview: updateDropParentPreview,
    _endDrag: endDrag,
    _relayout: relayout,
  };
})();
