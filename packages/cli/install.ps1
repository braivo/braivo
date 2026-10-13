# SPDX-FileCopyrightText: 2026 Konstantin Tarkus
# SPDX-License-Identifier: AGPL-3.0-only

# Installs the released `braivo` for Windows (docs/adr/0027-standalone-cli.md):
#
#   irm https://braivo.app/install.ps1 | iex
#
# $env:BRAIVO_VERSION picks a release tag, the latest by default. Running it
# again updates. In a script block, so `iex` leaves no variable behind in the
# caller's session, and a failure throws rather than closing its window.
& {
  $ErrorActionPreference = 'Stop'
  # Windows PowerShell 5.1 shows a progress bar that slows the download tenfold.
  $ProgressPreference = 'SilentlyContinue'

  $version = if ($env:BRAIVO_VERSION) { $env:BRAIVO_VERSION } else { 'latest' }
  $url = if ($version -eq 'latest') {
    'https://github.com/braivo/braivo/releases/latest/download/braivo-windows-x64.exe'
  } else {
    "https://github.com/braivo/braivo/releases/download/$version/braivo-windows-x64.exe"
  }
  # x64 only: Windows on Arm runs it emulated.
  $dir = Join-Path $env:LOCALAPPDATA 'Programs\Braivo'
  $exe = Join-Path $dir 'braivo.exe'

  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  Write-Host "Downloading $url"
  # Ends in .exe, or Windows will not start it; per process, as install.sh's.
  $partial = Join-Path $dir "braivo.$PID.exe"
  try {
    Invoke-WebRequest -Uri $url -OutFile $partial -UseBasicParsing
    # Started once before replacing what works: a build that cannot run here
    # never replaces one that can.
    $installed = & $partial --version
    if ($LASTEXITCODE -ne 0) { throw 'The downloaded braivo does not run on this machine.' }
    # Windows refuses to replace a running file, such as a `braivo mcp` an
    # agent started.
    try { Move-Item -Force $partial $exe }
    catch { throw "Could not replace $exe. Quit the apps running braivo, such as your AI agent, and run this again. $($_.Exception.Message)" }
  } finally {
    Remove-Item -Force -ErrorAction SilentlyContinue $partial
  }

  # Through the registry, unexpanded: [Environment]::SetEnvironmentVariable
  # would store the user's Path as plain text, freezing each %VARIABLE% in it.
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
  $userPath = $key.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
  if (($userPath -split ';') -notcontains $dir) {
    $key.SetValue('Path', ((@($userPath, $dir) | Where-Object { $_ }) -join ';'), 'ExpandString')
    # Setting any variable this way tells running programs the environment
    # changed, so a terminal opened next sees the new Path.
    [Environment]::SetEnvironmentVariable('BRAIVO_INSTALL', '1', 'User')
    [Environment]::SetEnvironmentVariable('BRAIVO_INSTALL', $null, 'User')
  }
  $key.Close()
  if (($env:Path -split ';') -notcontains $dir) { $env:Path += ";$dir" }

  Write-Host "Installed $installed as $exe"
}
