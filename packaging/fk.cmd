@echo off
rem FlintKeep CLI launcher for the installed app.
rem Runs resources/app/build/fk.mjs with the bundled Electron in Node mode, so the
rem target machine does not need Node.js or tsx.
setlocal
set "ELECTRON_RUN_AS_NODE=1"
if not defined VAULT_DATA_DIR set "VAULT_DATA_DIR=%APPDATA%\FlintKeep\data"
if not defined FK_APP_ROOT set "FK_APP_ROOT=%~dp0resources\app"
if not defined FK_PACKAGED set "FK_PACKAGED=1"
"%~dp0FlintKeep.exe" "%~dp0resources\app\build\fk.mjs" %*
exit /b %ERRORLEVEL%
