import { ClipError } from "../errors";
import { clamp, formatDateTime, parseInitState } from "../util";
import { MOBILE_UA } from "../fetcher";
import type { ExtractResult, FetchOpts, Fetcher } from "../types";

const NOTE_ID_RE = /\/(?:explore|discovery\/item)\/([0-9a-f]{16,32})/i;

interface XhsNote {
  title?: string;
  desc?: string;
  time?: number;
  user?: { nickname?: string };
  imageList?: { urlDefault?: string; url?: string; infoList?: { url?: string }[] }[];
  video?: unknown;
}

interface XhsEntry {
  note?: { note?: XhsNote } | XhsNote;
  noteRaw?: XhsNote;
}

function resolveNote(entry: XhsEntry | undefined): XhsNote | undefined {
  if (!entry) return undefined;
  const n = entry.note;
  if (n && typeof n === "object" && "note" in n) {
    const inner = (n as { note?: XhsNote }).note;
    if (inner && typeof inner === "object") return inner;
    return n as XhsNote;
  }
  return entry.noteRaw ?? (n as XhsNote | undefined);
}

function pickImageUrl(im: { urlDefault?: string; url?: string; infoList?: { url?: string }[] }): string {
  if (im.urlDefault && /^https?:\/\//.test(im.urlDefault)) return im.urlDefault;
  if (im.url && /^https?:\/\//.test(im.url)) return im.url;
  const alt = (im.infoList ?? []).map((x) => x?.url ?? "").find((u) => /^https?:\/\//.test(u));
  return alt ?? "";
}

/**
 * 小红书提取器。
 * 需要说明的硬限制（已在文档里写明）：
 * - 无登录态时，小红书对网页端有登录墙+风控，匿名请求大多拿不到正文 —— 插件会明确报错并提示配 Cookie；
 * - 有 Cookie 也可能过期/被风控，报错信息会引导重新复制 Cookie；
 * - 短链 xhslink.com 依赖 302 跳转解析，若被风控拦截会提示改用长链。
 */
export async function extractXhs(
  fetcher: Fetcher,
  rawUrl: string,
  opts: FetchOpts & { cookie?: string } = {},
): Promise<ExtractResult> {
  let url = rawUrl;

  // 短链解析
  if (/^https?:\/\/(www\.)?xhslink\.com\//i.test(url)) {
    const page = await fetcher.fetchText(url, {
      headers: { "User-Agent": MOBILE_UA },
      ...opts,
    });
    const finalUrl = page.finalUrl || "";
    if (!finalUrl || /xhslink\.com/i.test(finalUrl)) {
      throw new ClipError(
        "无法解析小红书短链",
        "短链跳转被风控拦截。请先在浏览器里打开这条短链，等跳转到 xiaohongshu.com 笔记页后，复制地址栏长链来剪藏。",
      );
    }
    url = finalUrl;
  }

  const nid = url.match(NOTE_ID_RE)?.[1];
  if (!nid) {
    throw new ClipError(
      "无法识别小红书笔记链接",
      "请使用笔记详情页的分享链接（地址含 /explore/ 或 /discovery/item/）。主页、搜索页链接暂不支持。",
    );
  }

  const headers: Record<string, string> = {
    "User-Agent": MOBILE_UA,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    Referer: "https://www.xiaohongshu.com/",
    "Accept-Language": "zh-CN,zh;q=0.9",
  };
  if (opts.cookie) headers.Cookie = opts.cookie;

  const page = await fetcher.fetchText(url, { headers, ...opts });
  const html = page.text;

  const needCookieHint =
    "打开电脑浏览器登录 xiaohongshu.com → F12 开发者工具 → Network 面板 → 任选一个 xiaohongshu 请求 → 复制请求头里的 Cookie 值 → 粘贴到本插件设置「小红书 Cookie」后重试。若已配置 Cookie 仍报错，大概率是 Cookie 过期或触发风控，请重新复制。也可以在 App/网页里复制正文，用「手动粘贴内容剪藏」兜底。";

  const stateMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*([\s\S]*?)<\/script>/);
  if (!stateMatch) {
    if (!opts.cookie) {
      throw new ClipError("小红书返回登录墙/风控页", `小红书限制匿名抓取，未登录拿不到笔记正文。解决办法：${needCookieHint}`);
    }
    throw new ClipError(
      `小红书页面结构异常 (HTTP ${page.status})`,
      `已带 Cookie 仍拿不到笔记数据：Cookie 可能已过期，或触发了风控验证。${needCookieHint}`,
    );
  }

  const state = parseInitState(stateMatch[1]) as {
    note?: { noteDetailMap?: Record<string, XhsEntry> } | null;
  } | null;
  const entry = state?.note?.noteDetailMap?.[nid];
  const note: XhsNote | undefined = resolveNote(entry);
  if (!note) {
    throw new ClipError("小红书数据里找不到笔记正文", `页面已返回但缺少笔记数据（可能被风控限流）。${needCookieHint}`);
  }

  const title = (note.title || "").trim() || clamp((note.desc || "").replace(/\s+/g, " "), 40) || "小红书笔记";
  const text = (note.desc || "").trim();
  if (!text && !(note.imageList || []).length) {
    throw new ClipError("小红书笔记内容为空", "这条笔记拿不到文字和图片，可能已被删除或仅对登录用户可见。");
  }

  const images = (note.imageList ?? []).map(pickImageUrl).filter((u) => /^https?:\/\//.test(u));
  const warnings: string[] = [];
  if (note.video) warnings.push("这是视频笔记，暂不支持下载视频，仅保留封面图与文字。");
  if (!text) warnings.push("该笔记没有文字描述，仅保存了图片。");
  if (!opts.cookie) warnings.push("本次是在无 Cookie 状态下抓到的数据；如遇正文不全，请按设置页说明配置小红书 Cookie。");

  return {
    source: "xhs",
    url,
    finalUrl: page.finalUrl || url,
    title,
    author: note.user?.nickname?.trim() || undefined,
    publishTime: note.time ? formatDateTime(note.time) : undefined,
    siteName: "小红书",
    contentText: text,
    excerpt: clamp(text.replace(/\s+/g, " "), 160),
    images,
    extra: { noteId: nid },
    warnings,
  };
}
