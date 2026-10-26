import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { preparePrEvidence } from "../src/prEvidence.js";

const roots: string[] = [];
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pr-evidence-")); roots.push(root);
  const directory = join(root, "42-run"); await mkdir(directory);
  await writeFile(join(directory, "screen.png"), png);
  const body = `## 瀏覽器驗收\n\n證據：${directory}（runner 主機本機，不在 git）\n\n| 條件 | 結果 | 帳號 | 看到什麼／原因 | 證據 |\n| 畫面 | passed | — | 符合 | screen.png、checks.txt |`;
  return { root, directory, body };
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("PR evidence publication", () => {
  it("embeds referenced images once and keeps non-media files local", async () => {
    const { root, directory, body } = await fixture();
    const result = await preparePrEvidence(body, { directory, files: ["screen.png", "screen.png", "checks.txt", "auth-admin.json"] }, root);
    expect(result.paths).toEqual([join(directory, "screen.png")]);
    expect(result.body).toContain(`![screen.png](<${join(directory, "screen.png")}>)、checks.txt`);
    expect(result.body).not.toContain("auth-admin");
  });
  it("keeps prior spec sections and their hosted images unchanged", async () => {
    const { root, directory, body } = await fixture();
    const old = `### 舊票\n證據：${join(root, "old-run")}（runner 主機本機，不在 git）\n| old | screen.png |\n### 本票\n`;
    const result = await preparePrEvidence(old + body, { directory, files: ["screen.png"] }, root);
    expect(result.body).toContain(old);
  });
  it.each(["../outside.png", "/tmp/outside.png", ".playwright-cli/screen.png", "screen.png#leak"])("rejects untrusted attachment path %s", async (name) => {
    const { root, directory, body } = await fixture();
    await expect(preparePrEvidence(body, { directory, files: [name] }, root)).rejects.toThrow();
  });
  it("rejects a report pointing outside the configured state directory", async () => {
    const { root, directory, body } = await fixture();
    const allowed = join(root, "allowed"); await mkdir(allowed);
    await expect(preparePrEvidence(body, { directory, files: ["screen.png"] }, allowed)).rejects.toThrow("狀態目錄");
  });
  it("rejects symlinks escaping the evidence directory and text disguised as PNG", async () => {
    const { root, directory, body } = await fixture();
    const outside = join(root, "outside.png"); await writeFile(outside, png);
    await symlink(outside, join(directory, "escape.png"));
    await expect(preparePrEvidence(body, { directory, files: ["escape.png"] }, root)).rejects.toThrow("資料夾內");
    await writeFile(join(directory, "fake.png"), "secret text");
    await expect(preparePrEvidence(body, { directory, files: ["fake.png"] }, root)).rejects.toThrow("圖片或影片");
  });
});
