param(
  [string]$Root = "<HOME>\otk-zk-metering"
)
# Stops the local Besu development chain (Docker Compose stack in infra/dev) and removes a stray old container.
#
# Usage: .\scripts\net\down_dev.ps1 [-Root <repository folder>]
#   -Root  Repository root that holds infra\dev\docker-compose.yml. The default value is a placeholder
#          path, so pass -Root (for example -Root .) when running it.
# Effects: runs "docker compose down" for infra\dev, then force-removes a container named otk-besu-dev
#          if one exists outside the compose project (avoids a name conflict on the next start).
# Exit code: the one of the last command; Docker errors are printed, not trapped.
# Requires: Docker with the compose plugin. Reads no environment variables.

Set-Location $Root

Write-Host "== DOWN devnet (compose) =="
docker compose -f .\infra\dev\docker-compose.yml down

# Remove o container antigo "solto" (se existir) para evitar conflito de nome
if (docker ps -a --format "{{.Names}}" | Select-String -SimpleMatch "otk-besu-dev") {
  Write-Host "== removendo container antigo 'otk-besu-dev' (fora do compose) =="
  docker rm -f otk-besu-dev 2>$null | Out-Null
}
