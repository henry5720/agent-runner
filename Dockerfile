# sandbox image。tag 由 runner 算：sandcastle-teamsync:<hash(Dockerfile + 目標 repo 的 .nvmrc)>
# build-arg：NODE_VERSION（讀 .nvmrc）、AGENT_UID／AGENT_GID（host user，sandcastle 會比對 UID）
ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-bookworm

ENV TZ=Asia/Taipei \
    CI=1 \
    NODE_OPTIONS=--max-old-space-size=4096 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# root 階段：系統套件、Python 3.11（bookworm 內建）＋ ortools、Chromium 系統依賴、corepack
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl jq ca-certificates tzdata python3 python3-pip \
  && rm -rf /var/lib/apt/lists/*
RUN pip3 install --no-cache-dir --break-system-packages ortools==9.15.6755
RUN npx -y playwright install-deps chromium && rm -rf /var/lib/apt/lists/*
RUN corepack enable

# 把 base image 的 node user 改名成 agent，UID/GID 對齊 host
ARG AGENT_UID=1000
ARG AGENT_GID=1000
RUN groupmod -o -g $AGENT_GID node \
  && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node
USER ${AGENT_UID}:${AGENT_GID}

# mount 目標的父目錄要以 agent 身分先建，不然 docker 會建成 root 擁有
RUN mkdir -p /home/agent/.claude/skills /home/agent/.local/share/pnpm/store

# Claude CLI 不釘版本；更新用 `agent-runner rebuild`
RUN curl -fsSL https://claude.ai/install.sh | bash
ENV PATH="/home/agent/.local/bin:$PATH"

WORKDIR /home/agent
# sandcastle 用 docker exec 跑指令，container 本身要常駐
ENTRYPOINT ["sleep", "infinity"]
