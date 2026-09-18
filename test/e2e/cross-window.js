// A subtree follows its parent to another window: (a) drop into an existing window (adoptTab),
// (b) drag out to a new window (replaceTabsWithWindow).
module.exports = async m => {
  let failures = 0;
  const check = (n, ok, d) => { console.log((ok ? "PASS " : "FAIL ") + n + (ok ? "" : " " + JSON.stringify(d))); if (!ok) failures++; };

  const r = await m.execAsync(`
    const w = window; const gB = w.gBrowser; const done = arguments[arguments.length - 1];
    const sleep = ms => new Promise(r => w.setTimeout(r, ms));
    const byLabel = (win, l) => win.gBrowser.tabs.find(t => t.label === l);
    const dump = win => win.gBrowser.tabs.filter(t => t.linkedBrowser.currentURI.spec !== "about:blank").map(t => ({
      l: t.label, lvl: t.getAttribute("nested-level"), col: t.hasAttribute("nested-collapsed"), hid: t.hasAttribute("nested-hidden"),
      parent: win.VerticalNestedTabs && win.VerticalNestedTabs.parentOf(t) ? win.VerticalNestedTabs.parentOf(t).label : null }));
    (async () => {
      try {
        // clean this window
        const keep = gB.tabs.find(t => t.linkedBrowser.currentURI.spec === "about:blank") || gB.tabs[0];
        gB.selectedTab = keep;
        for (const t of gB.tabs.filter(t => t !== keep)) { if (t.pinned) gB.unpinTab(t); gB.removeTab(t, { skipPermitUnload: true }); }
        // live reload so the test uses the current script
        if (w.VerticalNestedTabs) w.VerticalNestedTabs.uninstall();
        try { w.NestedTabsModel = undefined; } catch (e) {}
        const file = Services.dirsvc.get("UChrm", Ci.nsIFile); file.append("vertical-nested-tabs.uc.js");
        Services.scriptloader.loadSubScriptWithOptions(Services.io.newFileURI(file).spec, { target: w, ignoreCache: true, allowUnsafeURL: true });
        const V = w.VerticalNestedTabs;
        const open = l => gB.addTrustedTab("data:text/html,<title>" + l + "</title>" + l, { skipAnimation: true });
        for (const l of ["X", "X1", "X1a", "X2", "Y"]) open(l);
        for (let i = 0; i < 100; i++) { await sleep(100); if (["X","X1","X1a","X2","Y"].every(l => byLabel(w, l))) break; }
        V.setParent(byLabel(w, "X1"), byLabel(w, "X"));
        V.setParent(byLabel(w, "X1a"), byLabel(w, "X1"));
        V.setParent(byLabel(w, "X2"), byLabel(w, "X"));
        V.setCollapsed(byLabel(w, "X1"), true);
        await sleep(200);
        const before = dump(w);

        // (a) open a second window, wait for it to finish starting, adopt X there (what a drop does)
        const w2 = w.OpenBrowserWindow();
        await new Promise(r => w2.addEventListener("load", r, { once: true }));
        await w2.delayedStartupPromise;
        for (let i = 0; i < 50; i++) { await sleep(100); if (w2.VerticalNestedTabs) break; }
        w2.gBrowser.adoptTab(byLabel(w, "X"), { tabIndex: w2.gBrowser.tabs.length, selectTab: true });
        for (let i = 0; i < 60; i++) { await sleep(100); if (byLabel(w2, "X1a") && !byLabel(w, "X1a")) break; }
        await sleep(600);
        const a = { src: dump(w), dst: dump(w2), dstActive: w2.VerticalNestedTabs && w2.VerticalNestedTabs.active };

        // (b) drag X out of w2 into a brand-new window
        const w3 = w2.gBrowser.replaceTabsWithWindow(byLabel(w2, "X"));
        await new Promise(r => { if (w3.document.readyState === "complete") r(); else w3.addEventListener("load", r, { once: true }); });
        await w3.delayedStartupPromise;
        for (let i = 0; i < 80; i++) { await sleep(100); if (w3.VerticalNestedTabs && byLabel(w3, "X1a") && !byLabel(w2, "X1a")) break; }
        await sleep(600);
        const b = { src: dump(w2), dst: dump(w3) };

        // (c) bring it back into the first window, then close the extra windows
        gB.adoptTab(byLabel(w3, "X"), { tabIndex: gB.tabs.length, selectTab: false });
        for (let i = 0; i < 80; i++) { await sleep(100); if (byLabel(w, "X1a") && (w3.closed || !byLabel(w3, "X1a"))) break; }
        await sleep(600);
        const c = { src: dump(w), w3closed: w3.closed };
        const warnings = { w: w.VerticalNestedTabs._state.warnings.slice(), w2: w2.closed ? null : (w2.VerticalNestedTabs ? w2.VerticalNestedTabs._state.warnings.slice() : "no api"), w3: w3.closed ? null : (w3.VerticalNestedTabs ? w3.VerticalNestedTabs._state.warnings.slice() : "no api") };
        if (!w2.closed) w2.close();
        if (!w3.closed) w3.close();
        const errors = Services.console.getMessageArray().map(x => x.message || String(x)).filter(s => s.includes("[vertical-nested-tabs]") || s.includes("vertical-nested-tabs.uc.js")).slice(-5);
        done({ before, a, b, c, errors, warnings });
      } catch (e) { done({ error: String(e), stack: e.stack }); }
    })();
  `);
  console.log(JSON.stringify(r, null, 1));
  if (r.error) { console.log("FAIL (exception)"); process.exitCode = 1; return; }
  console.log("warnings:", JSON.stringify(r.warnings, null, 1));
  const tree0 = d => JSON.stringify((d || []).map(x => [x.l, x.parent]));
  if (!r.a || !r.a.dst.find(x => x.l === "X1")) { console.log("FAIL early: a.dst =", tree0(r.a && r.a.dst)); process.exitCode = 1; return; }
  const tree = d => JSON.stringify(d.map(x => [x.l, x.parent]));
  const expected = JSON.stringify([["X", null], ["X1", "X"], ["X1a", "X1"], ["X2", "X"]]);
  check("(a) subtree left the source window", tree(r.a.src) === JSON.stringify([["Y", null]]), r.a.src);
  check("(a) subtree arrived in order with links", tree(r.a.dst) === expected && r.a.dstActive, r.a.dst);
  check("(a) collapsed state travelled", r.a.dst.find(x => x.l === "X1").col && r.a.dst.find(x => x.l === "X1a").hid, r.a.dst);
  check("(b) drag-out to new window carries subtree", tree(r.b.dst) === expected && r.b.src.length === 0, r.b);
  check("(c) back into the first window after Y", tree(r.c.src) === JSON.stringify([["Y", null], ["X", null], ["X1", "X"], ["X1a", "X1"], ["X2", "X"]]), r.c.src);
  check("no script errors", r.errors.length === 0, r.errors);
  console.log(failures ? `${failures} FAILURE(S)` : "ALL PASSED");
  if (failures) process.exitCode = 1;
};
