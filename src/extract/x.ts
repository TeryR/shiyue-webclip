import { ClipError } from "../errors";
import { clamp, parseTwitterDate, formatDateTime, safeJson } from "../util";
import { DESKTOP_UA } from "../fetcher";
import type { ExtractResult, FetchOpts, Fetcher } from "../types";

const X_URL_RE =
  /(?:twitter|x)\.com\/([A-Za-z0-9_]{1,15})\/(?:status(?:es)?|article)\/(\d+)/i;

export function parseTweetUrl(raw: string): { user: string; id: string; isArticle: boolean } | null {
  const m = raw.match(X_URL_RE);
  if (!m) return null;
  const user = m[1];
  // /i/web/status/xxx 这类路径第一段是 i，不是用户名
  if (/^i$/i.test(user)) return null;
  return { user, id: m[2], isArticle: /\/article\/\d+/i.test(raw) };
}

/** react-tweet 同款公开 token 算法，用于 cdn.syndication.twimg.com */
function syndicationToken(id: string): string {
  const n = Number(id);
  if (!isFinite(n)) return "a";
  return ((n / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
}

interface SyndTweet {
  text?: string;
  created_at?: string;
  user?: { name?: string; screen_name?: string };
  photos?: { url?: string }[];
  mediaDetails?: { type?: string; media_url_https?: string }[];
  note_tweet?: unknown;
  article?: unknown;
  video?: unknown;
}

interface FxBlock {
  text?: string;
  type?: string;
  entityRanges?: { offset: number; length: number; key: number | string }[];
}

interface FxArticle {
  title?: string;
  preview_text?: string;
  created_at?: string;
  content?: { blocks?: FxBlock[]; entityMap?: Record<string, { type?: string; data?: { url?: string } }> };
  cover_media?: { media_info?: { original_img_url?: string; url?: string; src?: string } };
}

interface FxTweet {
  text?: string;
  author?: { name?: string; screen_name?: string };
  created_at?: string;
  is_note_tweet?: boolean;
  media?: { photos?: { url?: string }[] };
  article?: FxArticle;
}

/** draft-js blocks → Markdown（还原链接实体，标题/列表/引用转结构） */
function articleBlocksToMd(
  content: { blocks?: FxBlock[]; entityMap?: Record<string, { type?: string; data?: { url?: string } }> },
): string {
  const blocks = content.blocks ?? [];
  const emap = content.entityMap ?? {};
  const out: string[] = [];
  let ordered = 0;
  for (const b of blocks) {
    let t = b.text ?? "";
    if (b.type === "ordered-list-item") ordered += 1;
    else ordered = 0;
    // 还原链接实体（从后往前插入，避免偏移失效）
    const ranges = [...(b.entityRanges ?? [])].sort((x, y) => y.offset - x.offset);
    for (const r of ranges) {
      const ent = emap[String(r.key)];
      const url = ent?.data?.url;
      if (url && r.offset >= 0 && r.offset + r.length <= t.length) {
        const label = t.slice(r.offset, r.offset + r.length);
        t = t.slice(0, r.offset) + `[${label}](${url})` + t.slice(r.offset + r.length);
      }
    }
    if (!t.trim()) continue;
    switch (b.type) {
      case "header-one":
        out.push("## " + t);
        break;
      case "header-two":
        out.push("### " + t);
        break;
      case "header-three":
        out.push("#### " + t);
        break;
      case "unordered-list-item":
        out.push("- " + t);
        break;
      case "ordered-list-item":
        out.push(`${ordered}. ` + t);
        break;
      case "blockquote":
        out.push("> " + t);
        break;
      case "atomic":
        break; // 图片/嵌入占位，图片走封面与推文配图
      default:
        out.push(t);
    }
  }
  return out.join("\n\n");
}

/**
 * X(Twitter) 提取器 v2（基于 2026-08 真实接口探测）：
 * 1) syndication + fxtwitter 双通道并行，取更长的正文 —— 长推文(note_tweet)在 syndication 里
 *    只有截断版（约 280 字），全文在 fxtwitter；Article 的全文 blocks 也只在 fxtwitter。
 * 2) X 长文(Article)：解析 fxtwitter 的 article.content.blocks（draft-js）为 Markdown，
 *    含标题/列表/引用/链接实体还原，封面图一并入库。
 * 3) 都失败再降级 oembed（仅正文摘要+作者）。
 * 局限（已在文档声明）：受限推（年龄/地区）、已删推、纯视频文件拿不到；线程串只取当前单条。
 */
export async function extractX(
  fetcher: Fetcher,
  rawUrl: string,
  opts: FetchOpts = {},
): Promise<ExtractResult> {
  const pu = parseTweetUrl(rawUrl);
  if (!pu) {
    throw new ClipError(
      "无法识别推文链接",
      "请粘贴单条推文或 X 长文的链接（形如 https://x.com/用户名/status/123 或 /article/123）。暂不支持主页、线程串、搜索页链接。",
    );
  }
  const canonical = `https://x.com/${pu.user}/${pu.isArticle ? "article" : "status"}/${pu.id}`;
  const headers = { "User-Agent": DESKTOP_UA, Accept: "application/json,text/html;q=0.9,*/*;q=0.8" };
  const warnings: string[] = [];

  const [syndRes, fxRes] = await Promise.allSettled([
    fetcher.fetchText(
      `https://cdn.syndication.twimg.com/tweet-result?id=${pu.id}&token=${syndicationToken(pu.id)}&lang=zh`,
      { headers, ...opts },
    ),
    fetcher.fetchText(`https://api.fxtwitter.com/status/${pu.id}`, { headers, ...opts }),
  ]);

  let synd: SyndTweet | null = null;
  if (syndRes.status === "fulfilled") {
    const page = syndRes.value;
    if (page.status === 200) {
      const j = safeJson(page.text) as SyndTweet | null;
      if (j && typeof j.text === "string" && j.text.trim()) synd = j;
    }
  }

  let fx: FxTweet | null = null;
  let fxViaProxy = false;
  if (fxRes.status === "fulfilled") {
    const page = fxRes.value;
    if (page.status === 200) {
      const j = safeJson(page.text) as { tweet?: FxTweet } | null;
      if (j?.tweet && typeof j.tweet.text === "string" && j.tweet.text.trim()) {
        fx = j.tweet;
        fxViaProxy = synd === null; // syndication 失败时才标注走了代理
      }
    }
  }

  const syndText = synd?.text?.trim() ?? "";
  const fxText = fx?.text?.trim() ?? "";

  // —— X 长文（Article）模式：fxtwitter 的 article.content.blocks 有全文 ——
  const article = fx?.article;
  if (article?.content?.blocks?.length) {
    const contentMd = articleBlocksToMd(article.content);
    if (contentMd.trim().length > 40) {
      const fxAuthor = fx?.author;
      const cover =
        article.cover_media?.media_info?.original_img_url ||
        article.cover_media?.media_info?.url ||
        article.cover_media?.media_info?.src ||
        "";
      const images = [
        ...(cover && /^https?:\/\//.test(cover) ? [cover] : []),
        ...(fx?.media?.photos ?? []).map((p) => p?.url ?? "").filter((u) => /^https?:\/\//.test(u)),
        ...(synd?.photos ?? []).map((p) => p?.url ?? "").filter((u) => /^https?:\/\//.test(u)),
      ];
      let publishTime: string | undefined;
      if (article.created_at) {
        const d = new Date(article.created_at);
        if (!isNaN(d.getTime())) publishTime = formatDateTime(d.getTime());
      }
      const title = (article.title || "").trim() || clamp(fxText, 60);
      warnings.push("X 长文（Article）全文经公共代理 fxtwitter 获取，其可用性不保证；封面为文章封面图。");
      return {
        source: "x",
        url: canonical,
        finalUrl: canonical,
        title,
        author: fxAuthor?.name?.trim() || synd?.user?.name?.trim() || `@${pu.user}`,
        publishTime,
        siteName: "X (Twitter)",
        contentText: contentMd,
        excerpt: clamp(contentMd.replace(/\s+/g, " "), 160),
        images: Array.from(new Set(images)).slice(0, 30),
        extra: { tweetId: pu.id, handle: `@${fxAuthor?.screen_name?.trim() || pu.user}`, kind: "article" },
        warnings,
      };
    }
  }

  // —— 普通推文模式：取 syndication 与 fxtwitter 中更长的正文 ——
  let text = "";
  let author: string | undefined;
  let handle = pu.user;
  let publishTime: string | undefined;
  let images: string[] = [];

  if (fxText && fxText.length >= syndText.length) {
    text = fxText;
    author = fx?.author?.name?.trim();
    handle = fx?.author?.screen_name?.trim() || pu.user;
    if (fx?.created_at) {
      const d = parseTwitterDate(fx.created_at);
      if (d) publishTime = d;
    }
    images = (fx?.media?.photos ?? [])
      .map((p) => p?.url ?? "")
      .filter((u) => /^https?:\/\//.test(u))
      .map((u) => u.replace(/\?name=\w+$/, "?name=orig"));
    if (!images.length && synd) {
      images = (synd.photos ?? [])
        .map((p) => p?.url ?? "")
        .filter((u) => /^https?:\/\//.test(u));
      if (!images.length && synd.mediaDetails) {
        images = synd.mediaDetails
          .filter((m) => (m.type ?? "photo") === "photo" && m.media_url_https)
          .map((m) => m.media_url_https as string);
      }
    }
    if (fx?.is_note_tweet) {
      warnings.push("这是 X 长推文（note_tweet），已取得完整全文。");
    } else if (fxViaProxy) {
      warnings.push("本次经公共代理 fxtwitter 获取，其可用性不保证。");
    }
  } else if (synd) {
    text = syndText;
    author = synd.user?.name?.trim();
    handle = synd.user?.screen_name?.trim() || pu.user;
    if (synd.created_at) publishTime = parseTwitterDate(synd.created_at);
    images = (synd.photos ?? [])
      .map((p) => p?.url ?? "")
      .filter((u) => /^https?:\/\//.test(u));
    if (!images.length && synd.mediaDetails) {
      images = synd.mediaDetails
        .filter((m) => (m.type ?? "photo") === "photo" && m.media_url_https)
        .map((m) => m.media_url_https as string);
    }
    if (fxRes.status === "rejected") {
      warnings.push("syndication 成功但 fxtwitter 不可达：如正文疑似被截断，可稍后重试。");
    }
    if (synd.video) warnings.push("该推文含视频，暂不支持下载视频文件，仅保留链接。");
  }

  // —— 最后兜底：oembed ——
  if (!text) {
    const oeUrl = `https://publish.twitter.com/oembed?url=${encodeURIComponent(
      `https://twitter.com/${pu.user}/status/${pu.id}`,
    )}&omit_script=1&dnt=true&lang=zh`;
    const page = await fetcher.fetchText(oeUrl, { headers, ...opts });
    const j = page.status === 200 ? (safeJson(page.text) as Record<string, unknown> | null) : null;
    const html = j && typeof j.html === "string" ? j.html : "";
    if (!html) {
      throw new ClipError(
        `推文获取失败 (syndication/fxtwitter/oembed 均失败, oembed HTTP ${page.status})`,
        "拿不到这条推文的内容：可能已删除、受限（年龄/地区）、或 X 限制了匿名抓取。可复制推文内容，用「手动粘贴内容剪藏」保存。",
      );
    }
    const doc = new DOMParser().parseFromString(html, "text/html");
    const ps = Array.from(doc.querySelectorAll("p"))
      .map((p) => (p.textContent || "").trim())
      .filter(Boolean);
    text = ps.join("\n\n");
    const authorRaw = j ? j["author_name"] : undefined;
    author = typeof authorRaw === "string" ? authorRaw : undefined;
    warnings.push("oembed 不提供发布时间与配图，已留空。");
  }

  // Article 关联但没拿到全文 → 明确告知
  if (article) {
    warnings.push(
      "该推文关联 X 长文（Article）：本次只拿到推文本身，未能获取长文全文（公共代理受限）。建议打开原文复制正文，用「手动粘贴内容剪藏」。",
    );
    if (article.preview_text) {
      text += "\n\n—— 文章预览 ——\n" + (article.title ? `《${article.title}》\n` : "") + article.preview_text;
    }
  }

  const screenHandle = handle.startsWith("@") ? handle : `@${handle}`;
  return {
    source: "x",
    url: canonical,
    finalUrl: canonical,
    title: `${clamp(text.replace(/\s+/g, " "), 60)} - ${screenHandle}`,
    author: author ?? screenHandle,
    publishTime,
    siteName: "X (Twitter)",
    contentText: text,
    excerpt: clamp(text.replace(/\s+/g, " "), 160),
    images: Array.from(new Set(images)).slice(0, 30),
    extra: { tweetId: pu.id, handle: screenHandle, kind: pu.isArticle ? "article-url" : "tweet" },
    warnings,
  };
}
