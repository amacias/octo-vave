@echo off
rem Starts the FM-1 Dashboard and opens it in the default browser (use Chrome or Edge).
cd /d "%~dp0"
python server.py %*
