<#
.SYNOPSIS
  Installs (or removes) Vertical Nested Tabs for Firefox on Windows.

.DESCRIPTION
  Copies the two loader files into the Firefox installation directory and the
  two chrome scripts into the chosen profile's "chrome" folder. Elevation is
  requested only when the installation directory is not writable (typical for
  C:\Program Files). Per-user installs (%LOCALAPPDATA%\Mozilla Firefox) need no
  elevation.

.PARAMETER InstallDir
  Firefox installation directory (contains firefox.exe). Auto-detected when omitted.

.PARAMETER ProfileDir
  Firefox profile directory. Defaults to the profile Firefox uses by default.

.PARAMETER Uninstall
  Remove the files instead of installing them.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File install\install.ps1
  powershell -ExecutionPolicy Bypass -File install\install.ps1 -Uninstall
#>
[CmdletBinding()]
param(
  [string]$InstallDir,
  [string]$ProfileDir,
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$loaderFiles = @(
  @{ Src = Join-Path $repo "loader\config.js";                     Rel = "config.js" },
  @{ Src = Join-Path $repo "loader\defaults\pref\config-prefs.js"; Rel = "defaults\pref\config-prefs.js" }
)
$chromeFiles = @("vertical-nested-tabs.uc.js", "vertical-nested-tabs-model.js")

function Find-Installs {
  $candidates = @(
    "$env:ProgramFiles\Mozilla Firefox",
    "${env:ProgramFiles(x86)}\Mozilla Firefox",
    "$env:LOCALAPPDATA\Mozilla Firefox",
    "$env:ProgramFiles\Firefox Developer Edition",
    "$env:ProgramFiles\Firefox Nightly",
    "$env:LOCALAPPDATA\Firefox Developer Edition",
    "$env:LOCALAPPDATA\Firefox Nightly"
  )
  $found = @()
  foreach ($c in $candidates) {
    if ($c -and (Test-Path (Join-Path $c "firefox.exe"))) {
      $version = ""
      $ini = Join-Path $c "application.ini"
      if (Test-Path $ini) {
        $m = Select-String -Path $ini -Pattern '^Version=(.*)$' | Select-Object -First 1
        if ($m) { $version = $m.Matches[0].Groups[1].Value }
      }
      $found += [pscustomobject]@{ Path = $c; Version = $version }
    }
  }
  return @($found)
}

function Find-DefaultProfile {
  $root = Join-Path $env:APPDATA "Mozilla\Firefox"
  $iniPath = Join-Path $root "profiles.ini"
  if (-not (Test-Path $iniPath)) { return $null }

  # Firefox keeps one default profile per installation in [Install...] sections.
  # With one install that is unambiguous; with several, take the most recently used.
  $installDefaults = @()
  $section = ""
  foreach ($line in (Get-Content $iniPath)) {
    if ($line -match '^\[(.+)\]$') { $section = $Matches[1]; continue }
    if ($section -like "Install*" -and $line -match '^Default=(.+)$') {
      $full = Join-Path $root ($Matches[1] -replace '/', '\')
      if (Test-Path $full) { $installDefaults += $full }
    }
  }
  if ($installDefaults.Count -eq 1) { return $installDefaults[0] }
  if ($installDefaults.Count -gt 1) {
    return ($installDefaults | Sort-Object { (Get-Item $_).LastWriteTime } -Descending | Select-Object -First 1)
  }
  $profiles = Get-ChildItem (Join-Path $root "Profiles") -Directory -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending
  if ($profiles) { return $profiles[0].FullName }
  return $null
}

function Test-Writable([string]$dir) {
  try {
    $probe = Join-Path $dir ([IO.Path]::GetRandomFileName())
    [IO.File]::WriteAllText($probe, "")
    Remove-Item $probe -Force
    return $true
  } catch { return $false }
}

function Copy-LoaderFiles([string]$dir, [bool]$remove, [bool]$quiet) {
  foreach ($f in $loaderFiles) {
    $dest = Join-Path $dir $f.Rel
    if ($remove) {
      if (Test-Path $dest) {
        Remove-Item $dest -Force
        if (-not $quiet) { Write-Host "Removed  $dest" }
      }
    } else {
      New-Item -ItemType Directory -Force (Split-Path $dest) | Out-Null
      Copy-Item $f.Src $dest -Force
      if (-not $quiet) { Write-Host "Copied   $dest" }
    }
  }
}

# ---- elevated child: only the install-dir part ------------------------------
if ($ProfileDir -eq "__LOADER_ONLY__") {
  Copy-LoaderFiles -dir $InstallDir -remove ([bool]$Uninstall) -quiet $true
  exit 0
}

# ---- resolve install dir ----------------------------------------------------
if (-not $InstallDir) {
  $installs = Find-Installs
  if ($installs.Count -eq 0) { throw "No Firefox installation found. Pass -InstallDir." }
  if ($installs.Count -gt 1) {
    Write-Host "Several Firefox installations found:"
    for ($i = 0; $i -lt $installs.Count; $i++) {
      Write-Host ("  [{0}] {1}  (version {2})" -f ($i + 1), $installs[$i].Path, $installs[$i].Version)
    }
    $pick = Read-Host "Which one? [1-$($installs.Count)]"
    $InstallDir = $installs[[int]$pick - 1].Path
  } else {
    $InstallDir = $installs[0].Path
  }
}
if (-not (Test-Path (Join-Path $InstallDir "firefox.exe"))) { throw "firefox.exe not found in $InstallDir" }

# ---- loader files (install dir) ---------------------------------------------
if (Test-Writable $InstallDir) {
  Copy-LoaderFiles -dir $InstallDir -remove ([bool]$Uninstall) -quiet $false
} else {
  Write-Host "Writing to $InstallDir needs administrator rights; a UAC prompt will appear."
  $childArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ('"' + $PSCommandPath + '"'),
                 "-InstallDir", ('"' + $InstallDir + '"'), "-ProfileDir", "__LOADER_ONLY__")
  if ($Uninstall) { $childArgs += "-Uninstall" }
  $p = Start-Process -FilePath "powershell.exe" -ArgumentList $childArgs -Verb RunAs -Wait -PassThru
  if ($p.ExitCode -ne 0) { throw "Elevated step failed with exit code $($p.ExitCode)." }
  foreach ($f in $loaderFiles) {
    Write-Host (($(if ($Uninstall) { "Removed  " } else { "Copied   " })) + (Join-Path $InstallDir $f.Rel))
  }
}

# ---- chrome files (profile) -------------------------------------------------
if (-not $ProfileDir) { $ProfileDir = Find-DefaultProfile }
if (-not $ProfileDir -or -not (Test-Path $ProfileDir)) { throw "Could not find a Firefox profile. Pass -ProfileDir." }
$chromeDir = Join-Path $ProfileDir "chrome"
foreach ($name in $chromeFiles) {
  $dest = Join-Path $chromeDir $name
  if ($Uninstall) {
    if (Test-Path $dest) { Remove-Item $dest -Force; Write-Host "Removed  $dest" }
  } else {
    New-Item -ItemType Directory -Force $chromeDir | Out-Null
    Copy-Item (Join-Path $repo "chrome\$name") $dest -Force
    Write-Host "Copied   $dest"
  }
}

Write-Host ""
if ($Uninstall) {
  Write-Host "Uninstalled. Restart Firefox to finish."
} else {
  Write-Host "Installed for:"
  Write-Host "  Firefox : $InstallDir"
  Write-Host "  Profile : $ProfileDir"
  Write-Host "Fully quit Firefox, start it again, and turn on vertical tabs."
}
