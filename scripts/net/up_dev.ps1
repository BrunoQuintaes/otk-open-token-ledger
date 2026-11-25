param(
  [string]$Root = "<HOME>\otk-zk-metering"
)
# Starts the local Besu development chain (Docker Compose stack in infra/dev) in the background.
#
# Usage: .\scripts\net\up_dev.ps1 [-Root <repository folder>]
#   -Root  Repository root that holds infra\dev\docker-compose.yml. The default value is a placeholder
#          path, so pass -Root (for example -Root .).
# Effects: "docker compose up -d", then lists the services. Check readiness with health_dev.ps1.

Set-Location $Root

Write-Host "== UP devnet =="
docker compose -f .\infra\dev\docker-compose.yml up -d

Write-Host "`n== ps =="
docker compose -f .\infra\dev\docker-compose.yml ps
