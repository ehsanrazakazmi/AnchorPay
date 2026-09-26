@echo off
rem Starts Redis-compatible Garnet (port 6379) and Kafka (port 9092) for AnchorPay dev.
rem Each opens in its own minimized window. Close with stop-infra.cmd.
rem Kafka is launched with java directly (wildcard classpath) instead of kafka-server-start.bat:
rem that script builds a classpath longer than the Windows command-line limit for longer install
rem paths, and it calls wmic, which Windows 11 no longer ships.
set DEVTOOLS=%~dp0
set KAFKA=%DEVTOOLS%kafka
set KAFKA_FWD=%KAFKA:\=/%
if not exist "%DEVTOOLS%data\kafka-app-logs" mkdir "%DEVTOOLS%data\kafka-app-logs"

start "AnchorPay Garnet (Redis)" /min "%DEVTOOLS%garnet\garnet-server.exe" --port 6379 --bind 127.0.0.1 --memory 256m --index 16m
start "AnchorPay Kafka" /min "%DEVTOOLS%java\bin\java.exe" -Xms256M -Xmx512M -server -XX:+UseG1GC -XX:MaxGCPauseMillis=20 -XX:+ExplicitGCInvokesConcurrent "-Dkafka.logs.dir=%DEVTOOLS%data\kafka-app-logs" "-Dlog4j2.configurationFile=file:/%KAFKA_FWD%/config/log4j2.yaml" -cp "%KAFKA%\libs\*" kafka.Kafka "%KAFKA%\config\anchorpay-server.properties"

echo Garnet (Redis) starting on 127.0.0.1:6379
echo Kafka starting on 127.0.0.1:9092 (takes ~15 seconds)
