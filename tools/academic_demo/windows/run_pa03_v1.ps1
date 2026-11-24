#Requires -Version 5.1
<#
.SYNOPSIS
  H1R2 B3 - runs ONLY the two legacy PA-03 v1 contract tests on the author's machine and keeps sanitized evidence.

.DESCRIPTION
  The two tests below (tools/hardhat/test/PA03Closeout.test.js, battery step R07e_contracts) are skipped everywhere
  except where the historical v1 proving key metering_v1_final.zkey exists. That key is NOT versioned and NOT
  distributed; it exists only on the author's machine. In docs/academic_release/expected_outcomes.json both tests
  are "pending_author_evidence" until the author runs them (<em dash> = U+2014 in the real names):
    PA-03 Closeout <em dash> Full Loop (ZK Proof + On-Chain) > generates fresh ZK proof and submits on-chain <em dash> captures real txHash
    PA-03 Closeout <em dash> Full Loop (ZK Proof + On-Chain) > second submit with same commitment is rejected (anti-replay)

  What this script does (and nothing else):
    1. finds the key LOCALLY: -ZkeyPath, then $env:OTK_PA03_V1_ZKEY, then the documented locations
       <repo>\zk\build\metering_v1_final.zkey and <repo>\..\integ\zk\build\metering_v1_final.zkey;
    2. computes its SHA-256 with Get-FileHash and STOPS (exit 4) unless it equals the published hash
       (scripts/ops/repro_contracts.sh, ZKEY_SHA256). The key content is never read into the script, printed,
       copied, moved, linked or archived; only its path is passed to the test through OTK_PA03_V1_ZKEY;
    3. runs exactly the R07e command restricted to that file:
         cd tools\hardhat ; node --test --test-reporter=tap --test-concurrency=1 test/PA03Closeout.test.js
    4. saves ONLY sanitized evidence (node/npm/OS/PowerShell versions, commit SHA, key SHA-256, the TAP output with
       absolute paths replaced, timestamps) in an output directory OUTSIDE the repository by default.

  Network: none by default. -NpmCi runs npm ci (root and tools\hardhat) and -Compile runs "npx hardhat compile",
  which downloads solc 0.8.24 only if it is not cached yet. Both are opt-in switches.

  Result: a local PASS here does NOT change the repository status. The tests stay pending_author_evidence until the
  integrator regenerates expected_outcomes.json with this TAP as --pass-evidence.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools\academic_demo\windows\run_pa03_v1.ps1 -ZkeyPath D:\keys\metering_v1_final.zkey -NpmCi -Compile

.NOTES
  Exit codes: 0 both tests passed locally; 1 tests ran and did not both pass; 2 environment/usage problem;
  3 key not found; 4 key SHA-256 differs from the published one; 5 dependencies/artifacts missing; 6 timeout.
  This file is ASCII on purpose (Windows PowerShell 5.1 reads BOM-less files as ANSI); the em dash in the test
  names is built with [char]0x2014.
