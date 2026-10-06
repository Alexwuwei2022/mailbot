@echo off
rem ============================================================================
rem  Mailbot launcher (Windows)
rem
rem  IMPORTANT - keep this file:
rem    1) ASCII only  (no Chinese characters)
rem    2) CRLF line endings
rem    3) no "chcp 65001"
rem  cmd.exe mis-parses a batch file that combines UTF-8 text with chcp 65001:
rem  its file-position accounting drifts after every multi-byte character, so
rem  later lines get executed from the wrong offset and lose their leading
rem  characters ("call" becomes "all", "echo" disappears, ...). That produced a
rem  flood of "'xxx' is not recognized as an internal or external command".
rem
rem  Therefore the friendly checks and Chinese messages live in Node instead:
rem      node cli.js start
rem ============================================================================

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto :no_node

node cli.js start %*
if errorlevel 1 pause
exit /b %errorlevel%

:no_node
echo.
echo   [ERROR] Node.js was not found on this computer.
echo.
echo   Please install Node.js 20 or newer:
echo       https://nodejs.org/en/download
echo   Keep the default options while installing (PATH is added automatically),
echo   then double-click this file again.
echo.
pause
exit /b 1
