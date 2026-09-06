[CmdletBinding()]
param(
    [string]$LiveTimeAddress = "127.0.0.1",
    [int]$LiveTimePort = 54235,
    [string]$RaceVisionRoot = "",
    [string]$CaptureRoot = "",
    [switch]$ValidateOnly
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

trap {
    Write-Host ""
    Write-Host ("ERROR: " + $_.Exception.Message) -ForegroundColor Red
    exit 1
}

function Resolve-RaceVisionRoot {
    param([string]$RequestedRoot)

    $candidates = [System.Collections.Generic.List[string]]::new()
    if (-not [string]::IsNullOrWhiteSpace($RequestedRoot)) {
        $candidates.Add($RequestedRoot)
    }
    if (-not [string]::IsNullOrWhiteSpace($env:RACEVISION_UTILITY_ROOT)) {
        $candidates.Add($env:RACEVISION_UTILITY_ROOT)
    }
    $candidates.Add((Join-Path $env:USERPROFILE "OneDrive\Documents\GitHub\RaceVision.Utility"))
    $candidates.Add((Join-Path $env:USERPROFILE "Documents\GitHub\RaceVision.Utility"))

    foreach ($candidate in $candidates) {
        $project = Join-Path $candidate "RaceVision.AdapterHost.Console\RaceVision.AdapterHost.Console.csproj"
        if (Test-Path -LiteralPath $project -PathType Leaf) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }

    throw "RaceVision.Utility was not found. Clone it first or set RACEVISION_UTILITY_ROOT."
}

function Test-TcpPort {
    param([string]$Address, [int]$Port, [int]$TimeoutMilliseconds = 900)

    $client = [System.Net.Sockets.TcpClient]::new()
    try {
        $connect = $client.ConnectAsync($Address, $Port)
        return $connect.Wait($TimeoutMilliseconds) -and $client.Connected
    }
    catch {
        return $false
    }
    finally {
        $client.Dispose()
    }
}

function Read-SecretText {
    param([string]$Prompt)

    $secureValue = Read-Host $Prompt -AsSecureString
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureValue)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
        $secureValue.Dispose()
    }
}