#>
[CmdletBinding()]
param(
  [string]$ZkeyPath = '',
  [string]$RepoRoot = '',
  [string]$OutDir = '',
  [switch]$NpmCi,
  [switch]$Compile,
  [switch]$AllowOutputInsideRepo,
  [int]$TimeoutSec = 1200
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

# H1R2 B3: published SHA-256 of the ORIGINAL v1 key (same value as scripts/ops/repro_contracts.sh ZKEY_SHA256).
$ExpectedSha256 = 'e53adcc7650a10b71b9e05e29c56d46700654f8937aaa6ba1e1616805628d60f'
$EnvVarName = 'OTK_PA03_V1_ZKEY'
$TestFile = 'test/PA03Closeout.test.js'
$Dash = [string][char]0x2014
$SuiteName = 'PA-03 Closeout ' + $Dash + ' Full Loop (ZK Proof + On-Chain)'
$TestNames = @(
  ('generates fresh ZK proof and submits on-chain ' + $Dash + ' captures real txHash'),
  'second submit with same commitment is rejected (anti-replay)'
)

function Write-Info([string]$Message) { Write-Host ('[pa03-v1] ' + $Message) }
function Stop-Run([int]$Code, [string]$Message) {
  Write-Host ('[pa03-v1] STOP (exit ' + $Code + '): ' + $Message) -ForegroundColor Yellow
  Write-Host '[pa03-v1] status unchanged: pending_author_evidence'
  exit $Code
}

function Get-FullPath([string]$Path) {
  # relative paths resolve against the PowerShell location (GetFullPath alone would use the process directory)
  if (-not [IO.Path]::IsPathRooted($Path)) { $Path = Join-Path (Get-Location).ProviderPath $Path }
  return [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
}

function Test-IsInside([string]$Child, [string]$Parent) {
  $c = (Get-FullPath $Child) + [IO.Path]::DirectorySeparatorChar
  $p = (Get-FullPath $Parent) + [IO.Path]::DirectorySeparatorChar
  return $c.StartsWith($p, [StringComparison]::OrdinalIgnoreCase)
}

# Runs a native command and returns its trimmed stdout, or 'unavailable'. stderr is discarded.
function Get-NativeOutput([string]$Exe, [string[]]$Arguments) {
  $saved = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = & $Exe @Arguments 2>$null
    if ($LASTEXITCODE -ne 0) { return 'unavailable' }
    return (($out | Out-String).Trim())
  } catch {
    return 'unavailable'
  } finally {
    $ErrorActionPreference = $saved
  }
}

function Invoke-OptionalNpmCi([string]$Dir) {
  Write-Info ('npm ci (opt-in -NpmCi, uses the network) in ' + $Dir)
  Push-Location $Dir
  try {
    & npm ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { Stop-Run 5 ('npm ci failed in ' + $Dir) }
  } finally { Pop-Location }
}

function ConvertTo-Sanitized([string]$Text, [object[]]$Pairs) {
  foreach ($pair in $Pairs) {
    $needle = [string]$pair[0]
    if ($needle.Length -lt 3) { continue }
    foreach ($variant in @($needle, $needle.Replace('\', '/'), $needle.Replace('/', '\'), $needle.Replace('\', '\\'))) {
      $Text = [regex]::Replace($Text, [regex]::Escape($variant), [string]$pair[1], 'IgnoreCase')
    }
  }
  return $Text
}

function Write-Utf8([string]$Path, [string]$Text) {
  [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding $false))
}

# ---------------------------------------------------------------- 0. repository
if ($RepoRoot -eq '') { $RepoRoot = Join-Path $PSScriptRoot '..\..\..' }
$RepoRoot = Get-FullPath $RepoRoot
$HardhatDir = Join-Path $RepoRoot 'tools\hardhat'
$TestPath = Join-Path $HardhatDir $TestFile
if (-not (Test-Path -LiteralPath $TestPath -PathType Leaf)) { Stop-Run 2 ('test file not found: ' + $TestPath + ' (wrong -RepoRoot?)') }
if (-not (Select-String -LiteralPath $TestPath -Pattern ('process.env.' + $EnvVarName) -SimpleMatch -Quiet)) {
  Stop-Run 2 ('this checkout of PA03Closeout.test.js does not read ' + $EnvVarName + ' (older than H1R2 B3); refusing to run')
}
Write-Info ('repository: ' + $RepoRoot)

# ---------------------------------------------------------------- 1. key (local only)
$ZkeyCandidates = @()
if ($ZkeyPath -ne '') { $ZkeyCandidates += ,@('parameter -ZkeyPath', $ZkeyPath) }
$ZkeyFromEnv = [Environment]::GetEnvironmentVariable($EnvVarName)
if ($ZkeyFromEnv) { $ZkeyCandidates += ,@('environment ' + $EnvVarName, $ZkeyFromEnv) }
$ZkeyCandidates += ,@('documented default <repo>\zk\build', (Join-Path $RepoRoot 'zk\build\metering_v1_final.zkey'))
$ZkeyCandidates += ,@('documented author layout <repo>\..\integ\zk\build', (Join-Path $RepoRoot '..\integ\zk\build\metering_v1_final.zkey'))

$ZkeyFull = $null
$ZkeySource = $null
foreach ($cand in $ZkeyCandidates) {
  if (Test-Path -LiteralPath $cand[1] -PathType Leaf) { $ZkeyFull = Get-FullPath $cand[1]; $ZkeySource = $cand[0]; break }
  if ($cand[0] -like 'parameter*') { Stop-Run 3 ('-ZkeyPath given but no file there: ' + $cand[1]) }
}
if ($null -eq $ZkeyFull) {
  Stop-Run 3 'historical v1 key metering_v1_final.zkey not found locally (use -ZkeyPath or OTK_PA03_V1_ZKEY). Do NOT regenerate it: scripts/setup/03_finalize.sh yields another key with another hash.'
}
Write-Info ('key found via ' + $ZkeySource)

$ZkeyHash = (Get-FileHash -LiteralPath $ZkeyFull -Algorithm SHA256).Hash.ToLowerInvariant()
$ZkeyBytes = (Get-Item -LiteralPath $ZkeyFull).Length
Write-Info ('key sha256 ' + $ZkeyHash + ' (' + $ZkeyBytes + ' bytes)')
if ($ZkeyHash -ne $ExpectedSha256) {
  Write-Info ('expected   ' + $ExpectedSha256)
  Write-Info 'STOP: this is not the original v1 key; no test was run and no evidence was written'
  exit 4
}
Write-Info 'key sha256 matches the published hash of the original artifact'

# ---------------------------------------------------------------- 2. output directory (outside the repo by default)
$Stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMdd'T'HHmmss'Z'")
if ($OutDir -eq '') { $OutDir = Join-Path $HOME ('otk_pa03_v1_evidence\' + $Stamp) }
$OutDir = Get-FullPath $OutDir
if ((Test-IsInside $OutDir $RepoRoot) -and -not $AllowOutputInsideRepo) {
  Stop-Run 2 ('output directory is inside the repository: ' + $OutDir + ' (choose another -OutDir or pass -AllowOutputInsideRepo)')
}
$ZkeyDir = Split-Path -Parent $ZkeyFull
if (Test-IsInside $ZkeyFull $OutDir) { Stop-Run 2 'the key file must not be inside the output directory (the evidence directory is meant to be shared)' }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
Write-Info ('evidence directory: ' + $OutDir)

# ---------------------------------------------------------------- 3. dependencies (opt-in network)
if ($NpmCi) { Invoke-OptionalNpmCi -Dir $RepoRoot }
if ($NpmCi) { Invoke-OptionalNpmCi -Dir $HardhatDir }
$NodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($null -eq $NodeCmd) { Stop-Run 5 'node not found in PATH' }
if (-not (Test-Path -LiteralPath (Join-Path $HardhatDir 'node_modules\hardhat'))) { Stop-Run 5 'tools\hardhat\node_modules missing (rerun with -NpmCi)' }
$SnarkRoot = Join-Path $RepoRoot 'node_modules\snarkjs'
$SnarkHh = Join-Path $HardhatDir 'node_modules\snarkjs'
if (-not ((Test-Path -LiteralPath $SnarkRoot) -or (Test-Path -LiteralPath $SnarkHh))) { Stop-Run 5 'snarkjs not installed (rerun with -NpmCi)' }
if ($Compile) {
  Write-Info 'npx hardhat compile (opt-in -Compile; downloads solc only if not cached)'
  Push-Location $HardhatDir
  try {
    & npx hardhat compile
    if ($LASTEXITCODE -ne 0) { Stop-Run 5 'hardhat compile failed' }
  } finally { Pop-Location }
}
if (-not (Test-Path -LiteralPath (Join-Path $HardhatDir 'artifacts'))) { Stop-Run 5 'tools\hardhat\artifacts missing (rerun with -Compile)' }

# ---------------------------------------------------------------- 4. environment facts (sanitized)
$GitSha = Get-NativeOutput 'git' @('-C', $RepoRoot, 'rev-parse', 'HEAD')
$GitDirty = Get-NativeOutput 'git' @('-C', $RepoRoot, 'status', '--porcelain', '--untracked-files=no')
$NodeVersion = Get-NativeOutput 'node' @('--version')
$NpmVersion = Get-NativeOutput 'npm' @('--version')
$WasmPath = Join-Path $RepoRoot 'zk\build\metering_v1_js\metering_v1.wasm'
$WasmHash = 'missing'
if (Test-Path -LiteralPath $WasmPath) { $WasmHash = (Get-FileHash -LiteralPath $WasmPath -Algorithm SHA256).Hash.ToLowerInvariant() }
$TestHash = (Get-FileHash -LiteralPath $TestPath -Algorithm SHA256).Hash.ToLowerInvariant()

# ---------------------------------------------------------------- 5. run exactly the two tests
$RawDir = Join-Path ([IO.Path]::GetTempPath()) ('otk_pa03_raw_' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $RawDir | Out-Null
$RawOut = Join-Path $RawDir 'stdout.txt'
$RawErr = Join-Path $RawDir 'stderr.txt'
$NodeArgs = @('--test', '--test-reporter=tap', '--test-concurrency=1', $TestFile)
Write-Info ('running: node ' + ($NodeArgs -join ' ') + '   (cwd tools\hardhat, ' + $EnvVarName + ' set to the key path)')

$SavedEnv = [Environment]::GetEnvironmentVariable($EnvVarName)
$StartedUtc = (Get-Date).ToUniversalTime().ToString('o')
$TimedOut = $false
try {
  $env:OTK_PA03_V1_ZKEY = $ZkeyFull
  $proc = Start-Process -FilePath $NodeCmd.Source -ArgumentList $NodeArgs -WorkingDirectory $HardhatDir `
    -RedirectStandardOutput $RawOut -RedirectStandardError $RawErr -NoNewWindow -PassThru
  $null = $proc.Handle
  if (-not $proc.WaitForExit($TimeoutSec * 1000)) {
    $TimedOut = $true
    try { $proc.Kill() } catch { Write-Info 'could not stop the node process after timeout' }
  }
  $proc.WaitForExit()
  $NodeExit = $proc.ExitCode
} finally {
  $env:OTK_PA03_V1_ZKEY = $SavedEnv
}
$FinishedUtc = (Get-Date).ToUniversalTime().ToString('o')

# ---------------------------------------------------------------- 6. sanitize and save evidence
$Pairs = @(
  ,@($RepoRoot, '<REPO>')
  ,@($ZkeyDir, '<ZKEY_DIR>')
  ,@($HOME, '<HOME>')
)
# bare user/host names are not replaced: a short name could corrupt the test names that --pass-evidence matches;
# every absolute path that carries them starts with one of the three prefixes above
$TapText = ''
if (Test-Path -LiteralPath $RawOut) { $TapText = [IO.File]::ReadAllText($RawOut) }
$ErrText = ''
if (Test-Path -LiteralPath $RawErr) { $ErrText = [IO.File]::ReadAllText($RawErr) }
$TapText = ConvertTo-Sanitized $TapText $Pairs
$ErrText = ConvertTo-Sanitized $ErrText $Pairs
Remove-Item -LiteralPath $RawDir -Recurse -Force

$TapFile = Join-Path $OutDir 'R07e_PA03_v1.tap.txt'
$ErrFile = Join-Path $OutDir 'R07e_PA03_v1.stderr.txt'
Write-Utf8 $TapFile $TapText
Write-Utf8 $ErrFile $ErrText

function Get-TapCount([string]$Text, [string]$Key) {
  $m = [regex]::Match($Text, '(?m)^# ' + $Key + ' (\d+)\s*$')
  if ($m.Success) { return [int]$m.Groups[1].Value }
  return -1
}
$Counts = [ordered]@{}
foreach ($k in @('tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo')) { $Counts[$k] = Get-TapCount $TapText $k }
$PerTest = [ordered]@{}
foreach ($n in $TestNames) {
  $okLine = [regex]::Match($TapText, '(?m)^\s*ok \d+ - ' + [regex]::Escape($n) + '\s*$')
  $skipLine = [regex]::Match($TapText, '(?m)^\s*ok \d+ - ' + [regex]::Escape($n) + '\s*#\s*SKIP')
  $failLine = [regex]::Match($TapText, '(?m)^\s*not ok \d+ - ' + [regex]::Escape($n))
  $state = 'not_found'
  if ($okLine.Success) { $state = 'pass' }
  if ($skipLine.Success) { $state = 'skipped' }
  if ($failLine.Success) { $state = 'fail' }
  $PerTest[$SuiteName + ' > ' + $n] = $state
}
$BothPassed = (-not $TimedOut) -and ($NodeExit -eq 0) -and ($Counts['tests'] -eq 2) -and ($Counts['pass'] -eq 2) -and ($Counts['skipped'] -eq 0) -and ($Counts['fail'] -eq 0)
foreach ($v in $PerTest.Values) { if ($v -ne 'pass') { $BothPassed = $false } }
$LocalResult = 'LOCAL_RUN_FAILED'
if ($BothPassed) { $LocalResult = 'LOCAL_RUN_PASSED' }
if ($TimedOut) { $LocalResult = 'LOCAL_RUN_TIMEOUT' }

$DirtyFiles = @()
if ($GitDirty -ne 'unavailable' -and $GitDirty -ne '') { $DirtyFiles = @($GitDirty -split "`r?`n") }

$Evidence = [ordered]@{
  schema                 = 'otk.h1r2.pa03_v1_author_run.v1'
  repository_status      = 'pending_author_evidence'
  status_note            = 'A local run does not change the repository status; the integrator regenerates expected_outcomes.json with the TAP file as --pass-evidence.'
  local_result           = $LocalResult
  started_utc            = $StartedUtc
  finished_utc           = $FinishedUtc
  commit_sha             = $GitSha
  worktree_tracked_changes = $DirtyFiles
  command                = ('cd tools/hardhat ; ' + $EnvVarName + '=<ZKEY_DIR>/' + (Split-Path -Leaf $ZkeyFull) + ' node ' + ($NodeArgs -join ' '))
  node_exit_code         = $NodeExit
  timed_out              = $TimedOut
  tap_counts             = $Counts
  tests                  = $PerTest
  key = [ordered]@{
    found_via            = $ZkeySource
    file_name            = (Split-Path -Leaf $ZkeyFull)
    bytes                = $ZkeyBytes
    sha256               = $ZkeyHash
    expected_sha256      = $ExpectedSha256
    sha256_matches       = ($ZkeyHash -eq $ExpectedSha256)
    content_saved        = $false
  }
  inputs_sha256 = [ordered]@{
    'tools/hardhat/test/PA03Closeout.test.js'   = $TestHash
    'zk/build/metering_v1_js/metering_v1.wasm'  = $WasmHash
  }
  environment = [ordered]@{
    node                 = $NodeVersion
    npm                  = $NpmVersion
    os                   = [Environment]::OSVersion.VersionString
    is_64bit_os          = [Environment]::Is64BitOperatingSystem
    powershell           = $PSVersionTable.PSVersion.ToString()
    powershell_edition   = [string]$PSVersionTable.PSEdition
    npm_ci_run           = [bool]$NpmCi
    hardhat_compile_run  = [bool]$Compile
  }
  sanitization           = 'absolute repository path -> <REPO>, key directory -> <ZKEY_DIR>, home -> <HOME> (both slash styles and JSON-escaped)'
}
$EvidenceFile = Join-Path $OutDir 'evidence.json'
Write-Utf8 $EvidenceFile ($Evidence | ConvertTo-Json -Depth 6)

$Sums = @()
foreach ($f in @($TapFile, $ErrFile, $EvidenceFile)) {
  $Sums += ((Get-FileHash -LiteralPath $f -Algorithm SHA256).Hash.ToLowerInvariant() + '  ' + (Split-Path -Leaf $f))
}
Write-Utf8 (Join-Path $OutDir 'SHA256SUMS.txt') (($Sums -join "`n") + "`n")

# ---------------------------------------------------------------- 7. report
Write-Host ''
Write-Info ('local result: ' + $LocalResult + '  (node exit ' + $NodeExit + ')')
foreach ($k in $PerTest.Keys) { Write-Info ('  ' + $PerTest[$k] + '  ' + $k) }
Write-Info ('TAP counts: ' + (($Counts.Keys | ForEach-Object { $_ + '=' + $Counts[$_] }) -join ' '))
Write-Info ('evidence saved (sanitized, no key content) in ' + $OutDir)
Write-Info 'repository status stays pending_author_evidence; send evidence.json + R07e_PA03_v1.tap.txt to the integrator'
Write-Info ('integrator: node tools/academic_release/make_expected_outcomes.mjs ... --pass-evidence <R07e_PA03_v1.tap.txt>')
Write-Info 'limits: proves the 2 tests pass on THIS machine at THIS commit with the original key; it is not an independent third-party reproduction.'
if ($BothPassed) { exit 0 }
if ($TimedOut) { exit 6 }
exit 1
