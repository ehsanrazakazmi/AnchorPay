# Stops Kafka and Garnet. Replaces kafka-server-stop.bat, which relies on wmic (removed from Windows 11).
# Like that script, this terminates the process; Kafka recovers its logs automatically on next start.
$kafka = Get-CimInstance Win32_Process -Filter "Name='java.exe'" | Where-Object { $_.CommandLine -match 'kafka\.Kafka' }
foreach ($p in $kafka) { Stop-Process -Id $p.ProcessId -Force; Write-Host "Stopped Kafka (PID $($p.ProcessId))" }
if (-not $kafka) { Write-Host 'Kafka was not running' }

$garnet = Get-Process -Name garnet-server -ErrorAction SilentlyContinue
foreach ($p in $garnet) { Stop-Process -Id $p.Id -Force; Write-Host "Stopped Garnet (PID $($p.Id))" }
if (-not $garnet) { Write-Host 'Garnet was not running' }
