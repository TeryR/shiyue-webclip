import { ClipError } from "../errors";
import { domToMarkdown, collectImages } from "../dommd";
import { clamp, formatDateTime, extractFirstUrl } from "../util";
import { MOBILE_UA } from "../fetcher";
import type { ExtractResult, FetchOpts, Fetcher } from "../types";

const TOUTIAO_ID_RE = /toutiao\.com\/(?:article\/|i)(\d{14,25})/i;

export function parseToutiaoUrl(raw: string): { id: string } | null {
  const url = extractFirstUrl(raw) ?? raw;
  const m = url.match(TOUTIAO_ID_RE);
  return m ? { id: m[1] } : null;
}

/**
 * 页面内嵌的 SSR 数据是 encodeURIComponent 过的 JSON。
 * 整页 decode 会因孤立 % 抛异常，改为只解码合法的连续转义序列（软解码），
 * 再按大括号配对取出 articleInfo 对象。
 */
function softDecode(s: string): string {
  return s.replace(/(?:%[0-9A-Fa-f]{2})+/g, (m) => {
    try {
      return decodeURIComponent(m);
    } catch {
      return m;
    }
  });
}

function extractArticleInfo(html: string): Record<string, unknown> | null {
  const decoded = softDecode(html);
  const key = decoded.indexOf('"articleInfo":{');
  if (key < 0) return null;
  const start = key + '"articleInfo":'.length;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < decoded.length; i++) {
    const c = decoded[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(decoded.slice(start, i + 1)) as Record<string, unknown>;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function pickString(obj: Record<string, unknown> | null, keys: string[]): string | undefined {
  if (!obj) return undefined;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
  }
  return undefined;
}

/**
 * 今日头条（头条号）文章提取器（基于 2026-08-31 真实页面探测）：
 * - 桌面页 www.toutiao.com/article/{id} 是纯 JS 壳，静态抓取拿不到正文；
 * - 移动页 m.toutiao.com/i{id}/ 是服务端渲染：<article> 内有完整正文 HTML，
 *   页面内嵌 URL-encoded 的 articleInfo JSON（标题/发布时间/作者）。
 * 策略：桌面链接自动转移动页抓取。
 * 暂不支持：微头条(/w/)、视频页、付费专栏 —— 明确报错引导。
 */
export async function extractToutiao(
  fetcher: Fetcher,
  rawUrl: string,
  opts: FetchOpts = {},
): Promise<ExtractResult> {
  const parsed = parseToutiaoUrl(rawUrl);
  if (!parsed) {
    throw new ClipError(
      "无法识别头条文章链接",
      "目前支持头条号图文文章链接（www.toutiao.com/article/{id} 或 m.toutiao.com/i{id}）。微头条、视频页、付费专栏暂不支持；可复制正文用「手动粘贴内容剪藏」。",
    );
  }
  const mobileUrl = `https://m.toutiao.com/i${parsed.id}/`;
  const page = await fetcher.fetchText(mobileUrl, {
    headers: {
      "User-Agent": MOBILE_UA,
      "Accept-Language": "zh-CN,zh;q=0.9",
    },
    ...opts,
  });
  if (page.status >= 400) {
    throw new ClipError(
      `头条页面请求失败 HTTP ${page.status}`,
      `无法获取头条文章（HTTP ${page.status}）。文章可能已删除或链接失效。`,
    );
  }
  const html = page.text;

  const info = extractArticleInfo(html);
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script, style, noscript").forEach((n) => n.remove());

  const articleEl = doc.querySelector("article");
  if (!articleEl) {
    throw new ClipError(
      "未找到头条正文容器(<article>)",
      "移动版页面结构可能已变化，或该链接不是图文文章（微头条/视频页暂不支持）。可复制正文用「手动粘贴内容剪藏」。",
    );
  }

  const metaContent = (sel: string): string =>
    doc.querySelector(sel)?.getAttribute("content")?.trim() ?? "";

  const pageTitle =
    (typeof info?.title === "string" && info.title.trim()) ||
    metaContent('meta[property="og:title"]') ||
    (doc.title || "").replace(/\s*[-–]\s*今日头条\s*$/i, "").trim() ||
    "头条文章";

  const author =
    pickString(info as Record<string, unknown> | null, ["media_name", "screen_name", "user_name", "source"]) ||
    metaContent('meta[name="author"]') ||
    undefined;

  let publishTime: string | undefined;
  const pt = info?.publishTime ?? info?.publish_time;
  const ts = typeof pt === "string" ? parseInt(pt, 10) : typeof pt === "number" ? pt : NaN;
  if (!isNaN(ts)) {
    // 兼容秒级（1e9~1e11）与毫秒级（>1e12）时间戳
    const ms = ts > 1e11 ? ts : ts * 1000;
    if (ms > 1e12) publishTime = formatDateTime(ms);
  }

  // 移动页图片是懒加载 data-src
  articleEl.querySelectorAll("img").forEach((img) => {
    const ds = img.getAttribute("data-src") || img.getAttribute("src");
    if (ds && !img.getAttribute("src")) img.setAttribute("src", ds);
    if (ds) img.setAttribute("src", ds);
  });

  const contentMarkdown = domToMarkdown(articleEl);
  const contentText = (articleEl.textContent || "").replace(/[ \t]+/g, " ").trim();
  if (contentText.length < 40) {
    throw new ClipError(
      "头条正文为空或过短",
      "该文章拿不到有效正文（可能已删除、审核中或需要登录）。可打开原文确认后用「手动粘贴内容剪藏」。",
    );
  }

  const images = collectImages(articleEl, page.finalUrl || mobileUrl, 30);

  const warnings: string[] = [];
  if (!publishTime) warnings.push("未能解析发布时间（页面结构变化），已留空。");
  if (!author) warnings.push("未能识别作者，已留空。");

  return {
    source: "toutiao",
    url: rawUrl,
    finalUrl: page.finalUrl || mobileUrl,
    title: pageTitle,
    author,
    publishTime,
    siteName: "今日头条",
    contentMarkdown,
    contentText,
    excerpt: clamp(contentText, 160),
    images,
    extra: { articleId: parsed.id },
    warnings,
  };
}
