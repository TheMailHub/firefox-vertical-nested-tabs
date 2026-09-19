# Firefox Vertical Nested Tabs

Nested (tree) tabs for Firefox's **native vertical tabs**. Tabs can be children of other tabs, to any depth, and a parent shows how many tabs sit under it and can be collapsed or expanded with an arrow that takes the place of its close button (close a parent with a middle-click, Ctrl+W or the context menu). Nothing changes while tabs are horizontal. For Tree Style Tab fans who want to use Firefox's native vertical implementation. 

<img width="332" height="304" alt="GIF 9-18-2026 2-12-16 PM" src="https://github.com/user-attachments/assets/29de1d1b-42c0-4c07-9cc6-55f876bf268f" />


## Requirements

- Firefox **156** or newer on the release channel (the script was written against Firefox 156's internals; older versions have different tab-strip code and will not work).
- Vertical tabs turned on (right-click the tab strip → *Turn on Vertical Tabs*).

## Install

There are four files to put in place: two in the Firefox installation directory (the loader) and two in your profile's `chrome` folder (the script). The helper scripts do this for you.

### Manual install

1. Copy `loader/config.js` next to the Firefox executable:
   - Windows: `C:\Program Files\Mozilla Firefox\config.js` (or `%LOCALAPPDATA%\Mozilla Firefox\config.js`)
   - macOS: `/Applications/Firefox.app/Contents/Resources/config.js`
   - Linux: `/usr/lib/firefox/config.js` (or wherever `application.ini` lives)
2. Copy `loader/defaults/pref/config-prefs.js` into the `defaults/pref/` folder of that same directory.
3. Copy `chrome/vertical-nested-tabs.uc.js` and `chrome/vertical-nested-tabs-model.js` into `<your profile>/chrome/` (create the `chrome` folder if it does not exist; find the profile via `about:profiles`).
4. Restart Firefox.

### Windows install script

```powershell
powershell -ExecutionPolicy Bypass -File install\install.ps1
```

If Firefox is in `C:\Program Files`, a UAC prompt appears for the two loader files. A per-user install in `%LOCALAPPDATA%\Mozilla Firefox` needs no prompt. If you have several installations, the script asks which one.

### macOS / Linux install script

```bash
./install/install.sh
```

`sudo` is used only if the installation directory is not writable.

Then **fully quit Firefox** and start it again.

## Uninstall

To manually uninstall, delete the four files from the manual installation by hand or use the uninstallation scripts.

### Windows uninstall script

```powershell
powershell -ExecutionPolicy Bypass -File install\install.ps1 -Uninstall
```

### macOS / Linux uninstall script

```bash
./install/install.sh --uninstall
```

## How it works

- `loader/config.js` runs at startup through Firefox's built-in AutoConfig. It waits for each browser window to finish starting, then loads the script from the profile's `chrome` folder. It does nothing if the script file is absent, so several profiles can share one installation safely.
- `chrome/vertical-nested-tabs.uc.js` keeps a parent pointer per tab. Firefox's tab strip cannot contain wrapper elements, so a subtree is simply kept contiguous right after its parent and indented with CSS. Collapsing hides descendants the same way Firefox hides collapsed tab groups. Parent links and collapsed state are stored as SessionStore custom tab values, which survive restarts, session restore, closed-tab undo and moving tabs between windows.
- `chrome/vertical-nested-tabs-model.js` is the pure tree logic (no DOM), shared with the unit tests.

## Caveats

While it would be nice if this could be a FireFox add-on, this isn't a WebExtension. WebExtensions can't touch Firefox's tab strip, so this had to be implemented as a small chrome script that patches FireFox's vertical tab strip, plus a self-contained loader. No third-party loader (such as fx-autoconfig) is needed.

- Firefox updates keep the loader files in place; a full reinstall of Firefox may remove them. Re-run the installer if the feature disappears.
- On macOS, adding files inside `Firefox.app` changes the app's code signature. Recent macOS versions still launch it, but Gatekeeper may re-verify the app on first launch.
- Keyboard tab moves (Ctrl+Shift+PgUp/PgDn) move a single tab; collapse a parent first to move its whole subtree.
- "Reopen Closed Tabs" restores at most `browser.sessionstore.max_tabs_undo` tabs (25 by default).

## Want to contribute?

```bash
npm test     # unit tests for the tree model (Node 18+)
npm run check
```

After editing the chrome script, copy it into the profile again (or re-run the installer) and restart Firefox to see your changes.

The Browser Console (Ctrl+Shift+J) shows `[vertical-nested-tabs] v… loaded`. A small API is exposed as `window.VerticalNestedTabs` for poking at the tree from the console.

## License

MIT
