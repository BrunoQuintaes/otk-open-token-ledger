param(
  [int]$Tail = 200
)
# Prints the last lines of the otk-besu-dev container log (the local development chain).
#
# Usage: .\scripts\net\logs_dev_tail.ps1 [-Tail <lines>]   (default 200 lines)
# Read-only; requires Docker. Reads no environment variables.
Write-Host "== logs tail: otk-besu-dev (last $Tail) =="
docker logs --tail $Tail otk-besu-dev
