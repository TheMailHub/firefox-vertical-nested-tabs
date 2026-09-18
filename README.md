# Firefox Vertical Nested Tabs

Nested (tree) tabs for Firefox's **native vertical tabs**. Tabs can be children of other tabs, to any depth, and a parent can be collapsed or expanded with an arrow next to its close button. Nothing changes while tabs are horizontal.

## What you get

| Action | Result |
|---|---|
| Drag a tab so it **visibly overlaps another tab** and hold still for a tenth of a second | The overlapped tab highlights and the dragged tab previews its indent. Drop to nest it as the last child. Keep moving, or let Firefox slide the other tab out of the way, and it is a normal reorder. |
| Drop a tab between two tabs (no hold) | It takes the depth of its neighbours: dropping before a tab makes it that tab's sibling, dropping right after an expanded parent makes it the first child. While you drag, the tab that would become the parent shows a dashed outline and the dragged tab previews its indent. |
| Drag a parent | Its subtree collapses for the drag and lands with it. |
| Click the **arrow** at the right of a parent's label | Collapses (arrow points down) or expands (arrow points up) its children. A collapsed parent shows how many tabs are hidden under it. |
| Right-click a tab → **New Nested Tab** | Opens a new tab as the last child of that tab. |
| Right-click a link → **Open Link in Nested Tab** | Opens the link as the last child of the tab you are in. |
| Close an expanded parent | Its children move up one level. |
| Close a **collapsed** parent | The whole hidden subtree closes as one action. Right-click a tab → **Reopen Closed Tabs (N)** (or Ctrl+Shift+T) brings the subtree back, still nested and collapsed. |
| Restart Firefox / restore a session | The tree and collapsed state come back. |
| Turn vertical tabs off | Everything is inert and the strip looks completely native. Turn vertical tabs back on and the tree returns. |

In vertical mode, holding a tab over another tab **nests** it instead, which overrides FireFox's default of creating a tab group. If you want to use tab groups, they're still available from the tab context menu, by dragging onto a group label, or by dragging into an existing group. Horizontal tabs are untouched.

Rules that keep the tree sane:

- Pinned tabs and split-view tabs are never part of the tree.
- A subtree always lives inside one tab group. Nesting a tab under a grouped parent moves it into that group; moving a child out of its parent's group un-nests it.
- Selecting a hidden tab (for example through Ctrl+Tab or a link that targets it) expands its ancestors.
- Dragging a tab to another window, or out into a new window, takes its whole subtree along. It arrives with the same nesting and collapsed state; the tab itself becomes top-level in the new window.

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
