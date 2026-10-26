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

const unverifiable = (directory: string) => `## 瀏覽器驗收\n\n證據：${directory}（runner 主機本機，不在 git）\n\n驗不了：登入失敗，見 environment-config-failed.png\n\n判定 model：m`;

describe("PR evidence publication", () => {
  it("attaches images from an unverifiable run that has no criteria", async () => {
    const { root, directory } = await fixture();
    await writeFile(join(directory, "environment-config-failed.png"), png);
    const result = await preparePrEvidence(unverifiable(directory), { directory, files: [] }, root);
    const failed = join(directory, "environment-config-failed.png"), screen = join(directory, "screen.png");
    expect(result.paths).toEqual([failed, screen]);
    expect(result.body).toBe(`## 瀏覽器驗收\n\n證據：${directory}（runner 主機本機，不在 git）\n\n其他證據：![environment-config-failed.png](<${failed}>)、![screen.png](<${screen}>)\n\n驗不了：登入失敗，見 environment-config-failed.png\n\n判定 model：m`);
  });
  it("lists unreferenced images of a verified run right after the evidence line", async () => {
    const { root, directory, body } = await fixture();
    await writeFile(join(directory, "extra.png"), png);
    const result = await preparePrEvidence(body, { directory, files: ["screen.png"] }, root);
    const extra = join(directory, "extra.png"), screen = join(directory, "screen.png");
    expect(result.paths).toEqual([extra, screen]);
    expect(result.body).toContain(`證據：${directory}（runner 主機本機，不在 git）\n\n其他證據：![extra.png](<${extra}>)\n\n| 條件 |`);
    expect(result.body).toContain(`| ![screen.png](<${screen}>)、checks.txt |`);
  });
  it("attaches nested media but skips hidden directories, non-media files and fake images", async () => {
    const { root, directory } = await fixture();
    await mkdir(join(directory, ".playwright-cli"));
    await writeFile(join(directory, ".playwright-cli", "page.png"), png);
    await mkdir(join(directory, "step", ".cache"), { recursive: true });
    await writeFile(join(directory, "step", ".cache", "c.png"), png);
    await writeFile(join(directory, "step", "dialog.png"), png);
    await writeFile(join(directory, "state.json"), "[]");
    await writeFile(join(directory, "fake.png"), "secret text");
    const result = await preparePrEvidence(unverifiable(directory), { directory, files: [] }, root);
    expect(result.paths).toEqual([join(directory, "screen.png"), join(directory, "step", "dialog.png")]);
    expect(result.body).not.toMatch(/page\.png|c\.png|state\.json|fake\.png\]/);
  });
  it("attaches the first 50 files by name and says how many were left out", async () => {
    const { root, directory } = await fixture();
    for (let i = 0; i < 51; i++) await writeFile(join(directory, `s${String(i).padStart(2, "0")}.png`), png);
    const result = await preparePrEvidence(unverifiable(directory), { directory, files: [] }, root);
    expect(result.paths).toHaveLength(50);
    expect(result.paths.at(-1)).toBe(join(directory, "s49.png"));
    expect(result.body).not.toContain("s50.png");
    expect(result.body).toContain("另有 2 個證據檔超過一次 50 個附件的上限沒附，原檔在證據資料夾");
  });
  it("keeps referenced files within the 50 limit before unreferenced ones", async () => {
    const { root, directory, body } = await fixture();
    for (let i = 0; i < 51; i++) await writeFile(join(directory, `a${String(i).padStart(2, "0")}.png`), png);
    const result = await preparePrEvidence(body, { directory, files: ["screen.png"] }, root);
    expect(result.paths).toHaveLength(50);
    expect(result.paths).toContain(join(directory, "screen.png"));
    expect(result.paths).toContain(join(directory, "a48.png"));
    expect(result.body).not.toContain("a49.png");
    expect(result.body).toContain(`| ![screen.png](<${join(directory, "screen.png")}>)、checks.txt |`);
    expect(result.body).toContain("另有 2 個證據檔");
  });
  it("leaves the body alone when the evidence directory was never created", async () => {
    const { root, directory } = await fixture();
    const body = unverifiable(join(directory, "missing"));
    await expect(preparePrEvidence(body, { directory: join(directory, "missing"), files: [] }, root)).resolves.toEqual({ body, paths: [] });
  });
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
