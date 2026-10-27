import { open, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, sep } from "node:path";
import { evidenceDirLine } from "./browserVerification.js";
import type { PrEvidence } from "./ports.js";

/** 副檔名 → 檔頭 magic bytes 檢查；能附到 PR 的媒體就是這張表的 key。 */
const signatures: Record<string, (header: Buffer) => boolean> = {
  ".png": (header) => header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
  ".jpg": (header) => header[0] === 255 && header[1] === 216 && header[2] === 255,
  ".jpeg": (header) => header[0] === 255 && header[1] === 216 && header[2] === 255,
  ".gif": (header) => /^GIF8[79]a/.test(header.toString("ascii")),
  ".webp": (header) => header.toString("ascii", 0, 4) === "RIFF" && header.toString("ascii", 8, 12) === "WEBP",
  ".mp4": (header) => header.toString("ascii", 4, 8) === "ftyp",
  ".webm": (header) => header.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163])),
};
const media = new Set(Object.keys(signatures));
const ATTACHMENT_LIMIT = 50;
/** GitHub 圖片附件的單檔上限 */
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const TOO_LARGE = "（超過 10 MB，原檔在證據資料夾）";
/** unverifiableReason 裡看起來像證據檔名的相對路徑 */
const MENTIONED_FILE = new RegExp(`[\\w./-]+(?:${[...media].map((ext) => `\\${ext}`).join("|")})(?![\\w.])`, "gi");

class RejectedEvidence extends Error {}
const isMissing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
const within = (root: string, file: string) => { const path = relative(root, file); return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path); };
/** `|`、`、` 會切壞表格欄位與證據欄的分隔 */
const unsafe = (name: string) => isAbsolute(name) || /[\\#<>|、\r\n]/.test(name) || name.split("/").some((part) => part.startsWith("."));
const isMedia = (name: string) => media.has(extname(name).toLowerCase());
const markdownImage = (name: string, path: string) => `![${name.replaceAll("[", "\\[").replaceAll("]", "\\]")}](<${path}>)`;

/** 檔案須是資料夾內的一般檔（不經 symlink 逸出），開頭 bytes 符合副檔名。 */
async function checkedFile(directory: string, name: string): Promise<{ path: string; tooLarge: boolean }> {
  const path = await realpath(join(directory, name));
  const info = await stat(path);
  if (!within(directory, path) || !info.isFile()) throw new RejectedEvidence("證據不是資料夾內的檔案");
  const file = await open(path, "r");
  const header = Buffer.alloc(16);
  try { await file.read(header, 0, header.length, 0); } finally { await file.close(); }
  if (!signatures[extname(name).toLowerCase()]!(header)) throw new RejectedEvidence("證據內容不是宣告的圖片或影片");
  return { path, tooLarge: info.size > MAX_ATTACHMENT_BYTES };
}

/**
 * 只附驗收 agent 登錄過的證據：表格引用的（`files`）在儲存格內換成圖；驗不了時 `unverifiableReason` 點名的檔列在「證據：」那行之後。
 * 引用的路徑不合格就整份失敗；reason 裡點名但不合格的略過。超過 10 MB 的不附，留檔名並註明。
 */
export async function preparePrEvidence(body: string, evidence?: PrEvidence, evidenceRoot?: string): Promise<{ body: string; paths: string[] }> {
  if (!evidence) return { body, paths: [] };
  if (evidence.files.some(unsafe)) throw new Error("證據路徑不合法");
  const referenced = [...new Set(evidence.files)].filter(isMedia);
  const mentioned = [...new Set(evidence.unverifiableReason?.match(MENTIONED_FILE) ?? [])].filter((name) => !unsafe(name) && !referenced.includes(name));
  if (!referenced.length && !mentioned.length) return { body, paths: [] };
  if (!evidenceRoot) throw new Error("發布證據缺少允許的狀態目錄");
  const root = await realpath(evidenceRoot);
  let directory: string;
  try { directory = await realpath(evidence.directory); }
  catch (error) { if (referenced.length || !isMissing(error)) throw error; return { body, paths: [] }; }
  if (!within(root, directory)) throw new Error("證據資料夾不在 runner 狀態目錄內");

  const files = new Map<string, { path: string; tooLarge: boolean }>();
  for (const name of referenced) files.set(name, await checkedFile(directory, name));
  for (const name of mentioned) {
    try { files.set(name, await checkedFile(directory, name)); }
    catch (error) { if (!(error instanceof RejectedEvidence) && !isMissing(error)) throw error; }
  }
  // 名額先給表格引用的（照引用順序），再給 reason 點名的（照出現順序）
  const attachable = [...files].filter(([, file]) => !file.tooLarge).map(([name]) => name);
  const attached = new Set(attachable.slice(0, ATTACHMENT_LIMIT));
  const omitted = attachable.length - attached.size;
  const shown = (name: string) => attached.has(name) ? markdownImage(name, files.get(name)!.path) : files.get(name)?.tooLarge ? `${name}${TOO_LARGE}` : name;

  const anchor = evidenceDirLine(evidence.directory);
  let section = false;
  const inCells = new Set<string>();
  const lines = body.split("\n").map((line) => {
    if (/^#{1,6} /.test(line)) section = false;
    if (line === anchor) section = true;
    if (!section || !line.startsWith("|") || !line.endsWith("|")) return line;
    const cells = line.split("|");
    cells[cells.length - 2] = " " + cells.at(-2)!.trim().split("、").map((name) => {
      if (attached.has(name)) inCells.add(name);
      return shown(name);
    }).join("、") + " ";
    return cells.join("|");
  });

  const listed = mentioned.filter((name) => files.has(name));
  const notes = [
    ...(listed.length ? [`其他證據：${listed.map(shown).join("、")}`] : []),
    ...(omitted ? [`另有 ${omitted} 個證據檔超過一次 ${ATTACHMENT_LIMIT} 個附件的上限沒附，原檔在證據資料夾`] : []),
  ];
  // 找不到「證據：」那行（body 被改過）時，點名的證據接在 body 最後，不靜默丟掉
  const anchorIndex = lines.indexOf(anchor);
  if (notes.length) lines.splice(anchorIndex === -1 ? lines.length : anchorIndex + 1, 0, ...notes.flatMap((note) => ["", note]));
  const published = [...attached].filter((name) => inCells.has(name) || listed.includes(name));
  return { body: lines.join("\n"), paths: published.map((name) => files.get(name)!.path) };
}
