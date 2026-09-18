// Build a tree, then restart Firefox with session restore on.
module.exports = async m => {
  const r = await m.execAsync(`
    const w = window; const gB = w.gBrowser; const V = w.VerticalNestedTabs;
    const done = arguments[arguments.length - 1];
    const sleep = ms => new Promise(r => w.setTimeout(r, ms));
    const byLabel = l => gB.tabs.find(t => t.label === l);
    (async () => {
      // close everything but the first tab, then build: P > [P1 (collapsed) > P1a, P2], Q
      for (const t of gB.tabs.slice(1)) gB.removeTab(t);
      const open = l => gB.addTrustedTab("data:text/html,<title>" + l + "</title>" + l, { skipAnimation: true });
      for (const l of ["P", "P1", "P1a", "P2", "Q"]) open(l);
      for (let i = 0; i < 100; i++) { await sleep(100); if (["P","P1","P1a","P2","Q"].every(byLabel)) break; }
      V.setParent(byLabel("P1"), byLabel("P"));
      V.setParent(byLabel("P1a"), byLabel("P1"));
      V.setParent(byLabel("P2"), byLabel("P"));
      V.setCollapsed(byLabel("P1"), true);
      gB.selectedTab = byLabel("Q");
      await sleep(500);
      Services.prefs.setIntPref("browser.startup.page", 3);
      const SS = w.SessionStore;
      await SS.promiseAllWindowsRestored;
      // force a session write so the restart sees it
      const { SessionSaver } = ChromeUtils.importESModule("moz-src:///browser/components/sessionstore/SessionSaver.sys.mjs");
      await SessionSaver.run();
      done({ order: gB.tabs.map(t => t.label), p1Collapsed: V.isCollapsed(byLabel("P1")) });
    })().catch(e => done({ error: String(e) }));
  `);
  console.log("before restart:", JSON.stringify(r));
  try {
    await m.send("Marionette:Quit", { flags: ["eAttemptQuit", "eRestart"] });
  } catch (e) {
    console.log("quit response:", e.message.slice(0, 200));
  }
};
