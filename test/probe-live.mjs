/**
 * 真实网络探测：用用户提供的两个 X 链接测试各通道能拿到什么。
 * 只读不写，输出关键证据。运行：node test/probe-live.mjs
 */
const TWEET_ID = "2093012245123067989"; // llama_index 长推?
const ART_ID = "2093388974194872781"; // AndrewYNg article
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function syndToken(id) {
  const n = Number(id);
  return ((n / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
}

async function probe(name, url) {
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "*/*" }, signal: AbortSignal.timeout(25000) });
    const text = await r.text();
    console.log(`\n=== ${name} → HTTP ${r.status} (${text.length} chars) ===`);
    return { status: r.status, text };
  } catch (e) {
    console.log(`\n=== ${name} → FAILED: ${e.message} ===`);
    return null;
  }
}

function summarizeJson(label, text, pick) {
  try {
    const j = JSON.parse(text);
    console.log(`[${label}] keys:`, Object.keys(j).slice(0, 12).join(","));
    pick(j);
  } catch (e) {
    console.log(`[${label}] JSON 解析失败: ${e.message}; 前200字:`, text.slice(0, 200));
  }
}

async function main() {
  // 1) 推文：syndication
  const s1 = await probe(
    "syndication tweet-result (llama_index)",
    `https://cdn.syndication.twimg.com/tweet-result?id=${TWEET_ID}&token=${syndToken(TWEET_ID)}&lang=zh`,
  );
  if (s1 && s1.status === 200) {
    summarizeJson("syndication id1", s1.text, (j) => {
      console.log("  text长度:", (j.text || "").length, "| 前120字:", JSON.stringify((j.text || "").slice(0, 120)));
      console.log("  全部键:", Object.keys(j).join(","));
      if (j.note_tweet) console.log("  有 note_tweet!");
      if (j.article) console.log("  有 article 键:", JSON.stringify(j.article).slice(0, 300));
    });
  }

  // 2) 推文：fxtwitter
  const f1 = await probe("fxtwitter (llama_index)", `https://api.fxtwitter.com/status/${TWEET_ID}`);
  if (f1 && f1.status === 200) {
    summarizeJson("fxtwitter id1", f1.text, (j) => {
      const t = j.tweet || {};
      console.log("  text长度:", (t.text || "").length, "| 前120字:", JSON.stringify((t.text || "").slice(0, 120)));
      console.log("  tweet键:", Object.keys(t).join(","));
      console.log("  author:", t.author?.screen_name, "| created_at:", t.created_at);
      console.log("  photos:", (t.media?.photos || []).length, "| videos:", (t.media?.videos || []).length);
    });
  }

  // 3) 推文：oembed
  const o1 = await probe(
    "oembed (llama_index)",
    `https://publish.twitter.com/oembed?url=${encodeURIComponent(`https://twitter.com/i/status/${TWEET_ID}`)}&omit_script=1`,
  );
  if (o1 && o1.status === 200) {
    summarizeJson("oembed id1", o1.text, (j) => {
      const html = j.html || "";
      console.log("  html长度:", html.length, "| 提取文本前120字:", JSON.stringify(html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 120)));
    });
  }

  // 4) Article：syndication（tweet-result 与 article-result 都试）
  const s2 = await probe(
    "syndication tweet-result (article id)",
    `https://cdn.syndication.twimg.com/tweet-result?id=${ART_ID}&token=${syndToken(ART_ID)}&lang=zh`,
  );
  if (s2 && s2.status === 200) {
    summarizeJson("syndication id2", s2.text, (j) => {
      console.log("  全部键:", Object.keys(j).join(","));
      console.log("  text前120字:", JSON.stringify((j.text || "").slice(0, 120)));
    });
  }
  const s2b = await probe(
    "syndication article-result (article id)",
    `https://cdn.syndication.twimg.com/article-result?id=${ART_ID}&token=${syndToken(ART_ID)}&lang=zh`,
  );
  if (s2b && s2b.status === 200) {
    summarizeJson("article-result id2", s2b.text, (j) => {
      console.log("  全部键:", Object.keys(j).join(","));
      console.log("  前300字:", JSON.stringify(JSON.stringify(j).slice(0, 300)));
    });
  }

  // 5) Article：fxtwitter 两种路径
  const f2 = await probe("fxtwitter /status/ (article id)", `https://api.fxtwitter.com/status/${ART_ID}`);
  if (f2 && f2.status === 200) {
    summarizeJson("fxtwitter id2(status)", f2.text, (j) => {
      const t = j.tweet || {};
      console.log("  text长度:", (t.text || "").length, "| 前200字:", JSON.stringify((t.text || "").slice(0, 200)));
      console.log("  tweet键:", Object.keys(t).join(","));
      if (t.article) console.log("  article:", JSON.stringify(t.article).slice(0, 500));
    });
  }
  const f2b = await probe(
    "fxtwitter /article/ (article id)",
    `https://api.fxtwitter.com/AndrewYNg/article/${ART_ID}`,
  );
  if (f2b && f2b.status === 200) {
    summarizeJson("fxtwitter id2(article)", f2b.text, (j) => {
      console.log("  顶层键:", Object.keys(j).join(","));
      console.log("  前300字:", JSON.stringify(JSON.stringify(j).slice(0, 300)));
    });
  }

  // 6) Article：x.com 原始页（看是否登录墙）
  const p2 = await probe("x.com article 原始页", `https://x.com/AndrewYNg/article/${ART_ID}`);
  if (p2) {
    const hasState = /__INITIAL_STATE__/.test(p2.text);
    const loginWall = /login|登录/.test(p2.text.slice(0, 3000));
    console.log(`[x.com page] 含 __INITIAL_STATE__: ${hasState} | 前3000字含login: ${loginWall} | 总长: ${p2.text.length}`);
  }

  // 7) Article：oembed
  const o2 = await probe(
    "oembed (article url)",
    `https://publish.twitter.com/oembed?url=${encodeURIComponent(`https://x.com/AndrewYNg/article/${ART_ID}`)}&omit_script=1`,
  );
  if (o2 && o2.status === 200) {
    summarizeJson("oembed id2", o2.text, (j) => {
      console.log("  html前200字:", JSON.stringify((j.html || "").slice(0, 200)));
    });
  }
}

main();
