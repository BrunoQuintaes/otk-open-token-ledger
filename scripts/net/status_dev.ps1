param(
  [string]$Root = "<HOME>\otk-zk-metering"
)
Set-Location $Root

Write-Host "== docker ps (dev) =="
docker ps -a --no-trunc

Write-Host "`n== compose ps (dev) =="
docker compose -f .\infra\dev\docker-compose.yml ps

Write-Host "`n== health (dev) =="
.\scripts\net\health_dev.ps1
