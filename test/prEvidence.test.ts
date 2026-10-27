import { mkdtemp, mkdir, writeFile, symlink, rm, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evidenceDirLine } from "../src/browserVerification.js";
import { preparePrEvidence } from "../src/prEvidence.js";

const roots: string[] = [];
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pr-evidence-")); roots.push(root);
  const directory = join(root, "42-run"); await mkdir(directory);
  await writeFile(join(directory, "screen.png"), png);
  const body = `## 瀏覽器驗收\n\n${evidenceDirLine(directory)}\n\n| 條件 | 結果 | 帳號 | 看到什麼／原因 | 證據 |\n| 畫面 | passed | — | 符合 | screen.png、checks.txt |`;
  return { root, directory, body };
}
const unverifiableBody = (directory: string, reason: string) => `## 瀏覽器驗收\n\n${evidenceDirLine(directory)}\n\n驗不了：${reason}\n\n判定 model：m`;
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("PR evidence publication", () => {
  it("embeds referenced images once and keeps non-media files local", async () => {
    const { root, directory, body } = await fixture();
    const result = await preparePrEvidence(body, { directory, files: ["screen.png", "screen.png", "checks.txt", "auth-admin.json"] }, root);
    expect(result.paths).toEqual([join(directory, "screen.png")]);
    expect(result.body).toContain(`![screen.png](<${join(directory, "screen.png")}>)、checks.txt`);
    expect(result.body).not.toContain("auth-admin");
  });
  it("attaches only the images the verifier referenced, not everything in the folder", async () => {
    const { root, directory, body } = await fixture();
    await writeFile(join(directory, "login-form.png"), png);
    const result = await preparePrEvidence(body, { directory, files: ["screen.png"] }, root);
    expect(result.paths).toEqual([join(directory, "screen.png")]);
    expect(result.body).not.toContain("login-form");
  });
  it("attaches the images an unverifiable reason names, in the order it names them", async () => {
    const { root, directory } = await fixture();
    await writeFile(join(directory, "environment-config-failed.png"), png);
    await mkdir(join(directory, "step")); await writeFile(join(directory, "step", "login.png"), png);
    await writeFile(join(directory, "fake.png"), "secret text");
    const reason = "登入失敗，見 environment-config-failed.png 與 step/login.png；fake.png、missing.png、.playwright-cli/page.png、/tmp/x.png 也看過";
    const body = unverifiableBody(directory, reason);
    const result = await preparePrEvidence(body, { directory, files: [], unverifiableReason: reason }, root);
    const failed = join(directory, "environment-config-failed.png"), login = join(directory, "step", "login.png");
    expect(result.paths).toEqual([failed, login]);
    expect(result.body).toBe(body.replace(`${evidenceDirLine(directory)}\n\n`, `${evidenceDirLine(directory)}\n\n其他證據：![environment-config-failed.png](<${failed}>)、![step/login.png](<${login}>)\n\n`));
  });
  it("appends unverifiable attachments to the end when the evidence line is missing", async () => {
    const { root, directory } = await fixture();
    const result = await preparePrEvidence("驗不了：見 screen.png", { directory, files: [], unverifiableReason: "見 screen.png" }, root);
    expect(result.paths).toEqual([join(directory, "screen.png")]);
    expect(result.body).toBe(`驗不了：見 screen.png\n\n其他證據：![screen.png](<${join(directory, "screen.png")}>)`);
  });
  it("keeps files over 10 MB local and says so where they are referenced", async () => {
    const { root, directory } = await fixture();
    await writeFile(join(directory, "big.png"), png); await truncate(join(directory, "big.png"), 10 * 1024 * 1024 + 1);
    const body = `## 瀏覽器驗收\n\n${evidenceDirLine(directory)}\n\n| 條件 | 結果 | 帳號 | 看到什麼／原因 | 證據 |\n| 畫面 | passed | — | 符合 | big.png、screen.png |`;
    const result = await preparePrEvidence(body, { directory, files: ["big.png", "screen.png"] }, root);
    expect(result.paths).toEqual([join(directory, "screen.png")]);
    expect(result.body).toContain(`| big.png（超過 10 MB，原檔在證據資料夾）、![screen.png](<${join(directory, "screen.png")}>) |`);
  });
  it("attaches at most 50 files in reason order and says how many were left out", async () => {
    const { root, directory } = await fixture();
    const names = Array.from({ length: 51 }, (_, i) => `s${String(50 - i).padStart(2, "0")}.png`);
    for (const name of names) await writeFile(join(directory, name), png);
    const reason = `截圖：${names.join(" ")}`;
    const result = await preparePrEvidence(unverifiableBody(directory, reason), { directory, files: [], unverifiableReason: reason }, root);
    expect(result.paths).toHaveLength(50);
    expect(result.paths[0]).toBe(join(directory, "s50.png"));
    expect(result.paths).not.toContain(join(directory, "s00.png"));
    expect(result.body).toContain("另有 1 個證據檔超過一次 50 個附件的上限沒附，原檔在證據資料夾");
  });
  it("leaves the body alone when the evidence directory was never created", async () => {
    const { root, directory } = await fixture();
    const missing = join(directory, "missing");
    const body = unverifiableBody(missing, "見 a.png");
    await expect(preparePrEvidence(body, { directory: missing, files: [], unverifiableReason: "見 a.png" }, root)).resolves.toEqual({ body, paths: [] });
  });
  it("keeps prior spec sections and their hosted images unchanged", async () => {
    const { root, directory, body } = await fixture();
    const old = `### 舊票\n${evidenceDirLine(join(root, "old-run"))}\n| old | screen.png |\n### 本票\n`;
    const result = await preparePrEvidence(old + body, { directory, files: ["screen.png"] }, root);
    expect(result.body).toContain(old);
  });
  it.each(["../outside.png", "/tmp/outside.png", ".playwright-cli/screen.png", "screen.png#leak", "a|b.png", "a、b.png"])("rejects untrusted attachment path %s", async (name) => {
    const { root, directory, body } = await fixture();
    await expect(preparePrEvidence(body, { directory, files: [name] }, root)).rejects.toThrow("證據路徑不合法");
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
