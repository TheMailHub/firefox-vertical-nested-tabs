// Arrow must stay put when the close button appears on hover; badge shows hidden count.
const path = require("node:path");
module.exports = async m => {
  let failures = 0;
  const check = (n, ok, d) => { console.log((ok ? "PASS " : "FAIL ") + n + (ok ? "" : " " + JSON.stringify(d))); if (!ok) failures++; };

  const setup = await m.execAsync(`
    const w = window; const gB = w.gBrowser; const V = w.VerticalNestedTabs; const done = arguments[arguments.length - 1];
    const sleep = ms => new Promise(r => w.setTimeout(r, ms));
    const byLabel = l => gB.tabs.find(t => t.label === l);
    (async () => {
      const keep = gB.tabs.find(t => t.linkedBrowser.currentURI.spec === "about:blank") || gB.tabs[0];
      gB.selectedTab = keep;
      for (const t of gB.tabs.filter(t => t !== keep)) gB.removeTab(t, { skipPermitUnload: true });
      const open = l => gB.addTrustedTab("data:text/html,<title>" + l + "</title>" + l, { skipAnimation: true });
      for (const l of ["Parent", "Child 1", "Child 2", "Grandchild", "Other"]) open(l);
      for (let i = 0; i < 100; i++) { await sleep(100); if (["Parent","Child 1","Child 2","Grandchild","Other"].every(byLabel)) break; }
      V.setParent(byLabel("Child 1"), byLabel("Parent"));
      V.setParent(byLabel("Child 2"), byLabel("Parent"));
      V.setParent(byLabel("Grandchild"), byLabel("Child 2"));
      gB.selectedTab = byLabel("Other");
      await sleep(300);
      const tw = byLabel("Parent").querySelector(".tab-nest-twisty").getBoundingClientRect();
      done({ twistyX: tw.left, twistyW: tw.width });
    })();
  `);
  console.log("expanded, not hovered:", JSON.stringify(setup));
  await m.screenshot(path.join(require("node:os").tmpdir(), "vnt-shot-ux-expanded.png"));

  // hover the parent tab with a real pointer
  const el = await m.send("WebDriver:FindElement", { using: "css selector", value: ".tabbrowser-tab[nested-haschildren][nested-level='0']" });
  const key = Object.keys(el.value)[0];
  await m.send("WebDriver:PerformActions", { actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" },
    actions: [{ type: "pointerMove", origin: { [key]: el.value[key] }, x: 0, y: 0, duration: 100 }] }] });
  const hovered = await m.execAsync(`
    const w = window; const gB = w.gBrowser; const done = arguments[arguments.length - 1];
    const sleep = ms => new Promise(r => w.setTimeout(r, ms));
    (async () => {
      await sleep(300);
      const p = gB.tabs.find(t => t.label === "Parent");
      const tw = p.querySelector(".tab-nest-twisty").getBoundingClientRect();
      const cb = p.querySelector(".tab-close-button"); const cs = w.getComputedStyle(cb);
      done({ hovered: p.matches(":hover"), twistyX: tw.left, closeVisible: cs.visibility === "visible" && cs.display !== "none" });
    })();
  `);
  console.log("expanded, hovered:", JSON.stringify(hovered));
  await m.screenshot(path.join(require("node:os").tmpdir(), "vnt-shot-ux-hover.png"));
  check("pointer is over the parent", hovered.hovered && hovered.closeVisible, hovered);
  check("arrow does not move when the close button appears", Math.abs(hovered.twistyX - setup.twistyX) < 1, { before: setup.twistyX, after: hovered.twistyX });

  // move the pointer away, collapse, screenshot the badge
  await m.send("WebDriver:PerformActions", { actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" },
    actions: [{ type: "pointerMove", origin: "viewport", x: 900, y: 500, duration: 100 }] }] });
  const collapsed = await m.execAsync(`
    const w = window; const gB = w.gBrowser; const V = w.VerticalNestedTabs; const done = arguments[arguments.length - 1];
    const sleep = ms => new Promise(r => w.setTimeout(r, ms));
    (async () => {
      const p = gB.tabs.find(t => t.label === "Parent");
      V.setCollapsed(p, true);
      gB.selectedTab = gB.tabs.find(t => t.label === "Other");
      await sleep(400);
      const c = p.querySelector(".tab-nest-count");
      const tw = p.querySelector(".tab-nest-twisty").getBoundingClientRect();
      done({ badge: c.getAttribute("value"), badgeHidden: c.hidden, twistyX: tw.left, hovered: p.matches(":hover") });
    })();
  `);
  console.log("collapsed:", JSON.stringify(collapsed));
  await m.screenshot(path.join(require("node:os").tmpdir(), "vnt-shot-ux-collapsed.png"));
  check("badge shows 3 on the collapsed parent", collapsed.badge === "3" && !collapsed.badgeHidden, collapsed);
  check("arrow position unchanged after collapse", Math.abs(collapsed.twistyX - setup.twistyX) < 1, { before: setup.twistyX, after: collapsed.twistyX });
  console.log(failures ? `${failures} FAILURE(S)` : "ALL PASSED");
  if (failures) process.exitCode = 1;
};
