/** 探测 m.toutiao.com 移动页的正文结构 */
const ARTICLE = "7238487463444972084";
const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

async function main() {
  const r = await fetch(`https://m.toutiao.com/i${ARTICLE}/`, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(30000),
  });
  const html = await r.text();
  console.log(`HTTP ${r.status} | ${html.length} 字符`);

  // <article> 标签内容
  const art = html.match(/<article[^>]*>([\s\S]*?)<\/article>/);
  if (art) {
    const inner = art[1];
    const textLen = inner.replace(/<[^>]+>/g, "").replace(/\s+/g, "").length;
    console.log(`\n<article> 标签: ${inner.length} 字符 | 纯文本 ${textLen} 字`);
    console.log("<article> 开头 400 字:", JSON.stringify(inner.slice(0, 400)));
    console.log("<article> 结尾 200 字:", JSON.stringify(inner.slice(-200)));
    const imgs = inner.match(/<img[^>]+src="([^"]+)"/g) || [];
    console.log("图片数:", imgs.length, "| 首图:", imgs[0]?.slice(0, 120));
  } else {
    console.log("无 <article> 标签");
  }

  // articleInfo 上下文
  const ai = html.indexOf("articleInfo");
  if (ai >= 0) {
    console.log("\narticleInfo 上下文:", JSON.stringify(html.slice(Math.max(0, ai - 80), ai + 500)));
  }

  // 发布时间线索
  for (const pat of [/publish[_-]?time[^,]{0,60}/i, /"pub_time"[^,]{0,40}/i, /datetime="[^"]+"/i]) {
    const m = html.match(pat);
    if (m) console.log("时间线索:", m[0].slice(0, 80));
  }

  // 作者线索
  const author = html.match(/screen_name"[^"]*"([^"]{1,40})"/) || html.match(/media_name"[^"]*"([^"]{1,40})"/);
  console.log("作者线索:", author?.[1] ?? "未找到");
}

main();
