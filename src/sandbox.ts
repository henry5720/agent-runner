import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { claudeCode, Output, run } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Config, SandboxPhase } from "./config.js";
import type { ImplementRequest, MergeRequest, Sandbox } from "./ports.js";
import { promptArgs } from "./promptArgs.js";
import { implementResultSchema, reviewResultSchema } from "./result.js";
import { sandboxMounts, SANDBOX_PNPM_STORE } from "./sandboxMounts.js";

const exec = promisify(execFile);

const RUNNER_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DOCKERFILE = fileURLToPath(new URL("../Dockerfile", import.meta.url));
// sandcastle 的 promptFile 對 process.cwd() 解析，一定給絕對路徑
const IMPLEMENT_PROMPT = fileURLToPath(new URL("../prompts/implement.md", import.meta.url));
const REVIEW_PROMPT = fileURLToPath(new URL("../prompts/review.md", import.meta.url));
const MERGE_PROMPT = fileURLToPath(new URL("../prompts/merge.md", import.meta.url));

/** 同一個 hook 點的多個 command 會平行跑，所以 install 和 chromium 串成一條。 */
const SETUP_COMMAND = "cd frontend && timeout 300 pnpm install --frozen-lockfile && pnpm exec playwright install chromium";

/**
 * runRound 把 message 第一行當原因寫進 issue 留言，所以 setup hook 失敗要寫明是 install。
 * abort（timeout）時 sandcastle 原樣丟 signal.reason，不動它。
 * Effect 內部的錯會被包成 FiberFailure，name 形如 "(FiberFailure) ExecError"，class 沒 export。
 */
function describeFailure(err: unknown): unknown {
  if (!(err instanceof Error)) return err;
  const tag = /\(FiberFailure\) (\w+)/.exec(err.name)?.[1];
  const inSetup = (tag === "ExecError" || tag === "HookTimeoutError") && err.message.includes("pnpm install");
  if (!inSetup) return err;
  // ExecError 的 message 是 "Command failed (exit N): <command>\n<stderr>"，真正的原因在 stderr 最後一行
  const lastLine = err.message.split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";
  const what = tag === "HookTimeoutError" ? "逾時" : "失敗";
  return new Error(`sandbox 準備階段（pnpm install／playwright install）${what}：${lastLine}`, { cause: err });
}

/**
 * 包住 sandcastle + docker。unit tests mock SDK 驗證接線，不啟動 Docker，
 * 整合驗證見 docs/verification.md 與真機實測。
 */
export function createSandbox(config: Config, secrets: { CLAUDE_CODE_OAUTH_TOKEN: string }): Sandbox {
  /** 實作、reviewer、merge run 共用的 run() 參數；只差 prompt、多帶的 prompt 參數、回報的 schema */
  function runAgent<S extends StandardSchemaV1>(
    { imageTag, issue, branch, baseRef, signal }: ImplementRequest,
    promptFile: string,
    schema: S,
    phase: SandboxPhase,
    extra: { args?: Record<string, string> } = {},
  ) {
    const mounts = sandboxMounts(config, phase);

    return run({
      name: `agent-${issue.number}`,
      // sandbox 裡唯一的 secret；沒有 GH_TOKEN，push 和開 PR 在 host 做
      agent: claudeCode(config.model, { env: { CLAUDE_CODE_OAUTH_TOKEN: secrets.CLAUDE_CODE_OAUTH_TOKEN } }),
      sandbox: docker({ imageName: imageTag, cpus: 4, mounts, env: { npm_config_store_dir: SANDBOX_PNPM_STORE } }),
      cwd: config.botClonePath,
      branchStrategy: { type: "branch", branch, baseBranch: baseRef },
      promptFile,
      promptArgs: { ...promptArgs(issue, baseRef), ...extra.args },
      maxIterations: 1,
      output: Output.object({ tag: "result", schema }),
      signal,
      // stream-json 在長的 Bash 期間不吐行；真正的上限交給 signal
      idleTimeoutSeconds: 1800,
      hooks: { sandbox: { onSandboxReady: [{ command: SETUP_COMMAND, timeoutMs: 600_000 }] } },
    }).catch((err: unknown) => {
      throw describeFailure(err);
    });
  }

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

    async buildImage({ tag, nodeVersion, fresh }) {
      // sandcastle 的 buildImage 沒 export、CLI 帶不了 NODE_VERSION → 自己跑 docker build
      const uid = String(process.getuid?.() ?? 1000);
      const gid = String(process.getgid?.() ?? 1000);
      await exec(
        "docker",
        ["build", ...(fresh ? ["--no-cache", "--pull"] : []), "-t", tag, "--build-arg", `NODE_VERSION=${nodeVersion}`, "--build-arg", `AGENT_UID=${uid}`, "--build-arg", `AGENT_GID=${gid}`, "-f", DOCKERFILE, RUNNER_ROOT],
        { maxBuffer: 256 * 1024 * 1024 },
      );
    },

    async implement(req) {
      return (await runAgent(req, IMPLEMENT_PROMPT, implementResultSchema, "implement")).output;
    },

    // 乾淨 context：另一次 run()、不帶 resumeSession；branch 已經存在，sandcastle 直接接著它的 commit 做
    async review(req) {
      return (await runAgent(req, REVIEW_PROMPT, reviewResultSchema, "review")).output;
    },

    // branch 是整合分支 agent/<S>（host 已把本地的重設到 origin/agent/<S>）；agent/<A> 是 bot clone 的本地 branch，worktree 裡直接 merge 得到。
    // 回報沿用 reviewer 的 schema（pass／wip、摘要、重跑的檢查）
    async merge(req: MergeRequest) {
      return (
        await runAgent(req, MERGE_PROMPT, reviewResultSchema, "merge", {
          // 不能用 SOURCE_BRANCH／TARGET_BRANCH：sandcastle 保留給自己（BUILT_IN_PROMPT_ARG_KEYS），傳了會在開 container 前丟錯
          args: { MERGE_SOURCE: req.source, MERGE_TARGET: req.branch },
        })
      ).output;
    },
  };
}
