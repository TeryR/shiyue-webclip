import { ClipError } from "../errors";
import { domToMarkdown, collectImages } from "../dommd";
import { clamp, formatDateTime } from "../util";
import { DESKTOP_UA } from "../fetcher";
import type { ExtractResult, FetchOpts, Fetcher } from "../types";

/**
 * 微信公众号文章提取器。
 * 公众号文章是服务端渲染的静态 HTML（#js_content），无需登录即可抓大多数文章；
 * 但有风控（"环境异常"验证）与删文检测，必须显式报错而不是存半页垃圾。
 */
export async function extractWeChat(
  fetcher: Fetcher,
  rawUrl: string,
  opts: FetchOpts = {},
): Promise<ExtractResult> {
  const page = await fetcher.fetchText(rawUrl, {
    headers: {
      "User-Agent": DESKTOP_UA,
      Referer: "https://mp.weixin.qq.com/",
      "Accept-Language": "zh-CN,zh;q=0.9",
    },
    ...opts,
  });

  if (page.status >= 400) {
    throw new ClipError(
      `公众号文章请求失败 HTTP ${page.status}`,
      `无法获取公众号文章（HTTP ${page.status}）。链接可能已失效，或微信对当前网络做了限制，稍后重试。`,
    );
  }

  const html = page.text;
  if (/环境异常/.test(html)) {
    throw new ClipError(
      "微信风控：环境异常验证",
      "微信检测到异常访问，要求人机验证。请稍后重试；或先在浏览器里打开该链接确认能看到正文，再用「手动粘贴内容剪藏」兜底。",
    );
  }
  if (/该内容已被发布者删除|此内容因违规无法查看|此内容被投诉且无法查看/.test(html)) {
    throw new ClipError(
      "公众号文章已删除或违规下架",
      "这篇文章已被发布者删除或因违规无法查看，无法剪藏。",
    );
  }

  const doc = new DOMParser().parseFromString(html, "text/html");

  // 清理：脚本样式、懒加载图重写
  doc.querySelectorAll("script, style, noscript").forEach((n) => n.remove());
  doc.querySelectorAll("img").forEach((img) => {
    const ds = img.getAttribute("data-src");
    if (ds && !img.getAttribute("src")) img.setAttribute("src", ds);
    img.removeAttribute("style");
  });

  const title =
    doc.querySelector("h1#activity-name")?.textContent?.trim() ||
    doc.querySelector('meta[property="og:title"]')?.getAttribute("content")?.trim() ||
    doc.title?.trim() ||
    "微信文章";

  const author =
    doc.querySelector("a#js_name")?.textContent?.trim() ||
    doc.querySelector('meta[name="author"]')?.getAttribute("content")?.trim() ||
    undefined;

  // 发布时间：var ct = "1699..." 是最稳的；#publish_time 由前端渲染，常拿不到
  let publishTime: string | undefined;
  const ct = html.match(/ct\s*=\s*"?(\d{10})"?/);
  if (ct) {
    publishTime = formatDateTime(parseInt(ct[1], 10) * 1000);
  }
  if (!publishTime) {
    const em = doc.querySelector("#publish_time")?.textContent?.trim();
    if (em && /^\d{4}-\d{2}-\d{2}/.test(em)) publishTime = em.slice(0, 16);
  }

  const contentEl =
    doc.querySelector("#js_content") || doc.querySelector(".rich_media_content");
  if (!contentEl) {
    throw new ClipError(
      "未找到公众号正文容器(#js_content)",
      "这个链接不是公众号图文页（可能是公众号主页、小程序或被风控拦截的页面），无法提取正文。",
    );
  }

  const contentMarkdown = domToMarkdown(contentEl);
  const contentText = (contentEl.textContent || "").replace(/\s+/g, " ").trim();
  if (contentText.length < 10) {
    throw new ClipError(
      "公众号正文为空",
      "文章正文内容为空（可能整篇是图片或被风控拦截），无法剪藏。",
    );
  }

  const images = collectImages(contentEl, page.finalUrl, 30).filter((u) =>
    /mmbiz\.qpic\.cn|^https?:\/\//i.test(u),
  );

  const warnings: string[] = [];
  if (!publishTime) {
    warnings.push("未能读取发布时间（公众号前端渲染），已留空。");
  }
  if (images.length === 0 && /<img/i.test(html)) {
    warnings.push("未提取到正文图片，可能全部为懒加载失败。");
  }

  return {
    source: "wechat",
    url: rawUrl,
    finalUrl: page.finalUrl,
    title,
    author,
    publishTime,
    siteName: "微信公众号",
    contentMarkdown,
    contentText,
    excerpt: clamp(contentText, 160),
    images,
    warnings,
  };
}
