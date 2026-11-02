#!/bin/bash
# Mac: 더블클릭하면 RoomFinder 를 실행합니다.
cd "$(dirname "$0")" || exit 1

if ! command -v node > /dev/null 2>&1; then
  echo ""
  echo "  Node.js 가 설치되어 있지 않습니다. 설치 페이지를 엽니다."
  echo "  LTS 버전을 설치한 뒤 이 파일을 다시 더블클릭하세요."
  open "https://nodejs.org/ko/download"
  read -n 1 -s -r -p "  아무 키나 누르면 닫힙니다."
  exit 1
fi

node server/index.js "$@"
echo ""
read -n 1 -s -r -p "RoomFinder 가 종료되었습니다. 아무 키나 누르면 창이 닫힙니다."
