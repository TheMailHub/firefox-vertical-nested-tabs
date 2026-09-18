// A link clicked in a *collapsed* parent opens a new tab as that parent's child.
// The new tab is selected, so the parent must expand or the selected tab is hidden.
module.exports = async m => {
  let failures = 0;
  const check = (n, ok, d) => { console.log((ok ? "PASS " : "FAIL ") + n + (ok ? "" : " " + JSON.stringify(d))); if (!ok) failures++; };

  // chrome: parent page "CP" with a target=_blank link, one child under it, then collapse CP
  const setup = await m.execAsync(`
    const w = window; const gB = w.gBrowser; const V = w.VerticalNestedTabs; const done = arguments[arguments.length - 1];
    const sleep = ms => new Promise(r => w.setTimeout(r, ms));
    const keep = gB.tabs.find(t => t.linkedBrowser.currentURI.spec === "about:blank") || gB.tabs[0];
    gB.selectedTab = keep;
    for (const t of gB.tabs.filter(t => t !== keep)) { if (t.pinned) gB.unpinTab(t); gB.removeTab(t, { skipPermitUnload: true }); }
    const html = '<title>CP</title><a id="l" target="_blank" href="http://127.0.0.1:9/CL" style="font-size:40px;display:block;margin:60px">link</a>';
    const parent = gB.addTrustedTab("data:text/html," + encodeURIComponent(html), { skipAnimation: true });
    const child = gB.addTrustedTab("data:text/html,<title>C1</title>C1", { skipAnimation: true });
    (async () => {
      for (let i = 0; i < 100; i++) { await sleep(100); if (parent.label === "CP" && child.label === "C1" && !parent.linkedBrowser.webProgress.isLoadingDocument) break; }
      V.setParent(child, parent);
      V.setCollapsed(parent, true);
      gB.selectedTab = parent;
      await sleep(300);
      w.__vntExisting = new Set(gB.tabs);
      done({ collapsed: V.isCollapsed(parent), childHidden: child.hasAttribute("nested-hidden"), selected: gB.selectedTab.label });
    })().catch(e => done({ error: String(e) }));
  `);
  console.log(JSON.stringify(setup));
  check("parent collapsed with hidden child and selected", setup.collapsed && setup.childHidden && setup.selected === "CP", setup);

  // content: real left-click on the link
  await m.send("Marionette:SetContext", { value: "content" });
  const handles = (await m.send("WebDriver:GetWindowHandles", {})).value || (await m.send("WebDriver:GetWindowHandles", {}));
  let found = false;
  for (const h of handles) {
    await m.send("WebDriver:SwitchToWindow", { handle: h });
    const title = (await m.send("WebDriver:GetTitle", {})).value;
    if (title === "CP") { found = true; break; }
  }
  if (!found) throw new Error("CP tab not found among handles " + JSON.stringify(handles));
  const el = await m.send("WebDriver:FindElement", { using: "css selector", value: "#l" });
  const ref = el.value;
  const elId = ref[Object.keys(ref)[0]];
  await m.send("WebDriver:PerformActions", { actions: [{
    type: "pointer", id: "mouse", parameters: { pointerType: "mouse" },
    actions: [
      { type: "pointerMove", origin: { [Object.keys(ref)[0]]: elId }, x: 0, y: 0, duration: 50 },
      { type: "pointerDown", button: 0 },
      { type: "pointerUp", button: 0 },
    ],
  }] });
  await m.send("Marionette:SetContext", { value: "chrome" });

  const r = await m.execAsync(`
    const w = window; const gB = w.gBrowser; const V = w.VerticalNestedTabs; const done = arguments[arguments.length - 1];
    const sleep = ms => new Promise(r => w.setTimeout(r, ms));
    (async () => {
      const byLabel = l => gB.tabs.find(t => t.label === l);
      let child = null;
      for (let i = 0; i < 50; i++) { await sleep(100); child = gB.tabs.find(t => !w.__vntExisting.has(t)); if (child) break; }
      await sleep(500);
      const parent = byLabel("CP"); const c1 = byLabel("C1");
      const errors = Services.console.getMessageArray().map(x => x.message || String(x)).filter(s => s.includes("[vertical-nested-tabs]") || s.includes("vertical-nested-tabs.uc.js")).slice(-5);
      done({ errors, selected: gB.selectedTab === child ? "CL" : gB.selectedTab.label,
        parent: { collapsed: V.isCollapsed(parent), colAttr: parent.hasAttribute("nested-collapsed") },
        c1: c1 && { hidden: c1.hasAttribute("nested-hidden"), visible: c1.visible },
        child: child ? { parent: V.parentOf(child) && V.parentOf(child).label, lvl: child.getAttribute("nested-level"), hidden: child.hasAttribute("nested-hidden"), visible: child.visible, index: child.index, parentIndex: parent.index } : null });
    })().catch(e => done({ error: String(e) }));
  `);
  console.log(JSON.stringify(r));
  check("link opened as nested child of the collapsed parent", r.child && r.child.parent === "CP" && r.child.lvl === "1" && r.child.index > r.child.parentIndex, r);
  check("new tab is selected", r.selected === "CL", r);
  check("parent expanded so the selected tab is visible", r.child && !r.parent.collapsed && !r.parent.colAttr && !r.child.hidden && r.child.visible, r);
  check("sibling child visible again too", r.c1 && !r.c1.hidden && r.c1.visible, r);
  check("no script errors", r.errors && r.errors.length === 0, r.errors);
  console.log(failures ? `${failures} FAILURE(S)` : "ALL PASSED");
  if (failures) process.exitCode = 1;
};
