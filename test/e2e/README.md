# End-to-end tests (real Firefox, Marionette)

These drive a separate Firefox instance through Marionette in chrome context. They never touch your normal profile.

1. Install the loader into a Firefox installation (see the main README), and copy `chrome/*.js` into `<test-profile>/chrome/`.
2. Put a `user.js` in the test profile with at least:
   ```js
   user_pref("sidebar.revamp", true);
   user_pref("sidebar.verticalTabs", true);
   user_pref("marionette.port", 2829);
   user_pref("browser.shell.checkDefaultBrowser", false);
   user_pref("browser.aboutwelcome.enabled", false);
   ```
3. Start Firefox on that profile:
   ```
   firefox -no-remote -marionette -remote-allow-system-access -profile <test-profile>
   ```
4. Run a test:
   ```
   node test/e2e/marionette.js 2829 test/e2e/tree.js
   node test/e2e/marionette.js 2829 test/e2e/link-menu.js
   node test/e2e/marionette.js 2829 test/e2e/collapsed-link.js
   node test/e2e/marionette.js 2829 test/e2e/cross-window.js
   node test/e2e/marionette.js 2829 test/e2e/hover.js
   node test/e2e/marionette.js 2829 test/e2e/restart-before.js   # restarts Firefox
   node test/e2e/marionette.js 2829 test/e2e/restart-after.js
   ```

`tree.js` covers: nesting through the API and the tab context menu, collapse/expand and hidden-tab selection, closing an expanded parent (children promoted), closing a collapsed parent (subtree closed and restored by Firefox's "Reopen Closed Tabs"), pinning, native tab groups, moving a parent, the drop placement rules, the hold-target hit test, and turning vertical tabs off and on. `link-menu.js` right-clicks a real link in content and uses "Open Link in Nested Tab". `collapsed-link.js` left-clicks a `target=_blank` link in a collapsed parent and checks the parent expands so the new, selected child is visible. `cross-window.js` moves a subtree into another window, out to a new window, and back. `hover.js` hovers a parent with a real pointer and checks the close button stays hidden on parents, the arrow does not move and the badge shows the descendant count. The drag gesture itself needs a hand test.
