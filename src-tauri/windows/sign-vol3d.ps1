param(
  [Parameter(Mandatory = $true)]
  [string]$BinaryPath
)

$ErrorActionPreference = "Stop"

function Resolve-CodeSigningCertificateThumbprint {
  param(
    [string]$Subject
  )

  if ($env:VOL3D_CERT_THUMBPRINT) {
    return $env:VOL3D_CERT_THUMBPRINT.Trim()
  }

  $matchingCert = Get-ChildItem Cert:\CurrentUser\My |
    Where-Object { $_.HasPrivateKey -and $_.Subject -eq $Subject } |
    Sort-Object NotAfter -Descending |
    Select-Object -First 1

  if ($null -eq $matchingCert) {
    return $null
  }

  return $matchingCert.Thumbprint
}

function Resolve-SignToolPath {
  $signtoolCommand = Get-Command signtool.exe -ErrorAction SilentlyContinue | Select-Object -First 1

  if ($null -ne $signtoolCommand) {
    return $signtoolCommand.Source
  }

  $kitsRoot = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\bin"

  if (-not (Test-Path $kitsRoot)) {
    return $null
  }

  $discovered = Get-ChildItem $kitsRoot -Recurse -Filter signtool.exe |
    Where-Object { $_.FullName -match "\\x64\\signtool\.exe$" } |
    Sort-Object FullName -Descending |
    Select-Object -First 1

  if ($null -eq $discovered) {
    return $null
  }

  return $discovered.FullName
}

$requireSigning = $env:VOL3D_REQUIRE_SIGNING -eq "1"
$subject = if ($env:VOL3D_SIGN_SUBJECT) { $env:VOL3D_SIGN_SUBJECT } else { "CN=Vol3D Self Signed" }
$thumbprint = Resolve-CodeSigningCertificateThumbprint -Subject $subject

if (-not $thumbprint) {
  if ($requireSigning) {
    throw "No signing certificate was found. Generate one with 'npm run release:windows:cert' or set VOL3D_CERT_THUMBPRINT."
  }

  Write-Host "Skipping signing for $BinaryPath because no certificate was configured."
  exit 0
}

$signtoolPath = Resolve-SignToolPath

if (-not $signtoolPath) {
  if ($requireSigning) {
    throw "signtool.exe was not found. Install the Windows SDK signing tools before building a signed release."
  }

  Write-Host "Skipping signing for $BinaryPath because signtool.exe was not found."
  exit 0
}

$arguments = @(
  "sign",
  "/sha1",
  $thumbprint,
  "/fd",
  "SHA256"
)

if ($env:VOL3D_TIMESTAMP_URL) {
  $arguments += @(
    "/tr",
    $env:VOL3D_TIMESTAMP_URL,
    "/td",
    "SHA256"
  )
}

$arguments += $BinaryPath

Write-Host "Signing $BinaryPath using certificate $thumbprint"
& $signtoolPath @arguments

if ($LASTEXITCODE -ne 0) {
  throw "signtool.exe failed with exit code $LASTEXITCODE."
}

