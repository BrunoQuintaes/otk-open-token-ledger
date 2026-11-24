param(
  [string]$OutDir = "<HOME>\otk-zk-metering\docs\runs"
)

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$ts = Get-Date -Format "yyyyMMdd_HHmmss"
$base = Join-Path $OutDir "devnet_$ts"
New-Item -ItemType Directory -Force -Path $base | Out-Null

Write-Host "== Snapshot devnet em: $base =="

docker ps -a --no-trunc | Out-File -Encoding UTF8 (Join-Path $base "docker_ps_all.txt")

# logs completos (se for enorme, depois a gente poda)
docker logs otk-besu-dev 2>&1 | Out-File -Encoding UTF8 (Join-Path $base "LOG_otk-besu-dev_full.txt")

# tail também
docker logs --tail 300 otk-besu-dev 2>&1 | Out-File -Encoding UTF8 (Join-Path $base "LOG_otk-besu-dev_tail300.txt")

# inspect
docker inspect otk-besu-dev | Out-File -Encoding UTF8 (Join-Path $base "INSPECT_otk-besu-dev.json")

# eventos (últimos 60 min) — ajuda MUITO quando cai “do nada”
docker events --since 60m --until 0m | Out-File -Encoding UTF8 (Join-Path $base "docker_events_60m.txt")

Write-Host "OK: snapshot gerado ✅"
