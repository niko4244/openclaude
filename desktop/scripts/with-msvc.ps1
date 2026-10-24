# Run a command inside an MSVC x64 developer environment.
#
# Why: on this machine the newest VS Build Tools instance (2026) has no C++
# toolset, so rustc's auto-detection links against it and fails with
# LNK1104 msvcrt.lib. This picks the newest instance that actually ships
# VC\Tools\MSVC\*\lib, and falls back to its onecore CRT libs when the desktop
# x64 libs are absent. Nothing is changed system-wide.
#
#   .\scripts\with-msvc.ps1 cargo test --manifest-path src-tauri/Cargo.toml
#   .\scripts\with-msvc.ps1 npx tauri build
param([Parameter(ValueFromRemainingArguments = $true)] [string[]] $Command)
$ErrorActionPreference = "Stop"

$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$instances = & $vswhere -products * -sort -property installationPath
$picked = $null
foreach ($inst in $instances) {
    $tools = Get-ChildItem "$inst\VC\Tools\MSVC" -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
    if ($tools -and (Test-Path "$inst\VC\Auxiliary\Build\vcvars64.bat")) { $picked = @{ Root = $inst; Tools = $tools.FullName }; break }
}
if (-not $picked) { throw "No Visual Studio instance with the C++ x64 toolset was found." }

$vcvars = Join-Path $picked.Root "VC\Auxiliary\Build\vcvars64.bat"
cmd /c "`"$vcvars`" >nul 2>&1 && set" | ForEach-Object {
    if ($_ -match '^([^=]+)=(.*)$') { [Environment]::SetEnvironmentVariable($matches[1], $matches[2]) }
}
if (-not (Test-Path "$($picked.Tools)\lib\x64\msvcrt.lib")) {
    $env:LIB = "$($picked.Tools)\lib\onecore\x64;$env:LIB"
}

if ($Command.Count -eq 0) { Write-Host "MSVC env ready: $($picked.Tools)"; exit 0 }
& $Command[0] $Command[1..($Command.Count - 1)]
exit $LASTEXITCODE
