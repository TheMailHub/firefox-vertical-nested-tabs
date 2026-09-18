// Functional test of the tree through the chrome API, run in the test Firefox.
const path = require("node:path");
let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? "PASS " : "FAIL ") + name + (ok ? "" : "  " + JSON.stringify(detail)));
  if (!ok) failures++;
}

// Helpers evaluated inside the chrome window. Tabs are identified by label.
const PRELUDE = `
  const w = window; const gB = w.gBrowser; const V = w.VerticalNestedTabs;
  const byLabel = l => gB.tabs.find(t => t.getAttribute("label") === l || t.label === l);
  const isInitial = t => t.linkedBrowser && t.linkedBrowser.currentURI && t.linkedBrowser.currentURI.spec === "about:blank";
  const dump = () => gB.tabs.filter(t => !t.pinned && !isInitial(t)).map(t => ({
    l: t.label, lvl: t.getAttribute("nested-level"), kids: t.hasAttribute("nested-haschildren"),
    col: t.hasAttribute("nested-collapsed"), hid: t.hasAttribute("nested-hidden"),
    vis: t.visible, parent: V.parentOf(t) ? V.parentOf(t).label : null,
    twisty: (() => { const x = t.querySelector(".tab-nest-twisty"); return x ? !x.hidden : "none"; })(),
    group: t.group ? t.group.id : null,
  }));
  const open = (label) => {
    const t = gB.addTrustedTab("data:text/html,<title>" + label + "</title>" + label, { skipAnimation: true });
    return t;
  };
  const sleep = ms => new Promise(r => w.setTimeout(r, ms));
`;

