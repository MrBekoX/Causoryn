:; # Causoryn CLI launcher (F20). POSIX sh runs the ":;" lines, which cmd.exe skips as labels; cmd.exe runs the rest. #
:; # It starts causoryn.mjs (next to this file) with the absolute node npm runs (npm_node_execpath), not a node found on PATH. #
:; # sh: builtins only; node resolves this file's real path from $0 (npm links the bin). #
:; n=node; case "${npm_node_execpath-}" in /*) if [ -f "$npm_node_execpath" ] && [ -x "$npm_node_execpath" ]; then n=$npm_node_execpath; fi;; esac #
:; exec "$n" --input-type=commonjs -e 'const p=require("node:path"),f=require("node:fs"),c=p.join(p.dirname(f.realpathSync(process.argv[1])),"causoryn.mjs");process.argv.splice(1,1,c);import(require("node:url").pathToFileURL(c).href)' -- "$0" "$@" #
@echo off
rem Windows: no lookup of node or of any command in the current directory or on PATH while npm runs it.
rem The arguments reach this file through one cmd.exe level more than npm escapes them for, so before they
rem are used on a command line they are echoed, unparsed, in a REM line into a file and checked
rem (lib\cmd-argv-check.mjs): an operator outside double quotes stops the start.
setlocal DisableDelayedExpansion
set "CAUSORYN_NODE=node"
rem The leading "-" keeps the variable defined, so the substrings below also expand when npm did not set it.
set "CAUSORYN_NPM_NODE=-%npm_node_execpath%"
if "%CAUSORYN_NPM_NODE:~2,2%"==":\" if exist "%CAUSORYN_NPM_NODE:~1%" set "CAUSORYN_NODE=%CAUSORYN_NPM_NODE:~1%"
if "%CAUSORYN_NPM_NODE:~1,2%"=="\\" if exist "%CAUSORYN_NPM_NODE:~1%" set "CAUSORYN_NODE=%CAUSORYN_NPM_NODE:~1%"
set "CAUSORYN_TMP=%TEMP%"
if not defined CAUSORYN_TMP set "CAUSORYN_TMP=%TMP%"
if not defined CAUSORYN_TMP set "CAUSORYN_TMP=%LOCALAPPDATA%\Temp"
set "CAUSORYN_ARGV_DIR="
set "CAUSORYN_ARGV_ID=%RANDOM%%RANDOM%%RANDOM%"
for /l %%i in (1,1,32) do if not defined CAUSORYN_ARGV_DIR mkdir "%CAUSORYN_TMP%\causoryn-argv-%CAUSORYN_ARGV_ID%-%%i" 2>nul && set "CAUSORYN_ARGV_DIR=%CAUSORYN_TMP%\causoryn-argv-%CAUSORYN_ARGV_ID%-%%i"
if not defined CAUSORYN_ARGV_DIR (
  echo causoryn: refusing to start: could not create a temporary directory to check the arguments. 1>&2
  exit /b 2
)
set "prompt=#"
(
  echo on
  for %%a in (1) do rem CAUSORYN-ARGV:%*:CAUSORYN-ARGV
  @echo off
) >"%CAUSORYN_ARGV_DIR%\argv.txt"
"%CAUSORYN_NODE%" "%~dp0lib\cmd-argv-check.mjs" --check "%CAUSORYN_ARGV_DIR%\argv.txt"
set "CAUSORYN_ARGV_STATUS=%ERRORLEVEL%"
if not exist "%CAUSORYN_ARGV_DIR%\ok" if "%CAUSORYN_ARGV_STATUS%"=="0" set "CAUSORYN_ARGV_STATUS=2"
rd /s /q "%CAUSORYN_ARGV_DIR%" 2>nul
if not "%CAUSORYN_ARGV_STATUS%"=="0" exit /b %CAUSORYN_ARGV_STATUS%
endlocal & goto #_undefined_# 2>nul || title %COMSPEC% & "%CAUSORYN_NODE%" "%~dp0causoryn.mjs" %*
