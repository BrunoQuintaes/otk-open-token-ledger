param([string]$Root = (Resolve-Path ".").Path)
$ErrorActionPreference = "Stop"
Set-Location $Root
docker compose -f .\infra\ibft\docker-compose.yml up -d
docker compose -f .\infra\ibft\docker-compose.yml ps
