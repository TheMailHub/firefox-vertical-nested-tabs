// Real right-click on a content link -> "Open Link in Nested Tab" nests the new tab under the current one.
module.exports = async m => {
  let failures = 0;
  const check = (n, ok, d) => { console.log((ok ? "PASS " : "FAIL ") + n + (ok ? "" : " " + JSON.stringify(d))); if (!ok) failures++; };

  // chrome: open the page with a link and select it
  await m.execAsync(`
    const w = window; const gB = w.gBrowser; const done = arguments[arguments.length - 1];
    const sleep = ms => new Promise(r => w.setTimeout(r, ms));
    const keep = gB.tabs.find(t => t.linkedBrowser.currentURI.spec === "about:blank") || gB.tabs[0];
    gB.selectedTab = keep;
    for (const t of gB.tabs.filter(t => t !== keep)) { if (t.pinned) gB.unpinTab(t); gB.removeTab(t, { skipPermitUnload: true }); }
    const html = '<title>LP</title><a id="l" href="http://127.0.0.1:9/L1" style="font-size:40px;display:block;margin:60px">link</a>';
    const t = gB.addTrustedTab("data:text/html," + encodeURIComponent(html), { skipAnimation: true });
    gB.selectedTab = t;
    (async () => { for (let i = 0; i < 100; i++) { await sleep(100); if (t.label === "LP" && !t.linkedBrowser.webProgress.isLoadingDocument) break; } await sleep(300); done(true); })();
  `);

  // content: right-click the link with real pointer actions
  await m.send("Marionette:SetContext", { value: "content" });
  const handles = (await m.send("WebDriver:GetWindowHandles", {})).value || (await m.send("WebDriver:GetWindowHandles", {}));
  let found = false;
  for (const h of handles) {
    await m.send("WebDriver:SwitchToWindow", { handle: h });
    const title = (await m.send("WebDriver:GetTitle", {})).value;
    if (title === "LP") { found = true; break; }
  }
  if (!found) throw new Error("LP tab not found among handles " + JSON.stringify(handles));
  const el = await m.send("WebDriver:FindElement", { using: "css selector", value: "#l" });
  const ref = el.value;
  const elId = ref[Object.keys(ref)[0]];
  await m.send("WebDriver:PerformActions", { actions: [{
    type: "pointer", id: "mouse", parameters: { pointerType: "mouse" },
    actions: [
      { type: "pointerMove", origin: { [Object.keys(ref)[0]]: elId }, x: 0, y: 0, duration: 50 },
      { type: "pointerDown", button: 2 },
      { type: "pointerUp", button: 2 },
    ],
  }] });
  await m.send("Marionette:SetContext", { value: "chrome" });

  const r = await m.execAsync(`
    const w = window; const gB = w.gBrowser; const V = w.VerticalNestedTabs; const done = arguments[arguments.length - 1];
    const sleep = ms => new Promise(r => w.setTimeout(r, ms));
    (async () => {
      const menu = w.document.getElementById("contentAreaContextMenu");
      for (let i = 0; i < 50; i++) { await sleep(100); if (menu.state === "open") break; }
      const item = w.document.getElementById("context-openlinkinnestedtab");
      const native = w.document.getElementById("context-openlinkintab");
      const before = { state: menu.state, present: !!item, hidden: item && item.hidden, afterNative: !!item && native.nextElementSibling === item,
        onLink: !!(w.gContextMenu && (w.gContextMenu.onSaveableLink || w.gContextMenu.onPlainTextLink)), linkURL: w.gContextMenu && w.gContextMenu.linkURL };
      const parent = gB.selectedTab;
      const existing = new Set(gB.tabs);
      if (item && !item.hidden) item.doCommand();
      menu.hidePopup();
      let child = null;
      for (let i = 0; i < 50; i++) { await sleep(100); child = gB.tabs.find(t => !existing.has(t)); if (child) break; }
      await sleep(500);
      const errors = Services.console.getMessageArray().map(x => x.message || String(x)).filter(s => s.includes("[vertical-nested-tabs]") || s.includes("vertical-nested-tabs.uc.js")).slice(-5);
      done({ before, errors, child: child ? { label: child.label, url: child.linkedBrowser.currentURI.spec.slice(0, 60), parent: V.parentOf(child) && V.parentOf(child).label, lvl: child.getAttribute("nested-level"), index: child.index, parentIndex: parent.index } : null });
    })().catch(e => done({ error: String(e) }));
  `);
  console.log(JSON.stringify(r));
  check("content context menu opened on a link", r.before && r.before.state === "open" && r.before.onLink, r.before);
  check("'Open Link in Nested Tab' shown after native item", r.before && r.before.present && r.before.hidden === false && r.before.afterNative, r.before);
  check("link opened as nested child of current tab", r.child && r.child.parent === "LP" && r.child.lvl === "1" && r.child.index === r.child.parentIndex + 1, r);
  console.log(failures ? `${failures} FAILURE(S)` : "ALL PASSED");
  if (failures) process.exitCode = 1;
};
