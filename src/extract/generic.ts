import { ClipError } from "../errors";
import { Readability } from "@mozilla/readability";
import { domToMarkdown, collectImages } from "../dommd";
import { clamp, formatDateTime } from "../util";
import { DESKTOP_UA } from "../fetcher";
import type { ExtractResult, FetchOpts, Fetcher } from "../types";

/**
 * 通用网页/新闻提取器：@mozilla/readability + 元信息兜底。
 * 硬限制（诚实说明）：需要 JS 渲染的页面、强付费墙页面拿不到完整正文；
 * 这种情况不会静默存垃圾 —— 会在 warnings 里标注，且正文过短时明确提示用「手动粘贴内容剪藏」。
 */
export async function extractGenericWeb(
  fetcher: Fetcher,
  rawUrl: string,
  opts: FetchOpts = {},
): Promise<ExtractResult> {
  const page = await fetcher.fetchText(rawUrl, {
    headers: {
      "User-Agent": DESKTOP_UA,
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    },
    ...opts,
  });

  if (page.status >= 400) {
    throw new ClipError(
      `网页请求失败 HTTP ${page.status}`,
      `无法获取该网页（HTTP ${page.status}）。链接可能失效，或站点有反爬限制；也可以打开页面复制正文，用「手动粘贴内容剪藏」。`,
    );
  }

  const html = page.text;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const baseUrl = page.finalUrl || rawUrl;

  const metaContent = (sel: string): string =>
    doc.querySelector(sel)?.getAttribute("content")?.trim() ?? "";

  const meta = {
    ogTitle:
      metaContent('meta[property="og:title"]') ||
      metaContent('meta[name="twitter:title"]'),
    siteName: metaContent('meta[property="og:site_name"]'),
    author:
      metaContent('meta[name="author"]') ||
      metaContent('meta[property="article:author"]') ||
      metaContent('meta[name="byl"]'),
    published:
      metaContent('meta[property="article:published_time"]') ||
      metaContent('meta[name="pubdate"]') ||
      metaContent('meta[name="date"]') ||
      metaContent('meta[itemprop="datePublished"]'),
  };

  // 懒加载图重写后再交给 Readability
  doc.querySelectorAll("img").forEach((img) => {
    const ds =
      img.getAttribute("data-src") ||
      img.getAttribute("data-original") ||
      img.getAttribute("data-lazy-src");
    if (ds && !img.getAttribute("src")) img.setAttribute("src", ds);
  });

  let article: { title?: string; content?: string; byline?: string; excerpt?: string } | null = null;
  try {
    article = new Readability(doc.cloneNode(true) as Document).parse();
  } catch {
    article = null;
  }

  const warnings: string[] = [];
  let contentMarkdown = "";
  let contentText = "";
  let images: string[] = [];

  if (article?.content) {
    const cdoc = new DOMParser().parseFromString(article.content, "text/html");
    contentMarkdown = domToMarkdown(cdoc.body);
    contentText = (cdoc.body.textContent || "").replace(/[ \t]+/g, " ").trim();
    images = collectImages(cdoc.body, baseUrl, 30);
  }

  // Readability 失败或正文过短 → 兜底取 body 文本
  if (contentText.length < 80) {
    const fb = doc.cloneNode(true) as Document;
    fb.querySelectorAll("script,style,noscript,iframe,nav,footer,header").forEach((n) => n.remove());
    const bodyText = (fb.body?.textContent || "").replace(/[ \t]+/g, " ").trim();
    if (bodyText.length > contentText.length) {
      contentText = bodyText;
      contentMarkdown = bodyText.replace(/\n{2,}/g, "\n\n");
      images = collectImages(fb.body ?? fb.documentElement, baseUrl, 30);
      warnings.push("主 正文提取器未命中（页面可能需要 JS 渲染或是付费墙），已保存整页降级文本，建议用「手动粘贴内容剪藏」精修。");
    }
  }

  if (contentText.length < 40) {
    throw new ClipError(
      "网页正文过短，疑似需要 JS 渲染或为付费墙",
      "这个页面拿不到有效正文（可能是动态渲染页面或付费墙）。建议：打开页面复制正文 → 用「手动粘贴内容剪藏」保存。",
    );
  }
  if (contentText.length < 120) {
    warnings.push("正文较短，可能只抓到摘要（页面动态渲染/付费墙），建议人工核对。");
  }

  const title =
    (article?.title || "").trim() ||
    meta.ogTitle ||
    doc.title?.trim() ||
    "网页剪藏";

  let publishTime = meta.published || undefined;
  if (publishTime) {
    const d = new Date(publishTime);
    publishTime = isNaN(d.getTime()) ? undefined : formatDateTime(d.getTime());
  }

  return {
    source: "web",
    url: rawUrl,
    finalUrl: baseUrl,
    title,
    author: (article?.byline || meta.author || undefined)?.trim(),
    publishTime,
    siteName: meta.siteName || undefined,
    contentMarkdown,
    contentText,
    excerpt: clamp(contentText, 160),
    images,
    warnings,
  };
}
