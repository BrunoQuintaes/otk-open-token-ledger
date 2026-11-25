param(
  [string]$Root = "<HOME>\otk-zk-metering"
)
# Shows the state of the local development chain: all containers, the compose services and the RPC health.
#
# Usage: .\scripts\net\status_dev.ps1 [-Root <repository folder>]
#   -Root  Repository root. The default value is a placeholder path, so pass -Root (for example -Root .).
# Calls .\scripts\net\health_dev.ps1 at the end, so its exit code is that script's (0 healthy, 1 timeout).
# Read-only; requires Docker with compose.
Set-Location $Root

Write-Host "== docker ps (dev) =="
docker ps -a --no-trunc

Write-Host "`n== compose ps (dev) =="
docker compose -f .\infra\dev\docker-compose.yml ps

Write-Host "`n== health (dev) =="
.\scripts\net\health_dev.ps1
