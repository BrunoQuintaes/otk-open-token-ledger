param(
  [string]$Rpc = "http://127.0.0.1:8545",
  [int]$TimeoutSec = 45
)

function Rpc([string]$method, $params=@()){
  $body = @{
    jsonrpc="2.0"; id=1; method=$method; params=$params
  } | ConvertTo-Json -Compress
  return Invoke-RestMethod -Method Post -Uri $Rpc -ContentType "application/json" -Body $body -TimeoutSec 5
}

$deadline = (Get-Date).AddSeconds($TimeoutSec)

while((Get-Date) -lt $deadline){
  try{
    $chainId = (Rpc "eth_chainId").result
    $netVer  = (Rpc "net_version").result
    $bn      = (Rpc "eth_blockNumber").result
    $cv      = (Rpc "web3_clientVersion").result

    if($chainId -and $netVer -and $bn -and $cv){
      Write-Host "OK:"
      Write-Host "  eth_chainId       = $chainId"
      Write-Host "  net_version       = $netVer"
      Write-Host "  eth_blockNumber   = $bn"
      Write-Host "  web3_clientVersion= $cv"
      exit 0
    }
  } catch {
    Start-Sleep -Milliseconds 800
  }
}

Write-Host "FAIL: RPC não respondeu em $TimeoutSec s ($Rpc)"
exit 1
