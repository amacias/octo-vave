@echo off
rem Starts Octo-Vave and opens it in the default browser (use Chrome or Edge).
cd /d "%~dp0"
python server.py %*
