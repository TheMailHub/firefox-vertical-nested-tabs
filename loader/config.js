// Vertical Nested Tabs loader. Firefox discards this first line; keep it a comment.
// Loads <profile>/chrome/vertical-nested-tabs.uc.js into every browser window.
// No third-party loader is involved: this is Firefox's built-in AutoConfig.
try {
  const SCRIPT_LEAFNAME = "vertical-nested-tabs.uc.js";
  const BROWSER_URL = "chrome://browser/content/browser.xhtml";

  function reportError(ex) {
    try {
      // `console` does not exist in the AutoConfig sandbox.
      Components.utils.reportError("[vertical-nested-tabs loader] " + ex);
    } catch (e) {}
  }

  function scriptFile() {
    let file;
    try {
      file = Services.dirsvc.get("UChrm", Ci.nsIFile);
    } catch (e) {
      file = Cc["@mozilla.org/file/directory_service;1"]
        .getService(Ci.nsIProperties)
        .get("UChrm", Ci.nsIFile);
    }
    file.append(SCRIPT_LEAFNAME);
    return file;
  }

  function inject(win) {
    try {
      const file = scriptFile();
      if (!file.exists() || !file.isFile()) {
        return; // nothing installed for this profile
      }
      // file: URLs need allowUnsafeURL; profile scripts are never startup-cached.
      Services.scriptloader.loadSubScriptWithOptions(Services.io.newFileURI(file).spec, {
        target: win,
        ignoreCache: true,
        allowUnsafeURL: true,
      });
    } catch (ex) {
      reportError(ex);
    }
  }

  const observer = {
    observe(subject, topic) {
      if (topic !== "browser-delayed-startup-finished") {
        return;
      }
      const win = subject;
      if (!win || win.location.href !== BROWSER_URL || !win.gBrowser) {
        return;
      }
      inject(win);
    },
  };
  Services.obs.addObserver(observer, "browser-delayed-startup-finished");

  // Windows that already finished starting (not expected at pref-read time).
  for (const win of Services.wm.getEnumerator("navigator:browser")) {
    if (win.gBrowserInit && win.gBrowserInit.delayedStartupFinished) {
      inject(win);
    }
  }
} catch (ex) {
  Components.utils.reportError("[vertical-nested-tabs loader] " + ex);
}