function Remove-SafeRuntimeDirectory {
    param([string]$RuntimeDirectory, [string]$RuntimeBase)

    if ([string]::IsNullOrWhiteSpace($RuntimeDirectory) -or -not (Test-Path -LiteralPath $RuntimeDirectory)) {
        return
    }
    $basePath = [IO.Path]::GetFullPath($RuntimeBase).TrimEnd([IO.Path]::DirectorySeparatorChar)
    $targetPath = [IO.Path]::GetFullPath($RuntimeDirectory)
    $requiredPrefix = $basePath + [IO.Path]::DirectorySeparatorChar
    if (-not $targetPath.StartsWith($requiredPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove unexpected runtime directory: $targetPath"
    }
    Remove-Item -LiteralPath $targetPath -Recurse -Force
}

$resolvedRaceVisionRoot = Resolve-RaceVisionRoot -RequestedRoot $RaceVisionRoot
$projectPath = Join-Path $resolvedRaceVisionRoot "RaceVision.AdapterHost.Console\RaceVision.AdapterHost.Console.csproj"
$commit = (& git -C $resolvedRaceVisionRoot rev-parse --verify HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $commit -notmatch '^[0-9a-fA-F]{40}$') {
    throw "Could not determine the RaceVision.Utility commit."
}

$localRuntimeBase = Join-Path $env:LOCALAPPDATA "RaceVision.Utility\capture-runtime"
$publishDirectory = Join-Path $env:LOCALAPPDATA ("RaceVision.Utility\published\" + $commit.Substring(0, 12))
$captureBase = if ([string]::IsNullOrWhiteSpace($CaptureRoot)) {
    Join-Path $env:LOCALAPPDATA "RaceVision.Utility\captures"
} else {
    $CaptureRoot
}

New-Item -ItemType Directory -Path $publishDirectory -Force | Out-Null
$hostDll = Join-Path $publishDirectory "RaceVision.AdapterHost.Console.dll"
if (-not (Test-Path -LiteralPath $hostDll -PathType Leaf)) {
    Write-Host "Building RaceVision.Utility $($commit.Substring(0, 7))..." -ForegroundColor Cyan
    & dotnet publish $projectPath --configuration Release --output $publishDirectory
    if ($LASTEXITCODE -ne 0) {
        throw "RaceVision.Utility build failed."
    }
}

if ($ValidateOnly) {
    Write-Host "RaceVision capture setup is ready." -ForegroundColor Green
    Write-Host "Source:  $resolvedRaceVisionRoot"
    Write-Host "Commit:  $commit"
    Write-Host "Runtime: $hostDll"
    Write-Host "Target:  $LiveTimeAddress`:$LiveTimePort"
    exit 0
}

if (-not (Test-TcpPort -Address $LiveTimeAddress -Port $LiveTimePort)) {
    throw "LiveTime is not listening at $LiveTimeAddress`:$LiveTimePort. Start LiveTime, enable its RaceVision interface, and run this launcher again."
}

$plainKey = Read-SecretText -Prompt "LiveTime key"
if ([string]::IsNullOrWhiteSpace($plainKey)) {
    throw "The LiveTime key cannot be empty."
}
$keyByteCount = [Text.Encoding]::UTF8.GetByteCount($plainKey)
if ($keyByteCount -notin @(16, 24, 32)) {
    Remove-Variable plainKey -ErrorAction SilentlyContinue
    throw "The LiveTime key must contain 16, 24, or 32 UTF-8 bytes for the RaceVision AES transport."
}

$captureStamp = Get-Date -Format "yyyy-MM-dd_HH-mm-ss"
$captureDirectory = Join-Path $captureBase $captureStamp
$dataDirectory = Join-Path $captureDirectory "data"
$runtimeDirectory = Join-Path $localRuntimeBase ([Guid]::NewGuid().ToString("N"))
$logPath = Join-Path $captureDirectory "racevision-console.log"
$manifestPath = Join-Path $captureDirectory "capture-manifest.json"

New-Item -ItemType Directory -Path $dataDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null

$configPath = Join-Path $runtimeDirectory "config.json"
$config = [ordered]@{
    Key = $plainKey
    ConnectionIPAddress = $LiveTimeAddress
    AutoReconnect = $true
    LogLevel = "Info"
    WriteToConsole = $true
    HostJsonWrtite = $true
    OutputDirectory = $dataDirectory
    FormatJsonOutput = $true
    HostRaceInfoWebSocket = $false
    HostPoint = "http://127.0.0.1:8080/ws/"
    HostOBSControl = $false
    OBSUrl = "ws://127.0.0.1:4455"
    OBSPassword = ""
}

$manifest = [ordered]@{
    format = "org.fpv.racevision-capture"
    version = 1
    startedAt = (Get-Date).ToUniversalTime().ToString("o")
    liveTimeAddress = $LiveTimeAddress
    liveTimePort = $LiveTimePort
    raceVisionCommit = $commit
    dataDirectory = "data"
    consoleLog = "racevision-console.log"
    containsPotentialPersonalData = $true
    containsKey = $false
    finishedAt = $null
    exitCode = $null
    jsonFiles = @()
}

try {
    $config | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $configPath -Encoding UTF8
    $manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
    Remove-Variable plainKey -ErrorAction SilentlyContinue

    Write-Host ""
    Write-Host "Capture started." -ForegroundColor Green
    Write-Host "Output: $captureDirectory"
    Write-Host "Type quit and press Enter to finish cleanly." -ForegroundColor Yellow
    Write-Host "The capture can contain pilot names and race data; review it before sharing." -ForegroundColor Yellow
    Write-Host ""

    Push-Location $runtimeDirectory
    try {
        & dotnet $hostDll 2>&1 | Tee-Object -LiteralPath $logPath -Append
        $processExitCode = $LASTEXITCODE
    }
    finally {
        Pop-Location
    }

    $manifest.finishedAt = (Get-Date).ToUniversalTime().ToString("o")
    $manifest.exitCode = $processExitCode
    $manifest.jsonFiles = @(
        Get-ChildItem -LiteralPath $dataDirectory -Filter "*.json" -File -ErrorAction SilentlyContinue |
            Sort-Object Name |
            ForEach-Object { [ordered]@{ name = $_.Name; bytes = $_.Length } }
    )
    $manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
    Write-Host "Capture finished: $captureDirectory" -ForegroundColor Green
}
finally {
    Remove-Variable plainKey -ErrorAction SilentlyContinue
    Remove-SafeRuntimeDirectory -RuntimeDirectory $runtimeDirectory -RuntimeBase $localRuntimeBase
}
