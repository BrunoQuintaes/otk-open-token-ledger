param([string]$Root = (Resolve-Path ".").Path)
$ErrorActionPreference = "Continue"
Set-Location $Root
docker compose -f .\infra\ibft\docker-compose.yml down