module.exports = async m => {
  // 0. live-reload the script (exercises uninstall + loader path)
  const reload = await m.exec(PRELUDE + `
    if (w.VerticalNestedTabs) { w.VerticalNestedTabs.uninstall(); }
    try { w.NestedTabsModel = undefined; } catch (e) {}
    const file = Services.dirsvc.get("UChrm", Ci.nsIFile); file.append("vertical-nested-tabs.uc.js");
    Services.scriptloader.loadSubScriptWithOptions(Services.io.newFileURI(file).spec, { target: w, ignoreCache: true, allowUnsafeURL: true });
    return { reloaded: !!w.VerticalNestedTabs, active: w.VerticalNestedTabs.active, hooks: typeof w.VerticalNestedTabs._afterDrop };
  `);
  check("live reload", reload.reloaded && reload.active && reload.hooks === "function", reload);

  // 1. start clean: keep only the initial blank tab, then open tabs and wait for titles
  await m.execAsync(PRELUDE + `
    const done = arguments[arguments.length - 1];
    const keep = gB.tabs.find(isInitial) || gB.tabs[0];
    gB.selectedTab = keep;
    for (const t of gB.tabs.filter(t => t !== keep)) { if (t.pinned) gB.unpinTab(t); gB.removeTab(t, { skipPermitUnload: true }); }
    for (const l of ["A", "B", "C", "D"]) open(l);
    (async () => {
      for (let i = 0; i < 100; i++) { await sleep(100); if (["A","B","C","D"].every(byLabel)) break; }
      done(dump());
    })();
  `);
  let d = await m.exec(PRELUDE + `return dump();`);
  check("4 tabs are roots", ["A", "B", "C", "D"].every(l => d.find(x => x.l === l && x.lvl === "0" && !x.parent)), d);

  // 2. New Nested Tab under A
  d = await m.execAsync(PRELUDE + `
    const done = arguments[arguments.length - 1];
    V.openNewNestedTab(byLabel("A"));
    (async () => { await sleep(300); done(dump()); })();
  `);
  {
    const a = d.findIndex(x => x.l === "A");
    const child = d[a + 1];
    check("new nested tab is A's first child", child && child.parent === "A" && child.lvl === "1", d);
    check("A shows twisty, has children", d[a].kids && d[a].twisty === true && !d[a].col, d[a]);
  }
  // rename the new tab for readability: it is about:newtab; label it via a data url
  await m.execAsync(PRELUDE + `
    const done = arguments[arguments.length - 1];
    const t = gB.tabs.find(t => V.parentOf(t) && V.parentOf(t).label === "A");
    t.linkedBrowser.loadURI(Services.io.newURI("data:text/html,<title>A1</title>A1"), { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
    (async () => { for (let i = 0; i < 50; i++) { await sleep(100); if (byLabel("A1")) break; } done(true); })();
  `);

  // 3. nest B under A (last child), C under B
  d = await m.exec(PRELUDE + `
    V.setParent(byLabel("B"), byLabel("A"));
    V.setParent(byLabel("C"), byLabel("B"));
    return dump();
  `);
  {
    const labels = d.map(x => x.l);
    check("order is A, A1, B, C, D", JSON.stringify(labels) === JSON.stringify(["A", "A1", "B", "C", "D"]), labels);
    check("levels 0,1,1,2,0", d.map(x => x.lvl).join() === "0,1,1,2,0", d.map(x => x.lvl));
    check("C parent is B", d.find(x => x.l === "C").parent === "B", d);
  }
  // persisted values
  const persisted = await m.exec(PRELUDE + `
    const SS = w.SessionStore;
    const c = byLabel("C"), b = byLabel("B");
    return { cParent: SS.getCustomTabValue(c, "nestedTabs:parent"), bId: SS.getCustomTabValue(b, "nestedTabs:id") };
  `);
  check("parent link persisted in SessionStore", persisted.cParent && persisted.cParent === persisted.bId, persisted);

  await m.screenshot(path.join(require("node:os").tmpdir(), "vnt-shot-tree.png"));

  // 4. collapse A -> A1, B, C hidden and not visible; visibleTabs shrinks
  d = await m.exec(PRELUDE + `
    gB.selectedTab = byLabel("C");
    V.setCollapsed(byLabel("A"), true);
    return { d: dump(), selected: gB.selectedTab.label, visible: gB.visibleTabs.filter(t => !isInitial(t)).map(t => t.label) };
  `);
  check("collapse: selected moved to A", d.selected === "A", d.selected);
  check("collapse: descendants hidden", ["A1", "B", "C"].every(l => { const x = d.d.find(y => y.l === l); return x.hid && x.vis === false; }), d.d);
  check("collapse: visibleTabs excludes hidden", JSON.stringify(d.visible) === JSON.stringify(["A", "D"]), d.visible);
  check("collapse: A marked collapsed", d.d.find(x => x.l === "A").col, d.d);
  const badge = await m.execAsync(PRELUDE + `
    const done = arguments[arguments.length - 1];
    const a = byLabel("A"); const c = a.querySelector(".tab-nest-count");
    gB.selectedTab = byLabel("D"); // the selected tab always shows its close button
    (async () => {
      const cb = a.querySelector(".tab-close-button");
      for (let i = 0; i < 30; i++) { await sleep(100); if (!cb.hasAttribute("selected")) break; }
      const cs = w.getComputedStyle(cb);
      const r = { hidden: c.hidden, value: c.getAttribute("value"), closeDisplay: cs.display, closeVisibility: cs.visibility,
        closeSelected: cb.hasAttribute("selected"), hovered: a.matches(":hover") };
      gB.selectedTab = a;
      done(r);
    })();
  `);
  check("collapse: badge shows 3 hidden descendants", badge.hidden === false && badge.value === "3", badge);
  check("parent keeps close-button space when not hovered", badge.closeDisplay !== "none" && badge.closeVisibility === "hidden", badge);
  await m.screenshot(path.join(require("node:os").tmpdir(), "vnt-shot-collapsed.png"));

  // 5. selecting a hidden tab expands ancestors
  d = await m.exec(PRELUDE + `
    gB.selectedTab = byLabel("C");
    return { d: dump(), selected: gB.selectedTab.label };
  `);
  check("select hidden tab expands ancestors", d.selected === "C" && d.d.every(x => !x.hid) && !d.d.find(x => x.l === "A").col, d);

  // 6. close expanded parent B -> C promoted to A
  d = await m.execAsync(PRELUDE + `
    const done = arguments[arguments.length - 1];
    gB.removeTab(byLabel("B"));
    (async () => { await sleep(200); done(dump()); })();
  `);
  check("close expanded parent promotes child", d.find(x => x.l === "C").parent === "A" && d.find(x => x.l === "C").lvl === "1", d);

  // 7. collapse A and close it -> subtree closes as one; reopen restores it
  d = await m.execAsync(PRELUDE + `
    const done = arguments[arguments.length - 1];
    V.setCollapsed(byLabel("A"), true);
    const before = gB.tabs.length;
    gB.removeTab(byLabel("A"));
    (async () => {
      await sleep(300);
      const SS = w.SessionStore;
      done({ before, after: gB.tabs.length, labels: gB.tabs.map(t => t.label),
             lastClosedCount: SS.getLastClosedTabCount(w), closedCount: SS.getClosedTabCountForWindow(w) });
    })();
  `);
  check("closing collapsed parent closes subtree (3 tabs)", d.before - d.after === 3 && !d.labels.includes("A"), d);
  check("SessionStore counts them as one reopen group", d.lastClosedCount === 3, d);

  d = await m.execAsync(PRELUDE + `
    const done = arguments[arguments.length - 1];
    const { SessionWindowUI } = ChromeUtils.importESModule("moz-src:///browser/components/sessionstore/SessionWindowUI.sys.mjs");
    SessionWindowUI.undoCloseTab(w);
    (async () => {
      for (let i = 0; i < 60; i++) { await sleep(100); if (byLabel("A") && byLabel("A1") && byLabel("C") && !w.VerticalNestedTabs._state.restoring) break; }
      await sleep(300);
      done({ d: dump(), selected: gB.selectedTab.label });
    })();
  `);
  {
    const sel = d.selected; d = d.d;
    const a = d.find(x => x.l === "A"), a1 = d.find(x => x.l === "A1"), c = d.find(x => x.l === "C");
    check("reopen restores subtree links", a && a1 && c && a1.parent === "A" && c.parent === "A", d);
    check("reopened parent is still collapsed, children hidden", a && a.col && a1.hid && c.hid, d);
    check("reopen selects the collapsed parent, not a hidden child", sel === "A", sel);
    check("reopened subtree contiguous", JSON.stringify(d.map(x => x.l)) === JSON.stringify(["A", "A1", "C", "D"]), d.map(x => x.l));
  }

  // 8. pin a child -> it leaves the tree
  d = await m.exec(PRELUDE + `
    V.setCollapsed(byLabel("A"), false);
    gB.pinTab(byLabel("C"));
    const r = { d: dump(), cPinned: byLabel("C").pinned, cParent: V.parentOf(byLabel("C")) };
    gB.unpinTab(byLabel("C"));
    r.afterUnpin = dump();
    return r;
  `);
  check("pinning detaches from tree", d.cPinned && d.cParent === null && !d.d.find(x => x.l === "C"), d);
  check("unpinned tab is a root", d.afterUnpin.find(x => x.l === "C").parent === null, d.afterUnpin);

  // 9. native tab group on parent -> child detaches (subtree stays in one group)
  d = await m.execAsync(PRELUDE + `
    const done = arguments[arguments.length - 1];
    V.setParent(byLabel("C"), byLabel("A"));
    const g = gB.addTabGroup([byLabel("A")], { insertBefore: byLabel("A"), label: "G" });
    (async () => { await sleep(300); done({ d: dump(), gid: g.id }); })();
  `);
  check("grouping the parent alone detaches children", d.d.filter(x => x.parent === "A").length === 0 && d.d.find(x => x.l === "A").group === d.gid, d);
  d = await m.execAsync(PRELUDE + `
    const done = arguments[arguments.length - 1];
    V.setParent(byLabel("A1"), byLabel("A"));
    (async () => { await sleep(200); done(dump()); })();
  `);
  check("nesting under grouped parent joins the group", (() => { const a = d.find(x => x.l === "A"), a1 = d.find(x => x.l === "A1"); return a1.parent === "A" && a1.group === a.group && d.indexOf(a1) === d.indexOf(a) + 1; })(), d);
  await m.exec(PRELUDE + `gB.ungroupTab(byLabel("A")); gB.ungroupTab(byLabel("A1"));`);

  // 10. moving a parent moves its subtree (TabMove path)
  d = await m.execAsync(PRELUDE + `
    const done = arguments[arguments.length - 1];
    V.setParent(byLabel("C"), byLabel("A"));
    gB.moveTabToEnd(byLabel("A"));
    (async () => { await sleep(200); done(dump()); })();
  `);
  {
    const labels = d.map(x => x.l);
    check("moveTabToEnd carries the subtree", JSON.stringify(labels.slice(-3)) === JSON.stringify(["A", "A1", "C"]) && d.find(x => x.l === "C").parent === "A", labels);
  }

  // 11. drop logic: plain drop before D at top level -> root; nest via hold snapshot
  d = await m.execAsync(PRELUDE + `
    const done = arguments[arguments.length - 1];
    // simulate native having moved C before D, dropBefore = true
    gB.moveTabsBefore([byLabel("C")], byLabel("D"));
    V._afterDrop({ draggedTab: byLabel("C"), movingTabs: [byLabel("C")], dropElement: byLabel("D"), dropBefore: true, nestParent: null, fromTabList: false });
    const r1 = dump();
    // simulate a hold-to-nest drop of D onto A
    gB.moveTabsAfter([byLabel("D")], byLabel("A"));
    V._afterDrop({ draggedTab: byLabel("D"), movingTabs: [byLabel("D")], dropElement: byLabel("A"), dropBefore: false, nestParent: byLabel("A"), fromTabList: false });
    const r2 = dump();
    (async () => { await sleep(100); done({ r1, r2 }); })();
  `);
  check("plain drop before a root makes a root", d.r1.find(x => x.l === "C").parent === null, d.r1);
  check("hold-to-nest drop appends as last child", (() => { const labels = d.r2.map(x => x.l); const a = labels.indexOf("A"); return d.r2.find(x => x.l === "D").parent === "A" && labels[a + 1] === "A1" && labels[a + 2] === "D"; })(), d.r2);

  // 11b. un-nesting by dropping a child below a root tab, with Firefox's deferred move
  d = await m.execAsync(PRELUDE + `
    const done = arguments[arguments.length - 1];
    // tree: A > [A1, D], C root after it (from step 11)
    const child = byLabel("A1"), n = byLabel("C");
    // Firefox moves the tab after the drop animation, while our drop is still "in progress"
    V._state.inDrop = true;
    gB.moveTabsAfter([child], n);
    V._afterDrop({ draggedTab: child, movingTabs: [child], dropElement: n, dropBefore: false, nestParent: null, fromTabList: false });
    V._state.inDrop = false;
    (async () => { await sleep(150); done(dump()); })();
  `);
  {
    const labels = d.map(x => x.l);
    check("un-nest by dropping below a root: lands below it as a root", labels.indexOf("A1") === labels.indexOf("C") + 1 && d.find(x => x.l === "A1").parent === null, labels);
    // put it back for the following steps
    await m.exec(PRELUDE + `V.setParent(byLabel("A1"), byLabel("A"));`);
  }

  // 12. nest target = the tab the dragged tab visibly overlaps
  d = await m.exec(PRELUDE + `
    const a = byLabel("A"); const c = byLabel("C");
    const ra = a.getBoundingClientRect(); const rc = c.getBoundingClientRect();
    c._dragData = { movingTabs: [c] };
    const dy = ra.top - rc.top; // C exactly over A
    const at = frac => { c.style.transform = "translateY(" + (dy + ra.height * frac) + "px)"; return V._overlapTargetTab(c); };
    const full = at(0), half = at(0.5);
    // below the last tab there is no neighbour to fall onto
    const lastTab = gB.visibleTabs.filter(t => t !== c).at(-1);
    const dd = lastTab.getBoundingClientRect(); const dyD = dd.top - rc.top;
    const atD = frac => { c.style.transform = "translateY(" + (dyD + dd.height * frac) + "px)"; return V._overlapTargetTab(c); };
    const slight = atD(0.9), none = atD(3);
    // A slides away (as Firefox does once the dragged tab covers it): overlap gone
    c.style.transform = "translateY(" + dy + "px)"; a.style.transform = "translateY(" + (ra.height * 2) + "px)";
    const slidAway = V._overlapTargetTab(c);
    a.style.transform = ""; c.style.transform = ""; delete c._dragData;
    return { full: full && full.label, half: half && half.label, slight: slight && slight.label, none: none && none.label, slidAway: slidAway && slidAway.label };
  `);
  check("overlap: fully over A -> A", d.full === "A", d);
  check("overlap: half over A -> A", d.half === "A", d);
  check("overlap: barely touching -> none", d.slight === null, d);
  check("overlap: nowhere near -> none", d.none === null, d);
  check("overlap: target slid away -> none (gap never nests)", d.slidAway === null, d);

  // 12b. drop-parent preview: dragging next to a nested child lights up its parent
  d = await m.exec(PRELUDE + `
    const a = byLabel("A"), a1 = byLabel("A1"), c = byLabel("C");
    c._dragData = { movingTabs: [c], dropElement: a1, dropBefore: true };
    V._state.drag = { draggedTab: c };
    V._updateDropParentPreview(c);
    const r1 = { aLit: a.hasAttribute("dragover-nestParent"), level: c.style.getPropertyValue("--nested-level") };
    c._dragData.dropElement = a; c._dragData.dropBefore = true; // before a root -> root
    V._updateDropParentPreview(c);
    const r2 = { aLit: a.hasAttribute("dragover-nestParent"), level: c.style.getPropertyValue("--nested-level") };
    delete c._dragData;
    V._endDrag();
    const r3 = { aLit: a.hasAttribute("dragover-nestParent") };
    return { r1, r2, r3 };
  `);
  check("preview: dropping beside a child lights up its parent and previews indent", d.r1.aLit && d.r1.level === "1", d);
  check("preview: dropping before a root clears it", !d.r2.aLit && d.r2.level === "0", d);
  check("preview: cleared when the drag ends", !d.r3.aLit, d);

  // 13. context menu item appears via real popup
  d = await m.execAsync(PRELUDE + `
    const done = arguments[arguments.length - 1];
    const menu = w.document.getElementById("tabContextMenu");
    const tab = byLabel("A");
    menu.addEventListener("popupshown", () => {
      const item = w.document.getElementById("context_newNestedTab");
      const ref = w.document.getElementById("context_openANewTab");
      const r = { present: !!item, hidden: item ? item.hidden : null, afterRef: item && ref && ref.nextElementSibling === item, label: item && item.getAttribute("label") };
      menu.hidePopup();
      done(r);
    }, { once: true });
    menu.openPopup(tab, "after_start", 0, 0, true, false, null);
    w.TabContextMenu.contextTab = tab;
  `);
  check("tab context menu shows 'New Nested Tab' after 'New Tab Below'", d.present && d.hidden === false && d.afterRef, d);

  // 14. vertical off -> inert; on -> tree restored
  d = await m.execAsync(PRELUDE + `
    const done = arguments[arguments.length - 1];
    Services.prefs.setBoolPref("sidebar.verticalTabs", false);
    (async () => {
      for (let i = 0; i < 50; i++) { await sleep(100); if (!gB.tabContainer.verticalMode) break; }
      await sleep(300);
      const off = { active: V.active, attrs: gB.tabs.some(t => t.hasAttribute("nested-level") || t.hasAttribute("nested-hidden")), vis: gB.visibleTabs.length, tabs: gB.tabs.length };
      Services.prefs.setBoolPref("sidebar.verticalTabs", true);
      for (let i = 0; i < 50; i++) { await sleep(100); if (gB.tabContainer.verticalMode) break; }
      await sleep(300);
      done({ off, on: { active: V.active, d: dump() } });
    })();
  `);
  check("horizontal: inactive, no attributes, all visible", !d.off.active && !d.off.attrs && d.off.vis === d.off.tabs, d.off);
  check("vertical again: tree restored", d.on.active && d.on.d.find(x => x.l === "A1").parent === "A" && d.on.d.find(x => x.l === "D").parent === "A", d.on);

  await m.screenshot(path.join(require("node:os").tmpdir(), "vnt-shot-final.png"));
  const errors = await m.exec(`
    return Services.console.getMessageArray().map(x => x.message || String(x)).filter(s => s.includes("[vertical-nested-tabs]") || s.includes("vertical-nested-tabs.uc.js")).slice(-10);
  `);
  check("no script errors in console", errors.length === 0, errors);
  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASSED");
  if (failures) process.exitCode = 1;
};
