@echo off
rem Stops Kafka and Garnet (see stop-infra.ps1).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-infra.ps1"
