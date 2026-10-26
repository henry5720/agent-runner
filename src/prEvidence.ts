import { open, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, sep } from "node:path";
import type { PrEvidence } from "./ports.js";

const media = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".mp4", ".webm"]);
const within = (root: string, file: string) => { const path = relative(root, file); return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path); };

/** 路徑由驗收模型回報；只接受狀態目錄內、被引用的真實媒體，禁止 symlink 逸出與改副檔名的文字檔。 */
export async function preparePrEvidence(body: string, evidence?: PrEvidence, evidenceRoot?: string): Promise<{ body: string; paths: string[] }> {
  if (!evidence?.files.length) return { body, paths: [] };
  for (const name of evidence.files) {
    if (isAbsolute(name) || name.includes("\\") || /[#<>\r\n]/.test(name) || name.split("/").some((part) => part.startsWith("."))) throw new Error("證據路徑不合法");
  }
  const names = [...new Set(evidence.files)].filter((name) => media.has(extname(name).toLowerCase()));
  if (!names.length) return { body, paths: [] };
  if (!evidenceRoot) throw new Error("發布證據缺少允許的狀態目錄");
  const root = await realpath(evidenceRoot);
  const directory = await realpath(evidence.directory);
  if (!within(root, directory)) throw new Error("證據資料夾不在 runner 狀態目錄內");
  const paths = new Map<string, string>();
  for (const name of names) {
    const path = await realpath(join(directory, name));
    if (!within(directory, path) || !(await stat(path)).isFile()) throw new Error("證據不是資料夾內的檔案");
    const file = await open(path, "r");
    const header = Buffer.alloc(16);
    try { await file.read(header, 0, header.length, 0); } finally { await file.close(); }
    const ext = extname(name).toLowerCase();
    const valid = ext === ".png" ? header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : ext === ".jpg" || ext === ".jpeg" ? header[0] === 255 && header[1] === 216 && header[2] === 255
      : ext === ".gif" ? /^GIF8[79]a/.test(header.toString("ascii"))
      : ext === ".webp" ? header.toString("ascii", 0, 4) === "RIFF" && header.toString("ascii", 8, 12) === "WEBP"
      : ext === ".mp4" ? header.toString("ascii", 4, 8) === "ftyp"
      : header.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]));
    if (!valid) throw new Error("證據內容不是宣告的圖片或影片");
    paths.set(name, path);
  }
  let section = false;
  const used = new Set<string>();
  const lines = body.split("\n").map((line) => {
    if (/^#{1,6} /.test(line)) section = false;
    if (line === `證據：${evidence.directory}（runner 主機本機，不在 git）`) section = true;
    if (!section || !line.startsWith("|") || !line.endsWith("|")) return line;
    const cells = line.split("|");
    const references = cells.at(-2)!.trim().split("、");
    cells[cells.length - 2] = " " + references.map((name) => {
      const path = paths.get(name);
      if (!path) return name;
      used.add(path);
      return `![${name.replaceAll("[", "\\[").replaceAll("]", "\\]")}](<${path}>)`;
    }).join("、") + " ";
    return cells.join("|");
  });
  if (used.size > 50) throw new Error("一次最多發布 50 個證據附件");
  return { body: lines.join("\n"), paths: [...used] };
}
