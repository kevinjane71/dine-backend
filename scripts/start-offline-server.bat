@echo off
REM ─────────────────────────────────────────────────────────────────────────
REM  DineOpen — ONE-CLICK offline server for Windows.
REM  Double-click this file on the machine that should be the restaurant server.
REM  It runs a self-contained PostgreSQL + the real dine-backend. Other terminals
REM  point at  http://<this-pc-ip>:3003.
REM ─────────────────────────────────────────────────────────────────────────
setlocal
cd /d "%~dp0.."

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Install the LTS from https://nodejs.org and re-run.
  pause & exit /b 1
)

if not exist node_modules (
  echo Installing dependencies ^(one-time^)...
  call npm ci --omit=dev
)

node -e "require('embedded-postgres')" 2>nul
if errorlevel 1 (
  echo Installing embedded PostgreSQL ^(one-time download^)...
  call npm i embedded-postgres
)

if not exist .env.local (
  echo NOTE: no .env.local found. Copy .env.offline.example to .env.local and set JWT_SECRET.
)

echo Starting DineOpen local server...
node scripts\start-embedded-server.js
pause
