$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
Push-Location $repoRoot

try {
  $env:VOL3D_REQUIRE_SIGNING = "1"

  if (-not $env:VOL3D_SIGN_SUBJECT) {
    $env:VOL3D_SIGN_SUBJECT = "CN=Vol3D Self Signed"
  }

  npm run tauri:build:nsis

  if ($LASTEXITCODE -ne 0) {
    throw "Windows release build failed with exit code $LASTEXITCODE."
  }

  $exePath = Join-Path $repoRoot "src-tauri\target\release\vol3d.exe"
  $bundleDirectory = Join-Path $repoRoot "src-tauri\target\release\bundle\nsis"
  $bundles = Get-ChildItem $bundleDirectory -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending

  Write-Host "Built executable artifact:"
  if (Test-Path $exePath) {
    Write-Host "  $exePath"
  } else {
    Write-Host "  Not found: $exePath"
  }

  if ($bundles) {
    Write-Host "Built installer artifacts:"
    $bundles | ForEach-Object { Write-Host "  $($_.FullName)" }
  } else {
    Write-Host "Build completed, but no NSIS bundle files were found under $bundleDirectory"
  }
}
finally {
  Pop-Location
}

