/** 真实端到端验证：头条号链接跑 extractToutiao（node fetch + jsdom DOMParser） */
import { JSDOM } from "jsdom";
(globalThis as unknown as { DOMParser: typeof DOMParser }).DOMParser =
  new JSDOM("").window.DOMParser as unknown as typeof DOMParser;

import { extractToutiao } from "../extract/toutiao";
import type { Fetcher } from "../types";

const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

const fetcher: Fetcher = {
  async fetchText(url, opts) {
    const r = await fetch(url, {
      headers: { "User-Agent": opts?.headers?.["User-Agent"] ?? UA, Accept: "text/html,*/*" },
      signal: AbortSignal.timeout(30000),
    });
    return { url, finalUrl: r.url || url, status: r.status, text: await r.text(), headers: {} };
  },
  async fetchBinary() {
    return new ArrayBuffer(0);
  },
  async postJson() {
    return { status: 500, json: null };
  },
};

const url = process.argv[2] ?? "https://www.toutiao.com/article/7238487463444972084/";
try {
  const r = await extractToutiao(fetcher, url);
  console.log("标题:", r.title);
  console.log("作者:", r.author ?? "无", "| 时间:", r.publishTime ?? "无");
  console.log("正文长度:", r.contentText.length, "字符 | 图片:", r.images.length, "张");
  console.log("告警:", r.warnings.join(" / ") || "无");
  console.log("正文开头:", JSON.stringify(r.contentText.slice(0, 120)));
  console.log("正文结尾:", JSON.stringify(r.contentText.slice(-100)));
} catch (e) {
  console.log("失败:", (e as Error & { userMessage?: string }).userMessage ?? (e as Error).message);
  process.exit(1);
}
