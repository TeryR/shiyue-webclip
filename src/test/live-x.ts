/** 真实端到端验证：用 node fetch 实现同款 Fetcher，跑 extractX 处理用户提供的真实链接 */
import { extractX } from "../extract/x";
import type { Fetcher } from "../types";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const nodeFetcher: Fetcher = {
  async fetchText(url) {
    const r = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json,text/html;q=0.9,*/*;q=0.8" },
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

async function show(label: string, url: string): Promise<void> {
  try {
    const r = await extractX(nodeFetcher, url);
    console.log(`\n===== ${label} =====`);
    console.log("标题:", r.title);
    console.log("作者:", r.author, "| 时间:", r.publishTime ?? "无");
    console.log("正文长度:", r.contentText.length, "字符 | 图片:", r.images.length, "张");
    console.log("告警:", r.warnings.length ? r.warnings.join(" / ") : "无");
    console.log("正文开头:", JSON.stringify(r.contentText.slice(0, 130)));
    console.log("正文结尾:", JSON.stringify(r.contentText.slice(-110)));
  } catch (e) {
    console.log(`\n===== ${label} ===== 失败:`, (e as Error).message);
  }
}

await show("长推文 llama_index", "https://x.com/llama_index/status/2093012245123067989");
await show("X 长文 AndrewYNg", "https://x.com/AndrewYNg/article/2093388974194872781");
