# Creates .env for docker compose: a login password, a cookie secret, the
# agent proxy token, and the SCX key (taken from `opencode auth login`).
# Existing values are kept, so re-running is safe. Secrets are not printed.
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

if (-not $vals["SCX_API"]) {
  $auth = Join-Path $HOME ".local\share\opencode\auth.json"
  if (Test-Path $auth) { $vals["SCX_API"] = (Get-Content $auth -Raw | ConvertFrom-Json).scx.key }
  if (-not $vals["SCX_API"]) { throw "No SCX key found. Run 'opencode auth login' (provider id: scx) or add SCX_API=... to .env." }
}
$newPassword = -not $vals["OPEN_RUNNER_PASSWORD"]
if ($newPassword) { $vals["OPEN_RUNNER_PASSWORD"] = New-Secret 12 }
if (-not $vals["OPEN_RUNNER_SECRET"]) { $vals["OPEN_RUNNER_SECRET"] = New-Secret 32 }
if (-not $vals["SCX_PROXY_TOKEN"]) { $vals["SCX_PROXY_TOKEN"] = New-Secret 32 }

$out = ($vals.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join "`n"
[IO.File]::WriteAllText($envFile, $out + "`n", (New-Object Text.UTF8Encoding $false))

Write-Host "Wrote $envFile"
if ($newPassword) { Write-Host "A login password was generated: see OPEN_RUNNER_PASSWORD in .env (change it if you like)." }
Write-Host "Next: docker compose up -d --build   then open http://localhost:8790"
