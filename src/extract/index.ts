import { extractX } from "./x";
import { extractWeChat } from "./wechat";
import { extractXhs } from "./xhs";
import { extractGenericWeb } from "./generic";
import { extractToutiao } from "./toutiao";
import { extractFirstUrl, normalizeUrl } from "../util";
import type { ExtractResult, FetchOpts, Fetcher } from "../types";

export type RouteKind = "x" | "wechat" | "xhs" | "web" | "toutiao";

export function routeUrl(url: string): RouteKind {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return "web";
  }
  if (/(^|\.)x\.com$|(^|\.)twitter\.com$/.test(host)) return "x";
  if (host === "mp.weixin.qq.com") return "wechat";
  if (/(^|\.)xiaohongshu\.com$|(^|\.)xhslink\.com$/.test(host)) return "xhs";
  if (/(^|\.)toutiao\.com$/.test(host)) return "toutiao";
  return "web";
}

export interface ExtractOptions extends FetchOpts {
  xhsCookie?: string;
}

/** 统一入口：识别平台 → 分发提取器 */
export async function extractClip(
  fetcher: Fetcher,
  rawUrl: string,
  opts: ExtractOptions = {},
): Promise<ExtractResult> {
  const first = extractFirstUrl(rawUrl) ?? rawUrl.trim();
  const { url } = normalizeUrl(first);
  const kind = routeUrl(url);
  switch (kind) {
    case "x":
      return extractX(fetcher, url, opts);
    case "wechat":
      return extractWeChat(fetcher, url, opts);
    case "xhs":
      return extractXhs(fetcher, url, { ...opts, cookie: opts.xhsCookie });
    case "toutiao":
      return extractToutiao(fetcher, url, opts);
    default:
      return extractGenericWeb(fetcher, url, opts);
  }
}
