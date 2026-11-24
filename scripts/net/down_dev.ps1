param(
  [string]$Root = "<HOME>\otk-zk-metering"
)

Set-Location $Root

Write-Host "== DOWN devnet (compose) =="
docker compose -f .\infra\dev\docker-compose.yml down

# Remove o container antigo "solto" (se existir) para evitar conflito de nome
if (docker ps -a --format "{{.Names}}" | Select-String -SimpleMatch "otk-besu-dev") {
  Write-Host "== removendo container antigo 'otk-besu-dev' (fora do compose) =="
  docker rm -f otk-besu-dev 2>$null | Out-Null
}
