#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# 로컬 변경사항을 GitHub에 자동으로 커밋+push 해주는 스크립트.
#
# 사용법:
#   최초 1회 (원격 저장소를 아직 연결 안 했다면, GitHub 저장소 URL과 함께 실행):
#     ./scripts/push-to-github.sh https://github.com/<내계정>/fishing-map-kr.git
#
#   이후에는 그냥:
#     ./scripts/push-to-github.sh
#
#   커밋 메시지를 직접 쓰고 싶으면:
#     ./scripts/push-to-github.sh "낚시터 목록 검색 기능 추가"
#
#   (URL과 메시지를 한 번에 같이 줘도 됩니다. 순서는 상관없습니다)
#     ./scripts/push-to-github.sh https://github.com/<내계정>/fishing-map-kr.git "최초 업로드"
#
# Windows에서는 Git Bash(또는 WSL) 터미널에서 실행하세요 (cmd.exe/PowerShell에는 bash가 없습니다).
# 최초 1회는 실행 권한을 줘야 할 수 있습니다: chmod +x scripts/push-to-github.sh
# ---------------------------------------------------------------------------
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info() { echo -e "${GREEN}➜${NC} $1"; }
warn() { echo -e "${YELLOW}⚠${NC} $1"; }
fail() { echo -e "${RED}✗${NC} $1"; exit 1; }

command -v git >/dev/null 2>&1 || fail "git이 설치되어 있지 않습니다. https://git-scm.com/downloads 에서 먼저 설치해주세요."

# --- 인자 파싱: http(s):// 또는 git@ 로 시작하면 원격 URL, 아니면 커밋 메시지로 취급 ---
REMOTE_URL=""
COMMIT_MSG=""
for arg in "$@"; do
  if [[ "$arg" == *"://"* || "$arg" == *"@"* || "$arg" == *.git ]]; then
    REMOTE_URL="$arg"
  else
    COMMIT_MSG="$arg"
  fi
done

# --- git 저장소 확인/초기화 ---
if [ ! -d .git ]; then
  info "이 폴더에 git 저장소가 없어서 새로 초기화합니다."
  git init
  git branch -M main
fi

# --- .env가 실수로 커밋될 상황인지 안전 점검 (키가 GitHub에 올라가면 안 되므로) ---
if [ -f .env ] && ! git check-ignore -q .env; then
  fail ".env 파일이 있는데 .gitignore에 의해 무시되지 않고 있습니다! API 키가 그대로 올라갈 수 있으니, .gitignore에 '.env'가 있는지 먼저 확인해주세요. (기본 제공 .gitignore에는 이미 들어있습니다 — 직접 지우신 게 아니라면 이 메세지는 안 뜰 겁니다.)"
fi

# --- 원격 저장소(origin) 연결 ---
if ! git remote get-url origin >/dev/null 2>&1; then
  if [ -z "$REMOTE_URL" ]; then
    fail "원격 저장소(origin)가 아직 연결되어 있지 않습니다. 최초 1회는 GitHub 저장소 URL과 함께 실행해주세요:
  ./scripts/push-to-github.sh https://github.com/<내계정>/fishing-map-kr.git
(저장소가 아직 GitHub에 없다면 github.com에서 먼저 New repository로 만들어주세요.)"
  fi
  info "origin을 $REMOTE_URL 로 연결합니다."
  git remote add origin "$REMOTE_URL"

  # 이 저장소가 (예: git init을 먼저 따로 해서) 아직 'master' 브랜치로 남아있는 경우,
  # GitHub 기본값 및 .github/workflows/deploy.yml의 트리거 브랜치인 'main'으로 맞춰줍니다.
  # (그대로 두면 push는 되지만 GitHub Actions 자동배포가 안 걸립니다.)
  BRANCH_BEFORE_CONNECT="$(git symbolic-ref --short -q HEAD || true)"
  if [ "$BRANCH_BEFORE_CONNECT" = "master" ]; then
    info "브랜치 이름을 GitHub 기본값인 'main'으로 맞춥니다 (master -> main). (자동배포 워크플로가 main을 기준으로 동작합니다)"
    git branch -M main
  fi
elif [ -n "$REMOTE_URL" ]; then
  CURRENT_URL="$(git remote get-url origin)"
  if [ "$CURRENT_URL" != "$REMOTE_URL" ]; then
    warn "origin이 이미 ${CURRENT_URL}로 연결되어 있어서, 새로 주신 URL은 무시합니다. (바꾸려면: git remote set-url origin <새 URL>)"
  fi
fi

# --- 현재 브랜치 확인 (없으면 main으로) ---
CURRENT_BRANCH="$(git symbolic-ref --short -q HEAD || true)"
if [ -z "$CURRENT_BRANCH" ]; then
  git checkout -b main
  CURRENT_BRANCH="main"
fi

# --- 변경사항 스테이징 + 커밋 ---
git add -A

if git diff --cached --quiet; then
  info "커밋할 변경사항이 없습니다 (이미 최신 상태). push만 시도합니다."
else
  MSG="${COMMIT_MSG:-업데이트 $(date '+%Y-%m-%d %H:%M')}"
  git commit -m "$MSG"
  info "커밋 완료: \"$MSG\""
fi

# --- push ---
info "GitHub(origin/${CURRENT_BRANCH})로 push합니다..."
git push -u origin "$CURRENT_BRANCH"

echo
info "완료! GitHub Actions(.github/workflows/deploy.yml)가 설정되어 있다면 잠시 후 Cloud Run에도 자동 배포됩니다."
REMOTE_NOW="$(git remote get-url origin)"
info "저장소: ${REMOTE_NOW%.git}"
