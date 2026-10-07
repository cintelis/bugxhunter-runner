# Copies a folder (e.g. a code repo) from Windows into the agent's sandboxed
# workspace, as a snapshot: the agent works on the copy, never your original.
#
#   powershell -File docker/copy-in.ps1 C:\code\my-repo            # -> /workspace/my-repo
#   powershell -File docker/copy-in.ps1 C:\code\my-repo -Name demo # -> /workspace/demo
#
# Files are written by the agent's own (non-root) user, so it can edit them.
# Bulky or secret folders are skipped by default; pass -Exclude to change that.
param(
  [Parameter(Mandatory = $true)][string]$Source,
  [string]$Name,
  [string[]]$Exclude = @("node_modules", ".venv", "venv", "__pycache__", "dist", "build", ".next", ".env", ".env.*"),
  [switch]$Force
)
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$src = (Resolve-Path $Source).Path
if (-not (Test-Path $src -PathType Container)) { throw "Not a folder: $src" }
if (-not $Name) { $Name = Split-Path $src -Leaf }
if ($Name -notmatch '^[A-Za-z0-9._-]+$') { throw "Use a simple folder name (letters, digits, . _ -): $Name" }
$dest = "/workspace/$Name"

Push-Location $root
try {
  docker compose exec -T agent test -e $dest 2>$null
  if ($LASTEXITCODE -eq 0) {
    if (-not $Force) { throw "$dest already exists in the workspace. Use -Force to replace it, or -Name to pick another name." }
    docker compose exec -T agent rm -rf $dest
  }
  docker compose exec -T agent mkdir -p $dest
  $excludeArgs = ($Exclude | ForEach-Object { "--exclude=`"$_`"" }) -join " "
  # cmd's pipe passes the tar stream through byte-for-byte (PowerShell 5.1's doesn't).
  cmd /c "tar -c -f - $excludeArgs -C `"$src`" . | docker compose exec -T agent tar -x -f - -C $dest"
  if ($LASTEXITCODE -ne 0) { throw "Copy failed (exit $LASTEXITCODE)." }
  $count = docker compose exec -T agent sh -c "find '$dest' -type f | wc -l"
  Write-Host "Copied $src -> $dest ($($count.Trim()) files; skipped: $($Exclude -join ', '))"
  Write-Host "In BugXHunter, set Project to $dest and click Open."
} finally {
  Pop-Location
}
