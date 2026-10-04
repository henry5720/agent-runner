import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { claudeCode, Output, run } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import type { Config } from "./config.js";
import type { Sandbox } from "./ports.js";
import { implementResultSchema } from "./result.js";

const exec = promisify(execFile);

const RUNNER_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DOCKERFILE = fileURLToPath(new URL("../Dockerfile", import.meta.url));
// sandcastle 的 promptFile 對 process.cwd() 解析，一定給絕對路徑
const IMPLEMENT_PROMPT = fileURLToPath(new URL("../prompts/implement.md", import.meta.url));

/** 同一個 hook 點的多個 command 會平行跑，所以 install 和 chromium 串成一條。 */
const SETUP_COMMAND = "cd frontend && timeout 300 pnpm install --frozen-lockfile && pnpm exec playwright install chromium";

/**
 * 包住 sandcastle + docker。sandcastle 沒有 export 假 agent，這層不做自動測試，
 * 整合驗證見 docs/verification.md 與真機實測。
 */
export function createSandbox(config: Config, secrets: { CLAUDE_CODE_OAUTH_TOKEN: string }): Sandbox {
  return {
    async dockerfile() {
      return readFile(DOCKERFILE, "utf8");
    },

    async imageExists(tag) {
      try {
        await exec("docker", ["image", "inspect", tag]);
        return true;
      } catch {
        return false;
      }
    },

    async buildImage({ tag, nodeVersion }) {
      // sandcastle 的 buildImage 沒 export、CLI 帶不了 NODE_VERSION → 自己跑 docker build
      const uid = String(process.getuid?.() ?? 1000);
      const gid = String(process.getgid?.() ?? 1000);
      await exec(
        "docker",
        ["build", "-t", tag, "--build-arg", `NODE_VERSION=${nodeVersion}`, "--build-arg", `AGENT_UID=${uid}`, "--build-arg", `AGENT_GID=${gid}`, "-f", DOCKERFILE, RUNNER_ROOT],
        { maxBuffer: 256 * 1024 * 1024 },
      );
    },

    async implement({ imageTag, issue, branch, baseRef, signal }) {
      const mounts = [
        { hostPath: config.pnpmStorePath, sandboxPath: "~/.local/share/pnpm/store" },
        { hostPath: config.tddSkillPath, sandboxPath: "~/.claude/skills/tdd", readonly: true },
        // hostPath 不存在時 docker() 會同步 throw，所以有檔才掛
        ...(existsSync(config.repoEnvPath) ? [{ hostPath: config.repoEnvPath, sandboxPath: "frontend/.env.local", readonly: true }] : []),
      ];

      const result = await run({
        name: `agent-${issue.number}`,
        // sandbox 裡唯一的 secret；沒有 GH_TOKEN，push 和開 PR 在 host 做
        agent: claudeCode(config.model, { env: { CLAUDE_CODE_OAUTH_TOKEN: secrets.CLAUDE_CODE_OAUTH_TOKEN } }),
        sandbox: docker({ imageName: imageTag, cpus: 4, mounts }),
        cwd: config.botClonePath,
        branchStrategy: { type: "branch", branch, baseBranch: baseRef },
        promptFile: IMPLEMENT_PROMPT,
        promptArgs: { ISSUE_NUMBER: issue.number, ISSUE_TITLE: issue.title, ISSUE_BODY: issue.body },
        maxIterations: 1,
        output: Output.object({ tag: "result", schema: implementResultSchema }),
        signal,
        // stream-json 在長的 Bash 期間不吐行；真正的上限交給 signal
        idleTimeoutSeconds: 1800,
        hooks: { sandbox: { onSandboxReady: [{ command: SETUP_COMMAND, timeoutMs: 600_000 }] } },
      });
      return result.output;
    },
  };
}
