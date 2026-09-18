#!/usr/bin/env bash
# Installs (or removes) Vertical Nested Tabs for Firefox on macOS and Linux.
#
#   ./install/install.sh                 # install
#   ./install/install.sh --uninstall     # remove
#   ./install/install.sh --install-dir /opt/firefox --profile-dir ~/.mozilla/firefox/xxxx.default-release
#
# Copies loader/config.js and loader/defaults/pref/config-prefs.js into the
# Firefox installation (sudo only if needed) and the two chrome scripts into
# <profile>/chrome/.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_DIR=""
PROFILE_DIR=""
UNINSTALL=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --install-dir) INSTALL_DIR="$2"; shift 2 ;;
    --profile-dir) PROFILE_DIR="$2"; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

find_install_dir() {
  local candidates=()
  case "$(uname -s)" in
    Darwin)
      candidates+=("/Applications/Firefox.app/Contents/Resources"
                   "$HOME/Applications/Firefox.app/Contents/Resources"
                   "/Applications/Firefox Developer Edition.app/Contents/Resources"
                   "/Applications/Firefox Nightly.app/Contents/Resources") ;;
    *)
      candidates+=("/usr/lib/firefox" "/usr/lib64/firefox" "/opt/firefox" "/usr/local/lib/firefox"
                   "/usr/lib/firefox-developer-edition" "/opt/firefox-nightly") ;;
  esac
  local c
  for c in "${candidates[@]}"; do
    if [[ -f "$c/application.ini" ]]; then echo "$c"; return 0; fi
  done
  return 1
}

find_profile_dir() {
  local root
  case "$(uname -s)" in
    Darwin) root="$HOME/Library/Application Support/Firefox" ;;
    *)      root="$HOME/.mozilla/firefox" ;;
  esac
  local ini="$root/profiles.ini"
  [[ -f "$ini" ]] || return 1
  # Prefer per-install defaults ([Install...] Default=...), newest first.
  local best="" rel
  while IFS= read -r rel; do
    local full="$root/$rel"
    [[ -d "$full" ]] || continue
    if [[ -z "$best" || "$full" -nt "$best" ]]; then best="$full"; fi
  done < <(awk '/^\[Install/{s=1;next} /^\[/{s=0} s && /^Default=/{sub(/^Default=/,""); print}' "$ini")
  if [[ -n "$best" ]]; then echo "$best"; return 0; fi
  # Fallback: most recently modified profile directory.
  local newest
  newest="$(ls -td "$root"/*/ 2>/dev/null | head -n1)"
  [[ -n "$newest" ]] || return 1
  echo "${newest%/}"
}

if [[ -z "$INSTALL_DIR" ]]; then
  INSTALL_DIR="$(find_install_dir)" || { echo "Firefox installation not found; pass --install-dir" >&2; exit 1; }
fi
[[ -f "$INSTALL_DIR/application.ini" ]] || { echo "application.ini not found in $INSTALL_DIR" >&2; exit 1; }
if [[ -z "$PROFILE_DIR" ]]; then
  PROFILE_DIR="$(find_profile_dir)" || { echo "Firefox profile not found; pass --profile-dir" >&2; exit 1; }
fi
[[ -d "$PROFILE_DIR" ]] || { echo "profile dir not found: $PROFILE_DIR" >&2; exit 1; }

SUDO=""
if [[ ! -w "$INSTALL_DIR" ]]; then
  echo "Writing to $INSTALL_DIR needs administrator rights (sudo)."
  SUDO="sudo"
fi

if [[ $UNINSTALL -eq 1 ]]; then
  $SUDO rm -f "$INSTALL_DIR/config.js" "$INSTALL_DIR/defaults/pref/config-prefs.js"
  rm -f "$PROFILE_DIR/chrome/vertical-nested-tabs.uc.js" "$PROFILE_DIR/chrome/vertical-nested-tabs-model.js"
  echo "Uninstalled. Restart Firefox to finish."
  exit 0
fi

$SUDO mkdir -p "$INSTALL_DIR/defaults/pref"
$SUDO cp "$REPO/loader/config.js" "$INSTALL_DIR/config.js"
$SUDO cp "$REPO/loader/defaults/pref/config-prefs.js" "$INSTALL_DIR/defaults/pref/config-prefs.js"
mkdir -p "$PROFILE_DIR/chrome"
cp "$REPO/chrome/vertical-nested-tabs.uc.js" "$REPO/chrome/vertical-nested-tabs-model.js" "$PROFILE_DIR/chrome/"

echo "Installed for:"
echo "  Firefox : $INSTALL_DIR"
echo "  Profile : $PROFILE_DIR"
echo "Fully quit Firefox, start it again, and turn on vertical tabs."
if [[ "$(uname -s)" == "Darwin" ]]; then
  echo "Note: adding files inside Firefox.app changes its code signature; macOS normally still launches it."
fi
