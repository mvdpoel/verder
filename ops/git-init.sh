#!/usr/bin/env bash
# Attach the full verder git repo to a working tree that Syncthing synced
# without its .git (~/Workspace/.stignore excludes .git, node_modules, .next).
#
#   ops/git-init.sh [branch]      # branch to check out, default main
#
# Every branch on origin becomes a local branch tracking it, and all tags are
# fetched. The synced files are NEVER touched: HEAD is pointed at the branch
# and only the index is reset, so a file that differs from the branch shows
# up as modified instead of being overwritten. Run it again any time: on an
# existing repo it only fetches and adds the branches that are new on origin.
set -euo pipefail

REMOTE_URL="${VERDER_REMOTE:-git@github.com:mvdpoel/verder.git}"
BRANCH="${1:-main}"
cd "$(dirname "$0")/.."

say() { printf 'git-init.sh: %s\n' "$*"; }

fresh=0
if [ ! -d .git ]; then
  [ -f package.json ] && [ -f CLAUDE.md ] || { say "not the verder root: $PWD"; exit 1; }
  git init -q -b "$BRANCH"
  git remote add origin "$REMOTE_URL"
  fresh=1
  say "initialised $PWD"
else
  url=$(git remote get-url origin 2>/dev/null || true)
  [ "$url" = "$REMOTE_URL" ] || { say "origin is '$url', expected $REMOTE_URL; refusing"; exit 1; }
fi

git fetch -q --prune --tags origin

# One local branch per remote branch. update-ref + config instead of
# `git branch`/`checkout`, so nothing here can write to the working tree.
added=()
while read -r ref; do
  b=${ref#refs/remotes/origin/}
  [ "$b" = HEAD ] && continue
  if ! git show-ref -q --verify "refs/heads/$b"; then
    git update-ref "refs/heads/$b" "$ref"
    added+=("$b")
  fi
  if [ -z "$(git config "branch.$b.remote" || true)" ]; then
    git config "branch.$b.remote" origin
    git config "branch.$b.merge" "refs/heads/$b"
  fi
done < <(git for-each-ref --format='%(refname)' refs/remotes/origin)
git remote set-head origin --auto >/dev/null 2>&1 || true

# Claude Code's local state, excluded per clone on the original Mac too.
for pat in /.claude/RESUME.md '**/.claude/scheduled_tasks.lock' '**/.claude/scheduled_tasks.json' \
    '**/.claude/routines/.state/' '**/.claude/worktrees/' '**/.claude/checkpoints/' \
    '**/.claude/mailbox/' '**/.claude/agent-registry.json' '**/.claude/agent-memory-local' \
    '**/.claude/first-run' '**/.claude/assistant-daemon-state.json'; do
  grep -qxF -- "$pat" .git/info/exclude 2>/dev/null || printf '%s\n' "$pat" >> .git/info/exclude
done
[ ${#added[@]} -gt 0 ] && say "local branches added: ${added[*]}"

if [ "$fresh" = 1 ]; then
  git show-ref -q --verify "refs/heads/$BRANCH" || { say "no branch '$BRANCH' on origin"; exit 1; }
  git symbolic-ref HEAD "refs/heads/$BRANCH"
  git reset -q   # index := HEAD; the working tree stays exactly as synced
  say "on $BRANCH at $(git log --oneline -1)"
else
  say "existing repo left on $(git rev-parse --abbrev-ref HEAD); fetched only"
fi

modified=$(git status --porcelain | grep -c '^ M\|^ D\|^MM' || true)
untracked=$(git status --porcelain | grep -c '^??' || true)
say "$modified modified, $untracked untracked"
if [ "$modified" -gt 0 ]; then
  say "modified files differ from $BRANCH: uncommitted work from the other Mac, or the wrong branch."
  say "inspect with: git status && git diff --stat"
fi
