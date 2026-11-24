param(
  [string]$Root = "<HOME>\otk-zk-metering"
)

Set-Location $Root

Write-Host "== UP devnet =="
docker compose -f .\infra\dev\docker-compose.yml up -d

Write-Host "`n== ps =="
docker compose -f .\infra\dev\docker-compose.yml ps
