:; # Causoryn CLI launcher (F20). POSIX sh runs the ":;" lines, which cmd.exe skips as labels; cmd.exe runs the rest. #
:; # It starts causoryn.mjs (next to this file) with the absolute node npm runs (npm_node_execpath), not a node found on PATH. #
:; # sh: builtins only; node resolves this file's real path from $0 (npm links the bin). No node option but -e: worker threads inherit them. #
:; n=node; case "${npm_node_execpath-}" in /*) if [ -f "$npm_node_execpath" ] && [ -x "$npm_node_execpath" ]; then n=$npm_node_execpath; fi;; esac #
:; exec "$n" -e 'const r=typeof require=="function"?require:process.getBuiltinModule,p=r("node:path"),f=r("node:fs"),c=p.join(p.dirname(f.realpathSync(process.argv[1])),"causoryn.mjs");process.argv.splice(1,1,c);import(r("node:url").pathToFileURL(c).href)' -- "$0" "$@" #
@echo off
rem Windows: node is npm's own (npm_node_execpath) or else node.exe from PATH, never from the current directory.
rem The arguments are never parsed again: cmd-shim's shim is the cmd.exe level npm escapes them for, and this
rem file never puts them on a command line. It echoes them unparsed (REM lines in FOR bodies) into two files,
rem with the console in UTF-8, and node takes them from there (lib\windows-argv.mjs). No node option is
rem passed: worker threads would inherit it.
setlocal DisableDelayedExpansion
rem First the captures below with output discarded: if cmd.exe cannot parse them, the batch stops here,
rem before anything is created or the console code page is changed.
(
  echo on
  for %%# in (1) do rem CAUSORYN-ARGV: %*:CAUSORYN-ARGV
  @echo off
) >nul
(
  echo on
  for %%] in (1) do rem CAUSORYN-ARGV: %*:CAUSORYN-ARGV
  @echo off
) >nul
set "CAUSORYN_NODE="
rem The leading "-" keeps the variable defined, so the substrings below also expand when npm did not set it.
set "CAUSORYN_NPM_NODE=-%npm_node_execpath%"
if "%CAUSORYN_NPM_NODE:~2,2%"==":\" if exist "%CAUSORYN_NPM_NODE:~1%" set "CAUSORYN_NODE=%CAUSORYN_NPM_NODE:~1%"
if "%CAUSORYN_NPM_NODE:~1,2%"=="\\" if exist "%CAUSORYN_NPM_NODE:~1%" set "CAUSORYN_NODE=%CAUSORYN_NPM_NODE:~1%"
rem %%~$PATH: searches the PATH directories only.
if not defined CAUSORYN_NODE for %%I in (node.exe) do set "CAUSORYN_NODE=%%~$PATH:I"
if not defined CAUSORYN_NODE (
  echo causoryn: node.exe was not found on PATH. 1>&2
  exit /b 9009
)
set "CAUSORYN_TMP=%TEMP%"
if not defined CAUSORYN_TMP set "CAUSORYN_TMP=%TMP%"
if not defined CAUSORYN_TMP if defined LOCALAPPDATA set "CAUSORYN_TMP=%LOCALAPPDATA%\Temp"
set "CAUSORYN_ARGV_DIR="
set "CAUSORYN_ARGV_ID=%RANDOM%%RANDOM%%RANDOM%"
if defined CAUSORYN_TMP for /l %%i in (1,1,32) do if not defined CAUSORYN_ARGV_DIR mkdir "%CAUSORYN_TMP%\causoryn-argv-%CAUSORYN_ARGV_ID%-%%i" 2>nul && set "CAUSORYN_ARGV_DIR=%CAUSORYN_TMP%\causoryn-argv-%CAUSORYN_ARGV_ID%-%%i"
if not defined CAUSORYN_ARGV_DIR (
  echo causoryn: refusing to start: could not create a temporary directory for the arguments. 1>&2
  exit /b 2
)
rem The console code page, restored after the capture. chcp prints it last, in some languages followed by ".".
set "CAUSORYN_CHCP=%SystemRoot%\System32\chcp.com"
set "CAUSORYN_CP_LINE="
set "CAUSORYN_CP="
for /f "tokens=*" %%c in ('"%SystemRoot%\System32\chcp.com"') do set "CAUSORYN_CP_LINE=%%c"
if defined CAUSORYN_CP_LINE for %%t in (%CAUSORYN_CP_LINE%) do set "CAUSORYN_CP=%%t"
if defined CAUSORYN_CP set "CAUSORYN_CP=%CAUSORYN_CP:.=%"
if defined CAUSORYN_CP for /f "delims=0123456789" %%x in ("%CAUSORYN_CP%") do set "CAUSORYN_CP="
if not defined CAUSORYN_CP (
  echo causoryn: refusing to start: could not read the console code page. 1>&2
  rd /s /q "%CAUSORYN_ARGV_DIR%" 2>nul
  exit /b 2
)
set "prompt=#"
if not "%CAUSORYN_CP%"=="65001" "%CAUSORYN_CHCP%" 65001 >nul || (
  echo causoryn: refusing to start: could not switch the console to UTF-8. 1>&2
  rd /s /q "%CAUSORYN_ARGV_DIR%" 2>nul
  exit /b 2
)
(
  echo on
  for %%# in (1) do rem CAUSORYN-ARGV: %*:CAUSORYN-ARGV
  @echo off
) >"%CAUSORYN_ARGV_DIR%\argv-hash.txt"
(
  echo on
  for %%] in (1) do rem CAUSORYN-ARGV: %*:CAUSORYN-ARGV
  @echo off
) >"%CAUSORYN_ARGV_DIR%\argv-bracket.txt"
if not "%CAUSORYN_CP%"=="65001" "%CAUSORYN_CHCP%" %CAUSORYN_CP% >nul
endlocal & goto #_undefined_# 2>nul || title %COMSPEC% & "%CAUSORYN_NODE%" "%~dp0lib\windows-argv.mjs" --launch "%CAUSORYN_ARGV_DIR%"
