@echo off
chcp 65001 > nul
title RoomFinder
cd /d "%~dp0"

rem ---- Node.js 설치 확인 ----
where node > nul 2> nul
if errorlevel 1 goto NO_NODE

node -e "process.exit(Number(process.versions.node.split('.')[0]) < 20 ? 1 : 0)"
if errorlevel 1 goto OLD_NODE

rem ---- 처음 한 번: AI 검색용 패키지 설치 ----
if not exist "node_modules\@anthropic-ai\sdk" (
  echo 처음 실행이라 필요한 파일을 설치합니다. 잠시만 기다려 주세요...
  call npm install --no-audit --no-fund
)

rem ---- 실행: 조건을 묻고, 브라우저를 자동으로 엽니다 ----
node server\index.js %*
echo.
echo RoomFinder 가 종료되었습니다. 아무 키나 누르면 창이 닫힙니다.
pause > nul
exit /b

:NO_NODE
echo.
echo  Node.js 가 설치되어 있지 않습니다.
echo  잠시 후 설치 페이지가 열립니다. LTS 버전을 설치한 뒤
echo  이 파일을 다시 더블클릭하세요.
echo.
start "" "https://nodejs.org/ko/download"
pause
exit /b

:OLD_NODE
echo.
echo  Node.js 버전이 너무 오래되었습니다. 20 이상이 필요합니다.
echo  설치 페이지에서 LTS 버전을 새로 설치한 뒤 다시 실행하세요.
echo.
start "" "https://nodejs.org/ko/download"
pause
exit /b
