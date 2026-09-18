/** 探测第二轮：确认 note_tweet 与 article 的精确字段结构 */
const TWEET_ID = "2093012245123067989";
const ART_ID = "2093388974194872781";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function syndToken(id) {
  const n = Number(id);
  return ((n / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
}

async function getJson(name, url) {
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(25000) });
    const text = await r.text();
    console.log(`\n=== ${name} → HTTP ${r.status} ===`);
    return JSON.parse(text);
  } catch (e) {
    console.log(`\n=== ${name} → FAILED: ${e.message} ===`);
    return null;
  }
}

async function main() {
  const s1 = await getJson(
    "syndication (llama_index)",
    `https://cdn.syndication.twimg.com/tweet-result?id=${TWEET_ID}&token=${syndToken(TWEET_ID)}&lang=zh`,
  );
  if (s1?.note_tweet) {
    console.log("[synd note_tweet] 类型:", typeof s1.note_tweet, "| 键:", Object.keys(s1.note_tweet).join(","));
    const t = typeof s1.note_tweet === "string" ? s1.note_tweet : s1.note_tweet.text ?? JSON.stringify(s1.note_tweet);
    console.log("[synd note_tweet] 全文长度:", t.length, "| 末尾60字:", JSON.stringify(String(t).slice(-60)));
  }
  if (s1?.mediaDetails) {
    console.log("[synd mediaDetails]", JSON.stringify(s1.mediaDetails.map((m) => ({ type: m.type, url: m.media_url_https }))).slice(0, 300));
  }

  const f2 = await getJson("fxtwitter (article)", `https://api.fxtwitter.com/status/${ART_ID}`);
  if (f2?.tweet?.article) {
    const a = f2.tweet.article;
    console.log("[fxtwitter article] 全部键:", Object.keys(a).join(","));
    for (const k of Object.keys(a)) {
      const v = a[k];
      const s = typeof v === "string" ? v : JSON.stringify(v);
      console.log(`  - ${k}: ${s.slice(0, 160)}`);
    }
  }
  const f1 = await getJson("fxtwitter (llama_index)", `https://api.fxtwitter.com/status/${TWEET_ID}`);
  if (f1?.tweet) {
    const t = f1.tweet;
    console.log("[fxtwitter tweet] text长度:", (t.text || "").length, "| raw_text长度:", (t.raw_text || "").length);
    console.log("[fxtwitter tweet] is_note_tweet:", t.is_note_tweet, "| photos:", JSON.stringify((t.media?.photos || []).map((p) => p.url)).slice(0, 200));
    console.log("[fxtwitter tweet] 末尾80字:", JSON.stringify((t.text || "").slice(-80)));
  }
}

main();
