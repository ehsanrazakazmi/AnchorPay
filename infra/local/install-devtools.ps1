# Installs the free local infrastructure for AnchorPay into one folder (no admin rights, no system changes):
#   Eclipse Temurin Java 21 JRE (for Kafka), Apache Kafka (KRaft, single node), Microsoft Garnet (Redis protocol).
# Every download is checksum-verified. Re-running is safe: finished steps are skipped.
#
#   powershell -ExecutionPolicy Bypass -File infra\local\install-devtools.ps1 [-Dir C:\Users\<you>\devtools]
#
# Prerequisites: Windows 10/11 x64, .NET SDK 8 or newer (for Garnet), ~500 MB disk. PostgreSQL 18 is installed separately.
param(
  [string]$Dir = (Join-Path $env:USERPROFILE 'devtools'),
  [string]$KafkaVersion = '4.3.1',
  [string]$GarnetVersion = '2.1.8'
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if ($Dir -match '\s') { throw "Kafka's Windows scripts break on paths with spaces. Choose a folder without spaces (got '$Dir')." }

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$downloads = Join-Path $Dir 'downloads'
New-Item -ItemType Directory -Force -Path $downloads | Out-Null

# Runs a native program. Windows PowerShell 5.1 turns anything a program writes to stderr (e.g. `java -version`,
# Kafka's log4j warnings) into a terminating error under ErrorActionPreference=Stop, so relax it for the call
# and fail only on a non-zero exit code.
function Invoke-Native([string]$Exe, [string[]]$Arguments) {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $output = & $Exe @Arguments 2>&1 | ForEach-Object { "$_" } } finally { $ErrorActionPreference = $previous }
  if ($LASTEXITCODE -ne 0) { throw "$Exe failed (exit $LASTEXITCODE): $($output -join [Environment]::NewLine)" }
  return $output
}

function Get-Verified([string]$Url, [string]$OutFile, [string]$Expected, [string]$Algorithm) {
  if (-not (Test-Path $OutFile)) {
    Write-Host "Downloading $Url"
    Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing
  }
  $actual = (Get-FileHash -Path $OutFile -Algorithm $Algorithm).Hash.ToLower()
  if ($actual -ne $Expected.ToLower()) {
    Remove-Item $OutFile -Force
    throw "Checksum mismatch for $OutFile - download deleted, try again."
  }
  Write-Host "  checksum OK ($Algorithm)"
}

# ---------------------------------------------------------------- Java 21 JRE
$javaDir = Join-Path $Dir 'java'
if (-not (Test-Path (Join-Path $javaDir 'bin\java.exe'))) {
  $asset = (Invoke-RestMethod 'https://api.adoptium.net/v3/assets/latest/21/hotspot?architecture=x64&image_type=jre&os=windows&vendor=eclipse') |
    Where-Object { $_.binary.package.name -like '*.zip' } | Select-Object -First 1
  $zip = Join-Path $downloads $asset.binary.package.name
  Get-Verified $asset.binary.package.link $zip $asset.binary.package.checksum 'SHA256'
  Expand-Archive -Path $zip -DestinationPath $Dir -Force
  Get-ChildItem $Dir -Directory -Filter 'jdk-21*' | Select-Object -First 1 | Rename-Item -NewName 'java'
}
Write-Host "Java: $(Invoke-Native (Join-Path $javaDir 'bin\java.exe') @('-version') | Select-Object -First 1)"

# ---------------------------------------------------------------- Kafka
$kafkaDir = Join-Path $Dir 'kafka'
if (-not (Test-Path (Join-Path $kafkaDir 'bin\windows\kafka-server-start.bat'))) {
  $name = "kafka_2.13-$KafkaVersion.tgz"
  $base = "https://downloads.apache.org/kafka/$KafkaVersion"
  $tgz = Join-Path $downloads $name
  $shaText = (Invoke-WebRequest "$base/$name.sha512" -UseBasicParsing).Content
  $expected = (($shaText -replace '^[^:]*:', '') -replace '\s', '')
  Get-Verified "$base/$name" $tgz $expected 'SHA512'
  Invoke-Native 'tar' @('-xzf', $tgz, '-C', $Dir) | Out-Null
  Rename-Item (Join-Path $Dir "kafka_2.13-$KafkaVersion") 'kafka'
}
$devtoolsForward = $Dir -replace '\\', '/'
$config = Join-Path $kafkaDir 'config\anchorpay-server.properties'
(Get-Content (Join-Path $here 'kafka-server.properties') -Raw).Replace('__DEVTOOLS_DIR__', $devtoolsForward) |
  Set-Content -Path $config -Encoding ascii -NoNewline
if (-not (Test-Path (Join-Path $Dir 'data\kafka\meta.properties'))) {
  # Call StorageTool with java directly: kafka-storage.bat builds a classpath that can exceed the
  # Windows command-line limit ("The input line is too long") for longer install paths.
  $log4j = 'file:/' + ((Join-Path $kafkaDir 'config\tools-log4j2.yaml') -replace '\\', '/')
  $tool = @("-Dlog4j2.configurationFile=$log4j", '-cp', (Join-Path $kafkaDir 'libs\*'), 'kafka.tools.StorageTool')
  $java = Join-Path $javaDir 'bin\java.exe'
  $clusterId = (Invoke-Native $java ($tool + @('random-uuid')) | Where-Object { $_ -match '^[A-Za-z0-9_-]{22}$' } | Select-Object -Last 1)
  Invoke-Native $java ($tool + @('format', '--standalone', '-t', $clusterId, '-c', $config)) | Out-Null
  Write-Host "Kafka storage formatted (cluster $clusterId)"
}
Write-Host "Kafka $KafkaVersion ready"

# ---------------------------------------------------------------- Garnet
$garnetExe = Join-Path $Dir 'garnet\garnet-server.exe'
if (-not (Test-Path $garnetExe)) {
  if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) { throw '.NET SDK 8+ is required for Garnet: https://dotnet.microsoft.com/download' }
  Invoke-Native 'dotnet' @('tool', 'install', 'garnet-server', '--version', $GarnetVersion, '--tool-path', (Join-Path $Dir 'garnet')) | Out-Null
}
Write-Host "Garnet $GarnetVersion ready"

# ---------------------------------------------------------------- start/stop scripts
Copy-Item (Join-Path $here 'start-infra.cmd'), (Join-Path $here 'stop-infra.cmd'), (Join-Path $here 'stop-infra.ps1') -Destination $Dir -Force
Write-Host ""
Write-Host "Done. Set DEVTOOLS_DIR=$devtoolsForward in .env, then: npm run infra:start"
