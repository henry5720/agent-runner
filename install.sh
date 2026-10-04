#!/usr/bin/env bash
# 裝好（或修好）company-ec2 上的 agent-runner。可以重複跑，第二次不會改到任何東西。
# 不 build image（第一輪開頭會 build）、不打開開關（要做事時手動 `agent-runner on`）。
# 路徑與身分從 src/config.ts 讀（`src/cli.ts install-env`），這裡不另寫一份。
set -euo pipefail

RUNNER_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
UNIT_DIR="$HOME/.config/systemd/user"
BIN_DIR="$HOME/.local/bin"

step() { echo "==> $*"; }

cd "$RUNNER_DIR"
# systemd units 寫死 %h/agents/agent-runner
if [ "$RUNNER_DIR" != "$HOME/agents/agent-runner" ]; then
  echo "注意：runner checkout 在 $RUNNER_DIR，但 systemd units 指向 $HOME/agents/agent-runner" >&2
fi

step "npm ci"
npm ci

REPO='' BOT_CLONE='' GIT_AUTHOR='' PNPM_STORE='' SECRETS_FILE=''
eval "$(node --import tsx src/cli.ts install-env)"

step "bot clone：$BOT_CLONE"
if [ ! -d "$BOT_CLONE/.git" ]; then
  mkdir -p "$(dirname "$BOT_CLONE")"
  git clone "https://github.com/$REPO.git" "$BOT_CLONE"
fi
# sandcastle 的 worktree 與 .env 不進 git status
exclude="$BOT_CLONE/.git/info/exclude"
mkdir -p "$(dirname "$exclude")"
grep -qxF '.sandcastle/' "$exclude" 2>/dev/null || echo '.sandcastle/' >>"$exclude"
# repo 層的 author name；email 沿用操作者的 global 設定
git -C "$BOT_CLONE" config user.name "$GIT_AUTHOR"

step "pnpm store：$PNPM_STORE"
# sandbox mount 的 hostPath 不存在會 throw
mkdir -p "$PNPM_STORE"

step "secret 檔：$SECRETS_FILE"
if [ ! -f "$SECRETS_FILE" ] || [ "$(stat -c %a "$SECRETS_FILE")" != 600 ]; then
  cat >&2 <<MSG
停下：$SECRETS_FILE 不存在或權限不是 600。建好之後再跑一次 install.sh：

  mkdir -p "$(dirname "$SECRETS_FILE")"
  install -m 600 /dev/null "$SECRETS_FILE"   # 已經有檔案就 chmod 600 "$SECRETS_FILE"

裡面放（KEY=VALUE 一行一個）：

  CLAUDE_CODE_OAUTH_TOKEN=          # 操作者跑 \`claude setup-token\` 拿到的
  AGENT_RUNNER_SLACK_WEBHOOK_URL=   # Slack incoming webhook（只有操作者在的 private channel）
MSG
  exit 1
fi

step "systemd units → $UNIT_DIR"
mkdir -p "$UNIT_DIR"
for unit in "$RUNNER_DIR"/systemd/*.service "$RUNNER_DIR"/systemd/*.timer; do
  ln -sfn "$unit" "$UNIT_DIR/$(basename "$unit")"
done
# 輪次間隔與自動關時間從 src/config.ts 寫成 drop-in（內容一樣就不動）
node --import tsx src/cli.ts write-timer-dropins "$UNIT_DIR"
systemctl --user daemon-reload

step "linger：登出之後 timer 照跑"
loginctl enable-linger "$USER"

step "CLI → $BIN_DIR/agent-runner"
mkdir -p "$BIN_DIR"
ln -sfn "$RUNNER_DIR/bin/agent-runner" "$BIN_DIR/agent-runner"

echo
echo "裝好了。開關還是關的：要做事時 agent-runner on，看狀態 agent-runner status。"
