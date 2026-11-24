param([string]$Rpc = "http://127.0.0.1:9545")
$ErrorActionPreference = "Stop"

function Rpc([string]$method, $params=@()){
  $body = @{ jsonrpc="2.0"; id=1; method=$method; params=$params } | ConvertTo-Json -Compress
  Invoke-RestMethod -Method Post -Uri $Rpc -ContentType "application/json" -Body $body -TimeoutSec 10
}

Write-Host "RPC=$Rpc" -ForegroundColor Cyan
"chainId=" + (Rpc "eth_chainId").result
"net_version=" + (Rpc "net_version").result
"blockNumber=" + (Rpc "eth_blockNumber").result
"peerCount=" + (Rpc "net_peerCount").result
"validators=" + ((Rpc "ibft_getValidatorsByBlockNumber" @("latest")).result | ConvertTo-Json -Compress)
