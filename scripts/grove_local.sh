#!/bin/sh
# 실사용 설치의 관리 명령. 데몬·UI를 교체하지 않고 CLI만 독립적으로 갱신할 수 있다.
set -eu
root="$HOME/.local/share/grove-opus"
export GROVE_DATA_DIR="${GROVE_DATA_DIR:-$root/data}"
export GROVE_LISTEN="${GROVE_LISTEN:-127.0.0.1:49120}"
if [ "${1:-}" = pairing ]; then
    exec "$root/cli/grove" "$@"
fi
IFS= read -r release < "$root/current"
case "$release" in
    ""|*[!a-zA-Z0-9._-]*|.|..) printf '%s\n' '설치 release 식별자 오류' >&2; exit 1 ;;
esac
case "${1:-}" in
    --help|-h|help)
        "$root/releases/$release/grove" "$@"
        printf '\n%s\n' '승인형 페어링 관리: grove pairing --help'
        ;;
    *) exec "$root/releases/$release/grove" "$@" ;;
esac
