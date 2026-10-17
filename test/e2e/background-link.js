// Ctrl+click (background tab) on a link in a tab with children: like "Open Link in Nested Tab",
// the new tab becomes the opener's last child, and later links follow it in click order. In a
// *collapsed* tab Firefox's own placement (which skips hidden tabs) must not bury the tab deep
// in the subtree or append it to the last tree on the strip, and the subtree must expand so the
// new tab is visible. The tab is not selected, so the "selected tab is never hidden" rule does
// not cover this.
module.exports = async m => {
  let failures = 0;
  const check = (n, ok, d) => { console.log((ok ? "PASS " : "FAIL ") + n + (ok ? "" : " " + JSON.stringify(d))); if (!ok) failures++; };

  const PRELUDE = `
    const w = window; const gB = w.gBrowser; const V = w.VerticalNestedTabs; const done = arguments[arguments.length - 1];
    const sleep = ms => new Promise(r => w.setTimeout(r, ms));
    const byLabel = l => gB.tabs.find(t => t.label === l);
    const name = t => (w.__vntNew && w.__vntNew.get(t)) || t.label;
    const info = t => t && { l: name(t), parent: V.parentOf(t) && name(V.parentOf(t)), index: t.index, lvl: t.getAttribute("nested-level"),
      hidden: t.hasAttribute("nested-hidden"), visible: t.visible, collapsed: V.isCollapsed(t) };
    const errors = () => Services.console.getMessageArray().map(x => x.message || String(x)).filter(s => s.includes("[vertical-nested-tabs]") || s.includes("vertical-nested-tabs.uc.js")).slice(-5);
  `;

  // BP -> BC1 -> BG1
  //    -> BC2 -> BG2 -> BH2
  // BQ -> BQ1              (an unrelated collapsed tree at the end of the strip)
  const setup = await m.execAsync(PRELUDE + `
    const keep = gB.tabs.find(t => t.linkedBrowser.currentURI.spec === "about:blank") || gB.tabs[0];
    gB.selectedTab = keep;
    for (const t of gB.tabs.filter(t => t !== keep)) { if (t.pinned) gB.unpinTab(t); gB.removeTab(t, { skipPermitUnload: true }); }
    Services.console.reset();
    const labels = ["BP", "BC1", "BG1", "BC2", "BG2", "BH2", "BQ", "BQ1"];
    for (const l of labels) {
      const html = '<title>' + l + '</title><a id="l" href="http://127.0.0.1:9/' + l + '" style="font-size:40px;display:block;margin:60px">link</a>';
      gB.addTrustedTab("data:text/html," + encodeURIComponent(html), { skipAnimation: true });
    }
    (async () => {
      for (let i = 0; i < 100; i++) { await sleep(100); if (labels.every(byLabel)) break; }
      const [P, C1, G1, C2, G2, H2, Q, Q1] = labels.map(byLabel);
      V.setParent(C1, P); V.setParent(G1, C1); V.setParent(C2, P); V.setParent(G2, C2); V.setParent(H2, G2); V.setParent(Q1, Q);
      V.setCollapsed(Q, true);
      V.setCollapsed(P, true);
      gB.selectedTab = P;
      w.__vntNew = new Map();
      await sleep(300);
      done({ tabs: labels.map(l => info(byLabel(l))), selected: gB.selectedTab.label });
    })().catch(e => done({ error: String(e) }));
  `);
  check("setup: BP collapsed and selected, its subtree hidden",
    setup.selected === "BP" && setup.tabs && setup.tabs[0].collapsed && setup.tabs.slice(1, 6).every(t => t.hidden), setup);

  // Ctrl+click the link in the tab titled `title` (it must be the selected tab), wait for the
  // new background tab and name it `newName`.
  const CTRL = String.fromCharCode(0xe009); // WebDriver key value for Control
  async function ctrlClick(title, newName) {
    await m.exec(`window.__vntExisting = new Set(window.gBrowser.tabs);`);
    await m.send("Marionette:SetContext", { value: "content" });
    let found = false;
    for (const h of await m.send("WebDriver:GetWindowHandles", {}).then(r => r.value || r)) {
      await m.send("WebDriver:SwitchToWindow", { handle: h, focus: false });
      if ((await m.send("WebDriver:GetTitle", {})).value === title) { found = true; break; }
    }
    if (!found) throw new Error(title + " tab not found");
    const ref = (await m.send("WebDriver:FindElement", { using: "css selector", value: "#l" })).value;
    await m.send("WebDriver:PerformActions", { actions: [
      { type: "key", id: "kbd", actions: [
        { type: "keyDown", value: CTRL }, { type: "pause", duration: 0 }, { type: "pause", duration: 0 },
        { type: "pause", duration: 0 }, { type: "keyUp", value: CTRL },
      ] },
      { type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions: [
        { type: "pause", duration: 0 },
        { type: "pointerMove", origin: ref, x: 0, y: 0, duration: 50 },
        { type: "pointerDown", button: 0 },
        { type: "pointerUp", button: 0 },
      ] },
    ] });
    await m.send("WebDriver:ReleaseActions", {});
    await m.send("Marionette:SetContext", { value: "chrome" });
    return m.execAsync(PRELUDE + `
      const newName = arguments[0];
      (async () => {
        let tab = null;
        for (let i = 0; i < 50; i++) { await sleep(100); tab = gB.tabs.find(t => !w.__vntExisting.has(t)); if (tab) break; }
        if (tab) w.__vntNew.set(tab, newName);
        await sleep(400);
        const last = gB.tabs[gB.tabs.length - 1];
        done({ tab: info(tab), selected: name(gB.selectedTab), last: name(last), errors: errors(),
          tabs: gB.tabs.filter(t => !t.pinned).map(info) });
      })().catch(e => done({ error: String(e) }));
    `, [newName]);
  }

  // 1. Two Ctrl+clicks in the collapsed parent BP.
  const r1 = await ctrlClick("BP", "N1");
  const r2 = await ctrlClick("BP", "N2");
  const t1 = l => r1.tabs.find(t => t.l === l);
  const t2 = l => r2.tabs.find(t => t.l === l);
  console.log(JSON.stringify(r2.tabs));
  check("1st link from collapsed BP becomes its last child", r1.tab && r1.tab.parent === "BP" && r1.tab.lvl === "1" && r1.tab.index === t1("BH2").index + 1, r1.tab);
  check("2nd link goes right after the 1st, also a child of BP", r2.tab && r2.tab.parent === "BP" && r2.tab.index === t2("N1").index + 1, r2.tab);
  check("BP expanded; both new tabs visible", !t2("BP").collapsed && [t2("N1"), t2("N2")].every(t => !t.hidden && t.visible), [t2("BP"), t2("N1"), t2("N2")]);
  check("selection stays on BP (background tabs)", r1.selected === "BP" && r2.selected === "BP", [r1.selected, r2.selected]);
  check("nothing was appended to the end of the strip", r2.last === "BQ1", r2.last);
  check("unrelated collapsed tree BQ untouched", t2("BQ").collapsed && t2("BQ1").hidden && t2("BQ1").parent === "BQ", [t2("BQ"), t2("BQ1")]);
  check("BC2's nested subtree unchanged", t2("BG2").parent === "BC2" && t2("BH2").parent === "BG2" && !t2("BC2").collapsed && !t2("BH2").hidden, [t2("BC2"), t2("BG2"), t2("BH2")]);

  // 2. Ctrl+click in a collapsed child that has nested children.
  await m.execAsync(PRELUDE + `
    const C1 = byLabel("BC1");
    gB.selectedTab = C1;
    V.setCollapsed(C1, true);
    (async () => { await sleep(300); done(true); })();
  `);
  const r3 = await ctrlClick("BC1", "N3");
  const t3 = l => r3.tabs.find(t => t.l === l);
  check("link from collapsed BC1 becomes its last child", r3.tab && r3.tab.parent === "BC1" && r3.tab.index === t3("BG1").index + 1 && r3.tab.lvl === "2", r3.tab);
  check("BC1 expanded; new tab and BG1 visible", !t3("BC1").collapsed && !t3("N3").hidden && t3("N3").visible && !t3("BG1").hidden, [t3("BC1"), t3("N3"), t3("BG1")]);

  // 3. Collapse BC1 again without changing selection: the previous related tab (N3) is now
  //    hidden. Firefox places the next one after it; it must not fall to the end of the strip.
  await m.execAsync(PRELUDE + `
    V.setCollapsed(byLabel("BC1"), true);
    (async () => { await sleep(300); done(true); })();
  `);
  const r4 = await ctrlClick("BC1", "N4");
  const t4 = l => r4.tabs.find(t => t.l === l);
  console.log(JSON.stringify(r4.tabs));
  check("next link goes right after the hidden previous one, under BC1", r4.tab && r4.tab.parent === "BC1" && r4.tab.index === t4("N3").index + 1, r4.tab);
  check("...which is still the bottom of BC1's children", r4.tabs.find(t => t.index === r4.tab.index + 1).l === "BC2", r4.tabs);
  check("BC1 expanded again; new tab visible", !t4("BC1").collapsed && !t4("N4").hidden && t4("N4").visible, [t4("BC1"), t4("N4")]);
  check("nothing was appended to the end of the strip (2)", r4.last === "BQ1", r4.last);
  check("BQ still collapsed", t4("BQ").collapsed && t4("BQ1").hidden, [t4("BQ"), t4("BQ1")]);

  // 4. Ctrl+click twice in an *expanded* child whose child has its own child.
  await m.execAsync(PRELUDE + `
    gB.selectedTab = byLabel("BC2");
    (async () => { await sleep(300); done(true); })();
  `);
  const r5 = await ctrlClick("BC2", "N5");
  const r6 = await ctrlClick("BC2", "N6");
  const t6 = l => r6.tabs.find(t => t.l === l);
  console.log(JSON.stringify(r6.tabs));
  check("link from expanded BC2 goes below its nested subtree as a direct child", r5.tab && r5.tab.parent === "BC2" && r5.tab.lvl === "2" && r5.tab.index === t6("BH2").index + 1, r5.tab);
  check("2nd link from BC2 follows the 1st", r6.tab && r6.tab.parent === "BC2" && r6.tab.index === t6("N5").index + 1 && t6("N1").index === r6.tab.index + 1, r6.tabs);
  check("BC2's nested subtree untouched; selection stays on BC2", t6("BG2").parent === "BC2" && t6("BH2").parent === "BG2" && r6.selected === "BC2", [t6("BG2"), t6("BH2"), r6.selected]);

  check("no script errors", r6.errors && r6.errors.length === 0 && r4.errors.length === 0 && r1.errors.length === 0, [r1.errors, r4.errors, r6.errors]);
  console.log(failures ? `${failures} FAILURE(S)` : "ALL PASSED");
  if (failures) process.exitCode = 1;
};
