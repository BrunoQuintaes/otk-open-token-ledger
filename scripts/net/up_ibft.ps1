param([string]$Root = (Resolve-Path ".").Path)
# Starts the local IBFT (multi-validator Besu) test network defined in infra/ibft, in the background.
#
# Usage: .\scripts\net\up_ibft.ps1 [-Root <repository folder>]   (default: the current folder)
# Effects: "docker compose up -d" for infra\ibft, then lists the services. Stops at the first error.
# Check it with probe_ibft.ps1; stop it with down_ibft.ps1.
$ErrorActionPreference = "Stop"
Set-Location $Root
docker compose -f .\infra\ibft\docker-compose.yml up -d
docker compose -f .\infra\ibft\docker-compose.yml ps
