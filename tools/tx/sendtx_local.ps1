param(
  [string]$RPC_URL = "http://127.0.0.1:9545"
)

$ErrorActionPreference = "Stop"
$env:RPC_URL = $RPC_URL

Write-Host "RPC_URL=$env:RPC_URL"
node "tools\tx\sendtx.mjs"
