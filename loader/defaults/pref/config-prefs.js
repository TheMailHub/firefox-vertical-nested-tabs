// Vertical Nested Tabs — loader prefs (Firefox built-in AutoConfig).
// These are default-branch prefs; Firefox reads them before any profile loads.
pref("general.config.filename", "config.js");
pref("general.config.obscure_value", 0);
// AutoConfig is sandboxed by default on the release and beta channels.
// The sandbox cannot load scripts into browser windows, so it must be off.
pref("general.config.sandbox_enabled", false);
