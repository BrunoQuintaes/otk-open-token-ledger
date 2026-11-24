param(
  [string]$Rpc = "http://127.0.0.1:8545"
)

function Rpc([string]$method, $params=@()){
  $body = @{
    jsonrpc="2.0"; id=1; method=$method; params=$params
  } | ConvertTo-Json -Compress
  return Invoke-RestMethod -Method Post -Uri $Rpc -ContentType "application/json" -Body $body -TimeoutSec 8
}

Write-Host "== DEV RPC Probe =="

$chainId = (Rpc "eth_chainId").result
$netVer  = (Rpc "net_version").result
$bn      = (Rpc "eth_blockNumber").result
$cv      = (Rpc "web3_clientVersion").result
$gp      = (Rpc "eth_gasPrice").result
$coin    = (Rpc "eth_coinbase").result

Write-Host "eth_chainId        = $chainId"
Write-Host "net_version        = $netVer"
Write-Host "eth_blockNumber    = $bn"
Write-Host "web3_clientVersion = $cv"
Write-Host "eth_gasPrice        = $gp"
Write-Host "eth_coinbase        = $coin"

# balance coinbase
if($coin -and $coin -ne "0x0000000000000000000000000000000000000000"){
  $bal = (Rpc "eth_getBalance" @($coin, "latest")).result
  Write-Host "coinbase balance    = $bal"
} else {
  Write-Host "coinbase balance    = (n/a)"
}

# accounts (muitos clientes retornam vazio)
try{
  $acc = (Rpc "eth_accounts").result
  if($acc){
    Write-Host "`neth_accounts:"
    $acc | ForEach-Object { Write-Host "  - $_" }
  } else {
    Write-Host "`neth_accounts: (vazio)"
  }
} catch {
  Write-Host "`neth_accounts: erro/indisponível"
}
