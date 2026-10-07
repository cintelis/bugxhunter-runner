# Creates .env for docker compose: a cookie secret and the agent proxy token.
# Existing values are kept, so re-running is safe. Secrets are not printed.
# There is no password: sign-in uses the vault's passkey once you set it up in the UI.
param([switch]$CopyScxKey)
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$envFile = Join-Path $root ".env"

function New-Secret([int]$bytes = 24) {
  $b = New-Object byte[] $bytes
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  [Convert]::ToBase64String($b).TrimEnd("=").Replace("+", "-").Replace("/", "_")
}

$vals = [ordered]@{}
if (Test-Path $envFile) {
  foreach ($line in Get-Content $envFile) {
    if ($line -match '^\s*([A-Z0-9_]+)=(.*)$') { $vals[$Matches[1]] = $Matches[2] }
  }
}

# The SCX key is best kept in the vault (set it up in the UI after the first
# start): it is then sealed at rest instead of sitting in .env. Pass -CopyScxKey
# to copy the key from `opencode auth login` into .env anyway.
if ($CopyScxKey -and -not $vals["SCX_API"]) {
  $auth = Join-Path $HOME ".local\share\opencode\auth.json"
  if (Test-Path $auth) { $vals["SCX_API"] = (Get-Content $auth -Raw | ConvertFrom-Json).scx.key }
  if (-not $vals["SCX_API"]) { throw "No SCX key found. Run 'opencode auth login' (provider id: scx) or add SCX_API=... to .env." }
}
if (-not $vals["OPEN_RUNNER_SECRET"]) { $vals["OPEN_RUNNER_SECRET"] = New-Secret 32 }
if (-not $vals["SCX_PROXY_TOKEN"]) { $vals["SCX_PROXY_TOKEN"] = New-Secret 32 }
# A release's deploy bundle ships a VERSION file: pin `docker compose pull` to its images.
$versionFile = Join-Path $root "VERSION"
if (-not $vals["BXH_VERSION"] -and (Test-Path $versionFile)) { $vals["BXH_VERSION"] = (Get-Content $versionFile -Raw).Trim() }

$out = ($vals.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join "`n"
[IO.File]::WriteAllText($envFile, $out + "`n", (New-Object Text.UTF8Encoding $false))

Write-Host "Wrote $envFile"
Write-Host "Next: docker compose up -d --build   then open http://localhost:8790"
Write-Host "Then set up the vault in the sidebar (passphrase + passkey): it seals your SCX key and turns on passkey sign-in."
