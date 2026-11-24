#!/bin/sh
# Git has accepted the push and updated the local tracking ref. Fetch and dry-run never publish.
set -eu
[ "$1" = committed ] && [ -z "${GROVE_RELEASE_PUSH_INTERNAL:-}" ] && [ -z "${GROVE_PUSH_ONLY:-}" ] || exit 0
intent=$(git rev-parse --absolute-git-dir)/grove-release-main.$PPID.intent
[ -f "$intent" ] || exit 0
birth=$(awk '{print $22}' "/proc/$PPID/stat")
while read -r old new ref; do
    [ "$ref" = refs/remotes/origin/main ] && [ "$old" != "$new" ] || continue
    [ "$(cat "$intent")" = "$PPID $birth $new" ] || continue
    [ "$(git reflog show -1 --format='%H %gs' "$ref")" = "$new update by push" ] || continue
    [ "$(git symbolic-ref -q HEAD)" = refs/heads/main ] && [ "$(git rev-parse HEAD)" = "$new" ] || continue
    rm -f -- "$intent"
    # 이 기능이 아직 없는 이전 checkout에서 다른 개발 작업을 대신 게시하지 않는다.
    git cat-file -e "$new:scripts/push_release.py" 2>/dev/null || continue
    if ! git diff --quiet "$new" -- scripts/push_release.py scripts/build.py scripts/deploy_local.py scripts/debian.py; then
        echo '배포 스크립트가 푸시한 커밋과 다릅니다. 변경을 정리한 뒤 릴리즈를 재개하세요.' >&2
        exit 1
    fi
    root=$(git rev-parse --show-toplevel)
    if ! python3 "$root/scripts/push_release.py"; then
        echo 'main 푸시는 접수됐지만 릴리즈·로컬 반영이 끝나지 않았습니다. python3 scripts/push_release.py 로 재개하세요.' >&2
        exit 1
    fi
done
