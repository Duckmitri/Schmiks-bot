@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>&1 || (
  echo Node.js 24 or newer is required.
  exit /b 1
)

if not exist "node_modules\discord.js" (
  echo Dependencies are missing. Run: npm ci
  exit /b 1
)

if not exist ".env" (
  echo Missing .env file. Create it with: DISCORD_TOKEN=your_token
  exit /b 1
)

echo Starting Schmiks...
node --env-file=.env bot.js
