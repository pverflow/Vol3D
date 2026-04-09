param(
  [string]$Subject = "CN=Vol3D Self Signed",
  [string]$FriendlyName = "Vol3D Self Signed",
  [int]$ValidYears = 3,
  [string]$ExportPath = ".\certificates\vol3d-self-signed.pfx",
  [string]$Password = ""
)

$ErrorActionPreference = "Stop"

if (-not $Password.Trim() -and $Subject -and -not $Subject.StartsWith("CN=")) {
  $Password = $Subject
  $Subject = "CN=Vol3D Self Signed"
}

$existingCert = Get-ChildItem Cert:\CurrentUser\My |
  Where-Object { $_.HasPrivateKey -and $_.Subject -eq $Subject } |
  Sort-Object NotAfter -Descending |
  Select-Object -First 1

if ($null -eq $existingCert) {
  $existingCert = New-SelfSignedCertificate `
    -Type CodeSigningCert `
    -Subject $Subject `
    -FriendlyName $FriendlyName `
    -CertStoreLocation "Cert:\CurrentUser\My" `
    -HashAlgorithm "SHA256" `
    -KeyAlgorithm "RSA" `
    -KeyLength 2048 `
    -KeyExportPolicy Exportable `
    -NotAfter (Get-Date).AddYears($ValidYears)
}

if ($Password.Trim()) {
  $resolvedExportPath = [System.IO.Path]::GetFullPath((Join-Path (Get-Location).Path $ExportPath))
  $exportDirectory = Split-Path $resolvedExportPath -Parent

  if (-not (Test-Path $exportDirectory)) {
    New-Item -ItemType Directory -Path $exportDirectory -Force | Out-Null
  }

  $securePassword = ConvertTo-SecureString -String $Password -AsPlainText -Force
  Export-PfxCertificate -Cert $existingCert -FilePath $resolvedExportPath -Password $securePassword | Out-Null
  Write-Host "Exported certificate to $resolvedExportPath"
}

Write-Host "Created or re-used code-signing certificate:"
Write-Host "  Subject:    $($existingCert.Subject)"
Write-Host "  Thumbprint: $($existingCert.Thumbprint)"
Write-Host "  Expires:    $($existingCert.NotAfter.ToString('u'))"

if ($Password.Trim()) {
  Write-Host "  Exported:   $resolvedExportPath"
}

Write-Host ""
Write-Host "You can now build a signed installer with:"
Write-Host "  npm run release:windows"

