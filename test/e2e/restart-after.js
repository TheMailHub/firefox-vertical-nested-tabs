// After the restart: the tree and collapsed state must come back from session restore.
module.exports = async m => {
  const r = await m.execAsync(`
    const w = window; const gB = w.gBrowser;
    const done = arguments[arguments.length - 1];
    const sleep = ms => new Promise(r => w.setTimeout(r, ms));
    (async () => {
      await w.SessionStore.promiseAllWindowsRestored;
      for (let i = 0; i < 100; i++) { await sleep(100); const V = w.VerticalNestedTabs; if (V && !V._state.restoring && gB.tabs.some(t => t.label === "P1a")) break; }
      await sleep(500);
      const V = w.VerticalNestedTabs;
      const dump = gB.tabs.map(t => ({ l: t.label, lvl: t.getAttribute("nested-level"), col: t.hasAttribute("nested-collapsed"),
        hid: t.hasAttribute("nested-hidden"), parent: V.parentOf(t) ? V.parentOf(t).label : null, pending: t.hasAttribute("pending") }));
      done({ loaded: !!V, active: V && V.active, dump });
    })().catch(e => done({ error: String(e) }));
  `);
  console.log(JSON.stringify(r, null, 1));
  const d = r.dump || [];
  const get = l => d.find(x => x.l === l) || {};
  const ok = r.loaded && r.active && get("P1").parent === "P" && get("P1a").parent === "P1" && get("P2").parent === "P" &&
    get("P1").col && get("P1a").hid && !get("P2").hid && get("Q").parent === null &&
    JSON.stringify(d.map(x => x.l).filter(l => ["P","P1","P1a","P2","Q"].includes(l))) === JSON.stringify(["P","P1","P1a","P2","Q"]);
  console.log(ok ? "PASS tree survives restart (lazy tabs included)" : "FAIL tree after restart");
  if (!ok) process.exitCode = 1;
};
