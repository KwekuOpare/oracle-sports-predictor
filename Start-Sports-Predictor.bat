@echo off
title Oracle Sports Predictor
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies...
  call npm install --no-audit --no-fund
)
echo Starting Oracle Sports Predictor at http://localhost:3456
start "" http://localhost:3456
node server/index.js
pause
