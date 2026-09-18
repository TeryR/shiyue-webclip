/** 头条号探测：桌面页/移动页是否有 SSR 数据，现有通用提取器实跑效果 */
import { extractGenericWeb } from "../extract/generic";
import type { Fetcher, FetchedPage } from "../types";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const M_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

const ARTICLE = "7238487463444972084"; // 今日头条和头条号究竟有什么区别
const URLS = [
  ["桌面页", `https://www.toutiao.com/article/${ARTICLE}/`, UA],
  ["移动页", `https://m.toutiao.com/i${ARTICLE}/`, M_UA],
];

const fetcher: Fetcher = {
  async fetchText(url, opts): Promise<FetchedPage> {
    const r = await fetch(url, {
      headers: { "User-Agent": opts?.headers?.["User-Agent"] ?? UA, Accept: "text/html,*/*" },
      signal: AbortSignal.timeout(30000),
      redirect: "follow",
    });
    return { url, finalUrl: r.url || url, status: r.status, text: await r.text(), headers: {} };
  },
  async fetchBinary() {
    return new ArrayBuffer(0);
  },
  async postJson() {
    return { status: 500, json: {} };
  },
};

async function main(): Promise<void> {
  for (const [label, url, ua] of URLS) {
    console.log(`\n===== ${label}: ${url} =====`);
    try {
      const r = await fetch(url, { headers: { "User-Agent": ua }, signal: AbortSignal.timeout(30000) });
      const html = await r.text();
      console.log(`HTTP ${r.status} | HTML ${html.length} 字符`);
      for (const marker of ["__INITIAL_STATE__", "SSR_HYDRATED", "articleInfo", "content\",", "js_content", "<article", "og:description"]) {
        console.log(`  含 ${marker}: ${html.includes(marker)}`);
      }
      const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/);
      console.log("  <title>:", (m?.[1] ?? "").trim().slice(0, 60));
      const desc = html.match(/name="description" content="([^"]{0,120})/);
      console.log("  description:", desc?.[1]?.slice(0, 80) ?? "无");
      // 实跑现有通用提取器
      const page = await fetcher.fetchText(url, { headers: { "User-Agent": ua } });
      try {
        const ex = await extractGenericWeb(fetcher, url, {});
        console.log("  [通用提取器] 标题:", ex.title.slice(0, 50));
        console.log("  [通用提取器] 正文长度:", ex.contentText.length, "字符 | 图片:", ex.images.length, "张");
        console.log("  [通用提取器] 正文开头:", JSON.stringify(ex.contentText.slice(0, 100)));
        console.log("  [通用提取器] 告警:", ex.warnings.join(" / ") || "无");
      } catch (e) {
        console.log("  [通用提取器] 失败:", (e as Error).message.slice(0, 120));
      }
    } catch (e) {
      console.log("  请求失败:", (e as Error).message);
    }
  }
}

main();
