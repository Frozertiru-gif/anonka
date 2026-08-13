<#
  One-file local launcher for the Phase 0 Telegram smoke test.

  1. Credentials live in .\.anonka\config.yaml (not in Git).
  2. Run: .\run-anonka.ps1 login
     Enter the Telegram verification code (and 2FA password, if enabled).
  3. Run: .\run-anonka.ps1 start
  4. Send a DM to the dedicated account from a second Telegram account.

  The generated config and session stay in .\.anonka\ (ignored by Git).
#>
[CmdletBinding()]
param(
  [ValidateSet("login", "start")]
  [string]$Action = "start"
)

# ========================== SETTINGS ==========================
$CreatorId = "creator-main"
# ==============================================================

$ProjectRoot = $PSScriptRoot
$DataDirectory = Join-Path $ProjectRoot ".anonka"
$ConfigPath = Join-Path $DataDirectory "config.yaml"
$SessionDirectory = Join-Path $DataDirectory "sessions"
$WorkspaceDirectory = Join-Path $DataDirectory "workspace"

if (-not (Test-Path $ConfigPath)) {
  throw "Missing local configuration: $ConfigPath"
}

# Keep the legacy runtime's workspace/memory files beside this creator's local
# config and session, rather than under the global C:\Users\D\.teleton path.
$env:TELETON_HOME = $DataDirectory
New-Item -ItemType Directory -Force -Path $DataDirectory, $SessionDirectory, $WorkspaceDirectory | Out-Null

Push-Location $ProjectRoot
try {
  & npm.cmd run build
  if ($LASTEXITCODE -ne 0) { throw "Build failed." }

  if ($Action -eq "login") {
    Write-Host "Telegram will now ask for the verification code in this terminal." -ForegroundColor Cyan
    & node.exe .\dist\cli\index.js creator login $CreatorId -c $ConfigPath
  } else {
    Write-Host "Starting Anonka for creator '$CreatorId'. Stop it with Ctrl+C." -ForegroundColor Cyan
    & node.exe .\dist\cli\index.js start --creator $CreatorId -c $ConfigPath
  }

  if ($LASTEXITCODE -ne 0) { throw "Anonka exited with code $LASTEXITCODE." }
} finally {
  Pop-Location
}
