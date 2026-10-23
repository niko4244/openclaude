# Build a signed release and the updater manifest (latest.json).
#
#   .\scripts\release.ps1                 # build + sign + write latest.json locally
#   .\scripts\release.ps1 -Publish        # also create a GitHub release on the fork (asks gh to upload)
#
# The signing key lives outside the repo (~\.tauri\openclaude-desktop.key, created with
# `npx tauri signer generate`). Never commit it. The matching public key is in tauri.conf.json.
param([switch] $Publish, [string] $Repo = "niko4244/openclaude")
$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)

$keyPath = Join-Path $HOME ".tauri\openclaude-desktop.key"
if (-not (Test-Path $keyPath)) { throw "Signing key not found at $keyPath" }
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content $keyPath -Raw
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""

.\scripts\with-msvc.ps1 npx tauri build --config '{\"bundle\":{\"createUpdaterArtifacts\":true}}'
if ($LASTEXITCODE -ne 0) { throw "build failed" }

$version = (Get-Content src-tauri\tauri.conf.json | ConvertFrom-Json).version
$nsis = Get-ChildItem src-tauri\target\release\bundle\nsis -Filter "*_$version*-setup.exe" | Select-Object -First 1
$sig = Get-Content "$($nsis.FullName).sig" -Raw
$tag = "desktop-v$version"
$manifest = [ordered]@{
  version  = $version
  notes    = "OpenClaude Desktop $version"
  pub_date = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  platforms = @{ "windows-x86_64" = @{ signature = $sig.Trim(); url = "https://github.com/$Repo/releases/download/$tag/$($nsis.Name)" } }
}
$out = Join-Path $nsis.DirectoryName "latest.json"
$manifest | ConvertTo-Json -Depth 5 | Set-Content $out -Encoding utf8
Write-Host "Signed installer: $($nsis.FullName)"
Write-Host "Updater manifest: $out"

if ($Publish) {
  gh release create $tag $nsis.FullName "$($nsis.FullName).sig" $out --repo $Repo --title "OpenClaude Desktop $version" --notes "Signed Windows build. The in-app updater reads latest.json from this release."
}
