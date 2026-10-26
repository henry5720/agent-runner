import { open, readdir, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, sep } from "node:path";
import type { PrEvidence } from "./ports.js";

const media = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".mp4", ".webm"]);
const LIMIT = 50;
const within = (root: string, file: string) => { const path = relative(root, file); return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path); };
const unsafe = (name: string) => isAbsolute(name) || name.includes("\\") || /[#<>\r\n]/.test(name) || name.split("/").some((part) => part.startsWith("."));
const isMedia = (name: string) => media.has(extname(name).toLowerCase());
const image = (name: string, path: string) => `![${name.replaceAll("[", "\\[").replaceAll("]", "\\]")}](<${path}>)`;

/** 檔案須是資料夾內的一般檔（不經 symlink 逸出），開頭 bytes 符合副檔名；回傳 realpath。 */
async function checkedPath(directory: string, name: string): Promise<string> {
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
  return path;
}

/** 資料夾內（含子目錄）的媒體檔相對路徑；跳過 `.` 開頭的路徑段，不跟進 symlink 目錄。 */
async function mediaIn(directory: string, prefix = ""): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...(await mediaIn(directory, name)));
    else if (isMedia(name) && !unsafe(name)) found.push(name);
  }
  return found;
}

/**
 * 證據資料夾內的媒體全部附上 PR（含驗不了的 run）：被表格引用的在儲存格內換成圖，其餘列在「證據：」那行之後的「其他證據：」。
 * 被引用的路徑由驗收模型回報，不合格就整份失敗；沒被引用、掃到但不合格的檔直接略過。
 */
export async function preparePrEvidence(body: string, evidence?: PrEvidence, evidenceRoot?: string): Promise<{ body: string; paths: string[] }> {
  if (!evidence) return { body, paths: [] };
  if (evidence.files.some(unsafe)) throw new Error("證據路徑不合法");
  const referenced = [...new Set(evidence.files)].filter(isMedia);
  if (!evidenceRoot) {
    if (referenced.length) throw new Error("發布證據缺少允許的狀態目錄");
    return { body, paths: [] };
  }
  const root = await realpath(evidenceRoot);
  let directory: string;
  try { directory = await realpath(evidence.directory); }
  catch (error) { if (referenced.length) throw error; return { body, paths: [] }; }
  if (!within(root, directory)) throw new Error("證據資料夾不在 runner 狀態目錄內");

  const paths = new Map<string, string>();
  for (const name of referenced) paths.set(name, await checkedPath(directory, name));
  for (const name of await mediaIn(directory)) {
    if (paths.has(name)) continue;
    try { paths.set(name, await checkedPath(directory, name)); } catch { /* 沒被引用的不合格檔不附 */ }
  }
  // 名額先給被引用的（照引用順序），剩下的才給沒被引用的（照檔名）
  const names = [...paths.keys()].sort();
  const selected = new Set([...referenced, ...names.filter((name) => !referenced.includes(name))].slice(0, LIMIT));
  const omitted = names.length - selected.size;

  const anchor = `證據：${evidence.directory}（runner 主機本機，不在 git）`;
  let section = false;
  const inCells = new Set<string>();
  const lines = body.split("\n").map((line) => {
    if (/^#{1,6} /.test(line)) section = false;
    if (line === anchor) section = true;
    if (!section || !line.startsWith("|") || !line.endsWith("|")) return line;
    const cells = line.split("|");
    const references = cells.at(-2)!.trim().split("、");
    cells[cells.length - 2] = " " + references.map((name) => {
      if (!selected.has(name)) return name;
      inCells.add(name);
      return image(name, paths.get(name)!);
    }).join("、") + " ";
    return cells.join("|");
  });

  const others = [...selected].filter((name) => !inCells.has(name));
  const notes = [
    ...(others.length ? [`其他證據：${others.map((name) => image(name, paths.get(name)!)).join("、")}`] : []),
    ...(omitted ? [`另有 ${omitted} 個證據檔超過一次 ${LIMIT} 個附件的上限沒附，原檔在證據資料夾`] : []),
  ];
  const at = lines.indexOf(anchor);
  const placed = at === -1 ? [] : others;
  if (at !== -1 && notes.length) lines.splice(at + 1, 0, ...notes.flatMap((note) => ["", note]));
  return { body: lines.join("\n"), paths: names.filter((name) => inCells.has(name) || placed.includes(name)).map((name) => paths.get(name)!) };
}
