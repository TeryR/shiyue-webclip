import { requestUrl } from "obsidian";
import { ClipError } from "./errors";
import { sleep, withTimeout } from "./util";
import type { FetchedPage, FetchOpts, Fetcher } from "./types";

export const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

/**
 * 基于 Obsidian requestUrl 的抓取器：
 * - 走 Node 网络栈，不受浏览器 CORS 限制（这是 Obsidian 插件能抓网页的关键）
 * - 网络错误 / 5xx / 429 自动重试（4xx 不重试，把状态交给调用方判断）
 * - 超时用 Promise 竞速，避免卡死队列
 */
export function createObsidianFetcher(
  defaultTimeoutMs = 20000,
  defaultRetries = 2,
): Fetcher {
  async function rawFetch(
    url: string,
    headers: Record<string, string> | undefined,
    method: "GET" | "POST",
    body?: string,
  ): Promise<FetchedPage> {
    const res = await requestUrl({
      url,
      method,
      headers: headers ?? {},
      body,
      throw: false,
    });
    const hdrs: Record<string, string> = {};
    try {
      const h = (res as unknown as { headers?: Record<string, string> }).headers ?? {};
      for (const [k, v] of Object.entries(h)) hdrs[String(k).toLowerCase()] = String(v);
    } catch {
      /* header 解析失败不致命 */
    }
    const finalUrl =
      (res as unknown as { url?: string }).url || url;
    return { url, finalUrl, status: res.status, text: res.text, headers: hdrs };
  }

  async function fetchText(url: string, opts?: FetchOpts): Promise<FetchedPage> {
    const timeoutMs = opts?.timeoutMs ?? defaultTimeoutMs;
    const retries = Math.max(0, opts?.retries ?? defaultRetries);
    let last: FetchedPage | null = null;
    let lastErr: unknown = null;
    for (let i = 0; i <= retries; i++) {
      try {
        const page = await withTimeout(
          rawFetch(url, opts?.headers, "GET"),
          timeoutMs,
          "抓取网页",
        );
        if (page.status < 500 && page.status !== 429) return page;
        last = page;
      } catch (e) {
        if (e instanceof ClipError) throw e;
        lastErr = e;
      }
      if (i < retries) await sleep(700 * (i + 1));
    }
    if (last) return last; // 5xx 重试后仍失败：把状态交给上层判断
    throw new ClipError(
      `网络请求失败: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
      "网络请求失败。请检查本机网络/代理是否可用；部分站点需要科学上网（如 x.com）。",
    );
  }

  async function fetchBinary(
    url: string,
    opts?: { headers?: Record<string, string>; timeoutMs?: number },
  ): Promise<ArrayBuffer> {
    const res = await withTimeout(
      requestUrl({
        url,
        method: "GET",
        headers: opts?.headers ?? {},
        throw: false,
      }),
      opts?.timeoutMs ?? defaultTimeoutMs,
      "下载图片",
    );
    if (res.status >= 400) {
      throw new ClipError(`图片下载失败 HTTP ${res.status}: ${url}`);
    }
    const buf = res.arrayBuffer;
    if (!buf || buf.byteLength === 0) {
      throw new ClipError(`图片内容为空: ${url}`);
    }
    return buf;
  }

  async function postJson(
    url: string,
    body: unknown,
    headers?: Record<string, string>,
    timeoutMs?: number,
  ): Promise<{ status: number; json: unknown }> {
    const res = await withTimeout(
      requestUrl({
        url,
        method: "POST",
        headers: { "Content-Type": "application/json", ...(headers ?? {}) },
        body: JSON.stringify(body),
        throw: false,
      }),
      timeoutMs ?? defaultTimeoutMs,
      "API 请求",
    );
    let json: unknown = null;
    try {
      json = res.json;
    } catch {
      json = null;
    }
    return { status: res.status, json };
  }

  return { fetchText, fetchBinary, postJson };
}
