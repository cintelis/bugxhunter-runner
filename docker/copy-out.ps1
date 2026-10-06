# Copies a folder from the agent's workspace back to Windows, e.g. to review
# or keep what the agent produced. Never overwrites an existing folder.
#
#   powershell -File docker/copy-out.ps1 my-repo C:\temp\my-repo-from-agent
param(
  [Parameter(Mandatory = $true)][string]$Name,
  [Parameter(Mandatory = $true)][string]$Destination
)
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
if ($Name -notmatch '^[A-Za-z0-9._/-]+$' -or $Name -match '\.\.') { throw "Use a folder path inside /workspace: $Name" }
if (Test-Path $Destination) { throw "$Destination already exists; pick a new folder." }
Push-Location $root
try {
  docker compose cp "agent:/workspace/$Name" $Destination
  Write-Host "Copied /workspace/$Name -> $Destination"
} finally {
  Pop-Location
}
