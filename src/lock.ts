import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Lock } from "./ports.js";

const BUSY = 75;

/**
 * `flock -n` 擋重疊的輪次。Node 沒有 flock，所以讓一支子行程拿著鎖：
 * 拿到就印 `locked` 然後 `cat` 等 stdin 結束；release（或 runner 自己死掉、pipe 被關）→ cat 結束 → 鎖放掉。
 */
export function createFlock(path: string): Lock {
  return {
    tryAcquire() {
      mkdirSync(dirname(path), { recursive: true });
      const child = spawn("flock", ["-n", "-E", String(BUSY), path, "sh", "-c", "echo locked; exec cat"], {
        stdio: ["pipe", "pipe", "inherit"],
      });
      const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));

      return new Promise((resolve, reject) => {
        child.once("error", reject);
        child.stdout.once("data", () =>
          resolve(async () => {
            child.stdin.end();
            await exited;
          }),
        );
        void exited.then((code) => {
          if (code === BUSY) resolve(null);
          else reject(new Error(`flock ${path} exited with ${code} before taking the lock`));
        });
      });
    },
  };
}
