#!/bin/sh
# Git provides only refs that this invocation intends to send. Pair the intent with its confirmed ref update.
set -eu
[ "$1" = origin ] && [ -z "${GROVE_RELEASE_PUSH_INTERNAL:-}" ] && [ -z "${GROVE_PUSH_ONLY:-}" ] || exit 0
gitdir=$(git rev-parse --absolute-git-dir)
while read -r src head dst previous; do
    [ "$dst" = refs/heads/main ] && [ "$head" != "$previous" ] || continue
    case "$src" in refs/heads/main|HEAD) ;; *) continue ;; esac
    [ "$(git rev-parse refs/heads/main)" = "$head" ] || continue
    # pre-push also runs during --dry-run. The later confirmation must come from this exact Git process.
    if tr '\000' '\n' < "/proc/$PPID/cmdline" | grep -qx -e --dry-run -e -n; then continue; fi
    birth=$(awk '{print $22}' "/proc/$PPID/stat")
    printf '%s %s %s\n' "$PPID" "$birth" "$head" > "$gitdir/grove-release-main.$PPID.intent"
done
