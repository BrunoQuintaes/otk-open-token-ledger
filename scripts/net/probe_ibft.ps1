param([string]$Rpc = "http://127.0.0.1:9545")
# Prints a one-shot diagnostic of the local IBFT test network over JSON-RPC, including the validator set.
#
# Usage: .\scripts\net\probe_ibft.ps1 [-Rpc <url>]   (default: local port 9545)
# Prints chain id, network version, block number, peer count and the IBFT validators at the latest block.
# Stops at the first failed call ($ErrorActionPreference = Stop); each call times out after 10 s.
# Read-only: sends only query methods. Reads no environment variables.
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
