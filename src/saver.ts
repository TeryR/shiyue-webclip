import { App, TFile, normalizePath } from "obsidian";
import { ClipError } from "./errors";
import { sanitizeFilename } from "./util";
import type { Fetcher } from "./types";

/** 逐级创建文件夹（已存在则跳过） */
export async function ensureFolder(app: App, folderPath: string): Promise<void> {
  const parts = (folderPath || "").split("/").map((p) => p.trim()).filter(Boolean);
  let cur = "";
  for (const p of parts) {
    cur = cur ? `${cur}/${p}` : p;
    const path = normalizePath(cur);
    if (!app.vault.getAbstractFileByPath(path)) {
      try {
        await app.vault.createFolder(path);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!/already exists/i.test(msg)) throw e;
      }
    }
  }
}

export function uniqueMarkdownPath(app: App, folder: string, filename: string): string {
  const base = sanitizeFilename(filename.replace(/\.md$/i, ""));
  let candidate = normalizePath(`${folder}/${base}.md`);
  let i = 2;
  while (app.vault.getAbstractFileByPath(candidate)) {
    candidate = normalizePath(`${folder}/${base} ${i}.md`);
    i += 1;
  }
  return candidate;
}

export async function saveMarkdown(
  app: App,
  folder: string,
  filename: string,
  content: string,
): Promise<{ path: string; file: TFile }> {
  await ensureFolder(app, folder);
  const path = uniqueMarkdownPath(app, folder, filename);
  const file = await app.vault.create(path, content);
  return { path, file };
}

function extFromUrl(url: string): string {
  const m = url.match(/(\.(jpg|jpeg|png|gif|webp|avif|bmp))(?:[?#]|$)/i);
  return m ? m[1].toLowerCase() : ".jpg";
}

/**
 * 批量下载正文图片到附件目录。
 * 单张失败不中断整体（保留远程地址），返回失败数让上层写 warning。
 */
export async function downloadImages(
  app: App,
  fetcher: Fetcher,
  images: string[],
  cfg: { attachmentsFolder: string; baseName: string; max: number; timeoutMs: number },
): Promise<{ map: Map<string, string>; failures: number }> {
  const map = new Map<string, string>();
  if (!images.length) return { map, failures: 0 };
  await ensureFolder(app, cfg.attachmentsFolder);
  const base = sanitizeFilename(cfg.baseName, 40) || "img";
  const list = Array.from(new Set(images)).slice(0, Math.max(1, cfg.max));
  let failures = 0;
  for (let i = 0; i < list.length; i++) {
    const remote = list[i];
    try {
      // 部分站点图片有防盗链，按域名补 Referer
      const headers: Record<string, string> = {};
      if (/toutiaoimg\.com|pstatp\.com|toutiao\.com/i.test(remote)) headers.Referer = "https://www.toutiao.com/";
      else if (/mmbiz\.qpic\.cn/i.test(remote)) headers.Referer = "https://mp.weixin.qq.com/";
      else if (/sns-img\.com|xiaohongshu\.com/i.test(remote)) headers.Referer = "https://www.xiaohongshu.com/";
      const buf = await fetcher.fetchBinary(remote, { headers, timeoutMs: cfg.timeoutMs });
      if (!buf || buf.byteLength < 1000) throw new ClipError("image too small");
      const name = `${base}-${String(i + 1).padStart(2, "0")}${extFromUrl(remote)}`;
      let candidate = normalizePath(`${cfg.attachmentsFolder}/${name}`);
      let n = 2;
      const dot = name.lastIndexOf(".");
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : "";
      while (app.vault.getAbstractFileByPath(candidate)) {
        candidate = normalizePath(`${cfg.attachmentsFolder}/${stem}-${n}${ext}`);
        n += 1;
      }
      const file = await app.vault.createBinary(candidate, buf);
      // 生成最短可用链接文本
      let linktext = file.path;
      try {
        linktext = app.metadataCache.fileToLinktext(file, "/", false);
      } catch {
        /* 退回完整路径 */
      }
      map.set(remote, linktext);
    } catch {
      failures += 1;
    }
  }
  return { map, failures };
}
