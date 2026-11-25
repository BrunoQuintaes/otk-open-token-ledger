param([string]$Root = (Resolve-Path ".").Path)
# Stops the local IBFT (multi-validator Besu) test network defined in infra/ibft.
#
# Usage: .\scripts\net\down_ibft.ps1 [-Root <repository folder>]   (default: the current folder)
# Effects: runs "docker compose down" for infra\ibft\docker-compose.yml. Errors do not stop the script
#          ($ErrorActionPreference = Continue). Requires Docker with compose. Reads no environment variables.
$ErrorActionPreference = "Continue"
Set-Location $Root
docker compose -f .\infra\ibft\docker-compose.yml down
