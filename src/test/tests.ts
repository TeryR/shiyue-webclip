/**
 * 识玥网页剪藏 - 离线固定样例测试
 * 不访问网络：用夹具 Fetcher 模拟各平台响应，验证提取/分类/落盘前的全部核心逻辑。
 */
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
(globalThis as unknown as { DOMParser: typeof DOMParser }).DOMParser =
  dom.window.DOMParser as unknown as typeof DOMParser;

import { parseTweetUrl, extractX } from "../extract/x";
import { extractWeChat } from "../extract/wechat";
import { extractXhs } from "../extract/xhs";
import { extractGenericWeb } from "../extract/generic";
import { extractToutiao, parseToutiaoUrl } from "../extract/toutiao";
import { routeUrl } from "../extract";
import { parseRules, classifyByRules, mergeClassification } from "../classify";
import { isMostlyEnglish, translateWithLlm } from "../translate";
import { sanitizeFilename, normalizeUrl, parseTwitterDate, formatDateTime, resolveDuplicate, normalizeLlmEndpoint } from "../util";
import { domToMarkdown } from "../dommd";
import { buildFilename, buildNote } from "../notebuild";
import type { Fetcher, FetchedPage, ExtractResult, ClassResult } from "../types";

/* ---------------- 夹具 ---------------- */

interface FixturePage {
  status?: number;
  finalUrl?: string;
  text: string;
}
const FIXTURES: { match: RegExp; page: FixturePage }[] = [
  {
    match: /cdn\.syndication\.twimg\.com\/tweet-result\?id=1234567890123456789/,
    page: {
      text: JSON.stringify({
        __typename: "Tweet",
        text: "完整推文文本：时间线截断版。",
        created_at: "Sat Aug 29 12:00:00 +0000 2026",
        user: { name: "张三", screen_name: "zhangsan" },
        photos: [{ url: "https://pbs.twimg.com/media/test.jpg" }],
        note_tweet: { id: "NoteTweetResults:1" },
      }),
    },
  },
  {
    match: /api\.fxtwitter\.com\/status\/1234567890123456789/,
    page: {
      text: JSON.stringify({
        tweet: {
          text: "完整推文文本：这是 note_tweet 全文版本。",
          author: { name: "张三", screen_name: "zhangsan" },
          created_at: "Sat Aug 29 12:00:00 +0000 2026",
          is_note_tweet: true,
          media: { photos: [{ url: "https://pbs.twimg.com/media/test.jpg?name=orig" }] },
        },
      }),
    },
  },
  {
    match: /api\.fxtwitter\.com\/status\/9999/,
    page: {
      text: JSON.stringify({
        tweet: {
          text: "fxtwitter 兜底推文内容",
          author: { name: "王五", screen_name: "wangwu" },
          created_at: "Sat Aug 29 10:00:00 +0000 2026",
          media: { photos: [{ url: "https://p.fxtwitter.com/x.jpg?name=orig" }] },
        },
      }),
    },
  },
  {
    match: /cdn\.syndication\.twimg\.com\/tweet-result\?id=8888/,
    page: {
      text: JSON.stringify({
        __typename: "Tweet",
        text: "NEW ARTICLE IS UP",
        user: { name: "张三", screen_name: "zhangsan" },
        article: {},
      }),
    },
  },
  {
    match: /api\.fxtwitter\.com\/status\/8888/,
    page: {
      text: JSON.stringify({
        tweet: {
          text: "NEW ARTICLE IS UP",
          author: { name: "张三", screen_name: "zhangsan" },
          article: { title: "测试长文标题", preview_text: "这是文章预览第一段。" },
        },
      }),
    },
  },
  {
    match: /cdn\.syndication\.twimg\.com\/tweet-result\?id=8899/,
    page: {
      text: JSON.stringify({
        __typename: "Tweet",
        text: "teaser for 8899",
        user: { name: "张三", screen_name: "zhangsan" },
      }),
    },
  },
  {
    match: /api\.fxtwitter\.com\/status\/8899/,
    page: {
      text: JSON.stringify({
        tweet: {
          text: "teaser for 8899",
          author: { name: "张三", screen_name: "zhangsan" },
          article: {
            title: "AI Skills Map",
            created_at: "2026-08-28T12:00:00.000Z",
            content: {
              blocks: [
                { type: "header-one", text: "第一章" },
                { type: "unstyled", text: "Read the docs.", entityRanges: [{ offset: 5, length: 3, key: "0" }] },
              ],
              entityMap: { "0": { type: "LINK", data: { url: "https://docs.example/x" } } },
            },
            cover_media: { media_info: { original_img_url: "https://p.fxtwitter.com/cover.jpg" } },
          },
        },
      }),
    },
  },
  {
    match: /cdn\.syndication\.twimg\.com\/tweet-result\?id=9999/,
    page: { status: 404, text: "" },
  },
  {
    match: /publish\.twitter\.com\/oembed/,
    page: {
      text: JSON.stringify({
        html: '<blockquote class="twitter-tweet"><p lang="zh" dir="ltr">oembed 兜底推文内容</p>&mdash; 李四 (@lisi) <a href="https://twitter.com/testuser/status/9999">2026</a></blockquote>',
        author_name: "李四",
        author_url: "https://twitter.com/lisi",
      }),
    },
  },
  {
    match: /mp\.weixin\.qq\.com\/s\/good/,
    page: {
      text: `<!doctype html><html><head><meta property="og:title" content="og回退标题"></head><body>
<h1 id="activity-name">如何搭建个人知识库</h1>
<a id="js_name">测试公众号</a>
<script>var ct = "1756464000";</script>
<div id="js_content">
<p>段落一：收集是学习的开始。</p>
<p><strong>重点</strong>：要坚持。<a href="https://example.com/rel">相关阅读</a></p>
<p><img src="" data-src="https://mmbiz.qpic.cn/mmbiz/a.jpg"></p>
<ul><li>要点一</li><li>要点二</li></ul>
<blockquote>公众号引用文本</blockquote>
</div></body></html>`,
    },
  },
  {
    match: /mp\.weixin\.qq\.com\/s\/deleted/,
    page: { text: "<html><body>该内容已被发布者删除</body></html>" },
  },
  {
    match: /mp\.weixin\.qq\.com\/s\/risky/,
    page: { text: "<html><body>当前环境异常，完成验证后即可继续访问。</body></html>" },
  },
  {
    match: /xiaohongshu\.com\/explore\/abc123456789012345678901/,
    page: {
      text: `<html><body><script>window.__INITIAL_STATE__={"note":{"noteDetailMap":{"abc123456789012345678901":{"note":{"note":{"title":"测试小红书标题","desc":"正文内容描述\\n第二行","time":1756464000000,"user":{"nickname":"作者昵称"},"imageList":[{"urlDefault":"https://sns-img.example/1.jpg"},{"url":"https://sns-img.example/2.jpg"}]}},"comments":undefined}}}};</script></body></html>`,
    },
  },
  {
    match: /xiaohongshu\.com\/explore\/0123456789abcdef0123456a/,
    page: { status: 461, text: "<html><body>当前笔记暂时无法浏览</body></html>" },
  },
  {
    match: /news\.example\.com\/news\/1/,
    page: {
      finalUrl: "https://news.example.com/news/1",
      text: `<!doctype html><html><head><title>新闻站标题</title>
<meta property="og:title" content="深度报道：某项技术的来龙去脉">
<meta property="og:site_name" content="科技晨报">
<meta name="author" content="记者小王">
<meta property="article:published_time" content="2026-08-28T09:00:00+08:00">
</head><body><nav>导航 首页 栏目</nav>
<article>
<h1>深度报道：某项技术的来龙去脉</h1>
<p>第一段：这是一则新闻正文，需要有足够的内容让提取器命中主体区域，所以这里写了很长的一段话来凑足字数，确保超过一百二十个字符的阈值，让正文过短的告警不会出现，验证可以顺利通过，同时也测试加粗和链接等行内元素的转换效果。</p>
<p>第二段：<strong>关键信息</strong> <a href="https://news.example.com/full">阅读原文</a>。</p>
<ul><li>要点一</li><li>要点二</li></ul>
<img src="/img/cover.png">
<blockquote>专家评论内容。</blockquote>
</article>
<footer>版权所有</footer></body></html>`,
    },
  },
  {
    match: /m\.toutiao\.com\/i7238487463444972084/,
    page: {
      text: `<html><head><title>今日头条和头条号究竟有什么区别 - 今日头条</title></head><body>
<article>
<p data-track="1">段落一：<span style="color:red">重点内容</span>。这是正文的开头部分，介绍文章的背景与主题。</p>
<p data-track="2">段落二：展开说明核心观点，并且给出具体的例子与操作步骤，让读者可以跟着动手实践。</p>
<blockquote class="pgc-blockquote-abstract"><p>引用段</p></blockquote>
<img src="https://p3-sign.toutiaoimg.com/img1~tplv-tt-cs0:640:360.jpeg">
<script>x</script>
</article>
${encodeURIComponent('"articleInfo":{"title":"今日头条和头条号究竟有什么区别","publishTime":"1687527219","media_name":"测试作者"}')}
</body></html>`,
    },
  },
  {
    match: /xhslink\.com\/short1/,
    page: {
      finalUrl: "https://www.xiaohongshu.com/explore/abc123456789012345678901?xsec_token=T&xsec_source=pc_user",
      text: "",
    },
  },
];

const TR_CFG = {
  endpoint: "https://api.example.com/v1/chat/completions",
  apiKey: "test-key",
  model: "test-model",
  timeoutMs: 5000,
};

const fixtureFetcher: Fetcher = {
  async fetchText(url: string): Promise<FetchedPage> {
    const hit = FIXTURES.find((f) => f.match.test(url));
    if (!hit) return { url, finalUrl: url, status: 0, text: "", headers: {} };
    return {
      url,
      finalUrl: hit.page.finalUrl ?? url,
      status: hit.page.status ?? 200,
      text: hit.page.text,
      headers: {},
    };
  },
  async fetchBinary(): Promise<ArrayBuffer> {
    return new ArrayBuffer(0);
  },
  async postJson(): Promise<{ status: number; json: unknown }> {
    return { status: 200, json: {} };
  },
};

/* ---------------- 断言器 ---------------- */

let passed = 0;
const failures: string[] = [];
function ok(cond: boolean, name: string): void {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failures.push(name);
    console.log(`  ❌ ${name}`);
  }
}
function eq(actual: unknown, expected: unknown, name: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(a === e, `${name} (期望 ${e}, 实际 ${a})`);
}

/* ---------------- 用例 ---------------- */

async function runAll(): Promise<void> {
  console.log("\n[1] URL 识别与规范化");
  eq(routeUrl("https://x.com/user/status/1"), "x", "x.com → x");
  eq(routeUrl("https://twitter.com/user/status/1"), "x", "twitter.com → x");
  eq(routeUrl("https://mp.weixin.qq.com/s/abc"), "wechat", "mp.weixin.qq.com → wechat");
  eq(routeUrl("https://www.xiaohongshu.com/explore/abc"), "xhs", "xiaohongshu → xhs");
  eq(routeUrl("https://news.example.com/a"), "web", "其他 → web");
  eq(routeUrl("https://www.toutiao.com/article/123/"), "toutiao", "toutiao.com → toutiao");
  eq(routeUrl("https://m.toutiao.com/i123/"), "toutiao", "m.toutiao.com → toutiao");
  eq(parseTweetUrl("https://x.com/testuser/status/1234567890123456789"), { user: "testuser", id: "1234567890123456789", isArticle: false }, "推文链接解析");
  eq(parseTweetUrl("https://x.com/AndrewYNg/article/2093388974194872781")?.isArticle, true, "Article 链接识别");
  eq(parseTweetUrl("https://x.com/i/web/status/123"), null, "i/web 路径拒绝");
  eq(parseTweetUrl("https://x.com/testuser"), null, "非推文链接拒绝");

  const n1 = normalizeUrl("https://News.Example.com/a/1?utm_source=x&id=9&spm=1");
  eq(n1.url, "https://news.example.com/a/1?id=9", "去追踪参数 + 域名小写");
  const n2 = normalizeUrl("https://www.xiaohongshu.com/explore/abc?xsec_token=T&xsec_source=pc_user&utm_source=share");
  ok(n2.url.includes("xsec_token=T") && n2.url.includes("xsec_source=pc_user") && !n2.url.includes("utm_"), "小红书保留 xsec_token");
  eq(parseTwitterDate("Sat Aug 29 12:00:00 +0000 2026"), "2026-08-29 20:00", "Twitter 时间解析(+08)");
  eq(formatDateTime(1756464000000).slice(0, 10), "2025-08-29", "毫秒时间戳格式化");

  console.log("\n[2] 文件名清洗");
  eq(sanitizeFilename('a/b\\c:d*e?f"g<h>i|j'), "a b c d e f g h i j", "非法字符清洗");
  ok(sanitizeFilename("标题".repeat(100)).length <= 90, "长度截断到90");

  console.log("\n[3] DOM → Markdown");
  const mdDoc = new DOMParser().parseFromString(
    "<h1>标题</h1><p>hello <strong>world</strong> <a href='https://a.b'>链接</a></p><ul><li>一</li><li>二</li></ul><blockquote>引用</blockquote><script>x</script>",
    "text/html",
  );
  const md = domToMarkdown(mdDoc.body);
  ok(md.includes("# 标题"), "标题转换");
  ok(md.includes("**world**"), "加粗转换");
  ok(md.includes("[链接](https://a.b)"), "链接转换");
  ok(md.includes("- 一") && md.includes("- 二"), "列表转换");
  ok(md.includes("> 引用"), "引用转换");
  ok(!md.includes("script"), "script 剔除");

  console.log("\n[4] 自动分类");
  const rules = parseRules(
    "科技/AI | 剪藏/科技 | tech,ai | AI,大模型,开源\n财经 | 剪藏/财经 | finance | 股市,财报\n# 注释行",
  );
  eq(rules.length, 2, "规则解析(跳过注释)");
  const c1 = classifyByRules("开源大模型发布", "AI 大模型性能刷新纪录……", rules);
  ok(c1 !== null && c1.category === "科技/AI" && c1.folder === "剪藏/科技", "关键词命中分类");
  const c2 = classifyByRules("今天的天气", "风和日丽", rules);
  eq(c2, null, "未命中返回 null");
  const merged = mergeClassification(c2, { category: "教育", tags: ["学习"] }, rules, "剪藏/未分类");
  ok(merged.category === "教育" && merged.folder === "剪藏/未分类", "LLM 分类未匹配规则时落到未分类目录");
  const merged2 = mergeClassification(null, null, rules, "剪藏/未分类");
  eq(merged2.category, "未分类", "全兜底 → 未分类");

  console.log("\n[5] X(Twitter) 提取");
  const x1 = await extractX(fixtureFetcher, "https://x.com/testuser/status/1234567890123456789");
  ok(x1.contentText.includes("note_tweet 全文版本"), "长推文取 fxtwitter 全文（非 syndication 截断版）");
  eq(x1.author, "张三", "作者");
  eq(x1.images, ["https://pbs.twimg.com/media/test.jpg?name=orig"], "配图(orig 高清)");
  ok((x1.publishTime ?? "").startsWith("2026-08-29"), "时间");
  ok(x1.warnings.some((w) => w.includes("长推文")), "长推文告警");

  const xf = await extractX(fixtureFetcher, "https://twitter.com/testuser/statuses/9999");
  ok(xf.contentText.includes("fxtwitter 兜底推文内容"), "fxtwitter 兜底正文");
  eq(xf.author, "王五", "fxtwitter 作者");
  ok((xf.publishTime ?? "").startsWith("2026-08-29"), "fxtwitter 时间");
  ok(xf.images.includes("https://p.fxtwitter.com/x.jpg?name=orig"), "fxtwitter 配图(orig 高清)");

  const x2 = await extractX(fixtureFetcher, "https://twitter.com/testuser/statuses/7777");
  ok(x2.contentText.includes("oembed 兜底推文内容"), "oembed 兜底正文");
  eq(x2.author, "李四", "oembed 作者");
  ok(x2.warnings.length >= 1, "oembed 缺时间/图片时给出告警");

  const xa = await extractX(fixtureFetcher, "https://x.com/testuser/status/8888");
  ok(xa.warnings.some((w) => w.includes("长文")), "Article 无全文时明确告警");
  ok(xa.contentText.includes("《测试长文标题》"), "附文章标题与预览");

  const xb = await extractX(fixtureFetcher, "https://x.com/AndrewYNg/article/8899000000000000");
  eq(xb.title, "AI Skills Map", "Article 模式标题取文章标题");
  ok(xb.contentText.includes("## 第一章"), "Article blocks 标题转换");
  ok(xb.contentText.includes("[the](https://docs.example/x)"), "Article 链接实体还原");
  ok(xb.images.includes("https://p.fxtwitter.com/cover.jpg"), "Article 封面图");
  ok((xb.publishTime ?? "").startsWith("2026-08-28"), "Article 发布时间");

  console.log("\n[6] 微信公众号提取");
  const w1 = await extractWeChat(fixtureFetcher, "https://mp.weixin.qq.com/s/good");
  eq(w1.title, "如何搭建个人知识库", "标题");
  eq(w1.author, "测试公众号", "作者");
  ok((w1.publishTime ?? "").startsWith("2025-08-29"), "var ct 时间戳");
  ok(w1.contentMarkdown?.includes("**重点**"), "正文加粗保留");
  ok(w1.contentMarkdown?.includes("![图片](https://mmbiz.qpic.cn/mmbiz/a.jpg)"), "懒加载图重写");
  ok(w1.images.includes("https://mmbiz.qpic.cn/mmbiz/a.jpg"), "图片收集");
  ok(w1.contentMarkdown?.includes("> 公众号引用文本"), "引用转换");
  let threw = "";
  try {
    await extractWeChat(fixtureFetcher, "https://mp.weixin.qq.com/s/deleted");
  } catch (e) {
    threw = (e as Error).message;
  }
  ok(threw.includes("删除"), "删文检测报错");
  threw = "";
  try {
    await extractWeChat(fixtureFetcher, "https://mp.weixin.qq.com/s/risky");
  } catch (e) {
    threw = (e as Error).message;
  }
  ok(threw.includes("环境异常"), "风控检测报错");

  console.log("\n[7] 小红书提取");
  const h1 = await extractXhs(fixtureFetcher, "https://www.xiaohongshu.com/explore/abc123456789012345678901?xsec_token=T&xsec_source=pc_user");
  eq(h1.title, "测试小红书标题", "标题");
  eq(h1.author, "作者昵称", "作者");
  ok(h1.contentText.includes("正文内容描述"), "正文");
  ok((h1.publishTime ?? "").startsWith("2025-08-29"), "发布时间");
  eq(h1.images.length, 2, "图片数量");
  const h2 = await extractXhs(fixtureFetcher, "https://xhslink.com/short1");
  ok(h2.url.includes("/explore/abc123456789012345678901"), "短链解析为长链");
  threw = "";
  try {
    await extractXhs(fixtureFetcher, "https://www.xiaohongshu.com/explore/0123456789abcdef0123456a");
  } catch (e) {
    threw = (e as Error & { userMessage?: string }).userMessage ?? (e as Error).message;
  }
  ok(threw.includes("Cookie"), "登录墙明确提示配 Cookie");

  console.log("\n[7b] 今日头条提取");
  eq(parseToutiaoUrl("https://www.toutiao.com/article/7238487463444972084/")?.id, "7238487463444972084", "桌面文章链接解析");
  eq(parseToutiaoUrl("https://m.toutiao.com/i7238487463444972084/")?.id, "7238487463444972084", "移动链接解析");
  eq(parseToutiaoUrl("https://www.toutiao.com/w/1770000000000000/"), null, "微头条不支持");
  const tt = await extractToutiao(fixtureFetcher, "https://www.toutiao.com/article/7238487463444972084/");
  eq(tt.title, "今日头条和头条号究竟有什么区别", "标题（来自 SSR articleInfo）");
  eq(tt.author, "测试作者", "作者");
  ok((tt.publishTime ?? "").startsWith("2023-06-23"), "发布时间");
  ok(tt.contentMarkdown?.includes("段落一：重点内容。"), "正文（span 内联样式剔除）");
  ok(tt.contentMarkdown?.includes("> 引用段"), "引用转换");
  ok(tt.images.includes("https://p3-sign.toutiaoimg.com/img1~tplv-tt-cs0:640:360.jpeg"), "图片收集");
  let ttErr = "";
  try {
    await extractToutiao(fixtureFetcher, "https://www.toutiao.com/w/1770000000000000/");
  } catch (e) {
    ttErr = (e as Error & { userMessage?: string }).userMessage ?? (e as Error).message;
  }
  ok(ttErr.includes("手动粘贴") || ttErr.includes("暂不支持"), "微头条明确报错引导");

  console.log("\n[8] 普通网页提取");
  const g1 = await extractGenericWeb(fixtureFetcher, "https://news.example.com/news/1");
  ok(g1.title.includes("深度报道"), "Readability 标题");
  eq(g1.author, "记者小王", "作者");
  ok((g1.publishTime ?? "").startsWith("2026-08-28"), "发布时间");
  ok(g1.contentMarkdown?.includes("深度报道：某项技术的来龙去脉"), "正文命中");
  ok(g1.contentMarkdown?.includes("**关键信息**"), "行内元素保留");
  ok(g1.images.includes("https://news.example.com/img/cover.png"), "相对路径图片转绝对");
  ok(!g1.contentText.includes("版权所有"), "页脚剔除");

  console.log("\n[9] 笔记组装");
  const fakeResult: ExtractResult = {
    source: "xhs",
    url: "https://www.xiaohongshu.com/explore/abc",
    title: '测试"标题"',
    author: "作者",
    publishTime: "2025-08-29 20:00",
    siteName: "小红书",
    contentText: "正文内容",
    excerpt: "正文内容",
    images: ["https://sns-img.example/1.jpg"],
    warnings: ["测试告警"],
  };
  const cls: ClassResult = { category: "生活", folder: "剪藏/生活", tags: ["life"], via: "rules" };
  const note = buildNote(
    fakeResult,
    cls,
    { filenameTemplate: "{{date}} {{title}}", appendSourceLink: false, useWikilinks: true },
    new Map([["https://sns-img.example/1.jpg", "剪藏/附件/img-01.jpg"]]),
  );
  ok(note.startsWith("---\n"), "frontmatter 开头");
  ok(note.includes('category: "生活"'), "分类写入 frontmatter");
  ok(note.includes('source: "小红书"'), "来源写入 frontmatter");
  ok(note.includes('status: "partial"'), "有告警时状态为 partial");
  ok(note.includes("![[剪藏/附件/img-01.jpg]]"), "图片本地链接替换");
  ok(note.includes("> - 测试告警"), "告警 callout");
  ok(note.includes("[!quote] 来源信息"), "来源信息 callout");
  const fn = buildFilename("{{date}} {{source}} {{title}}", { title: "我的:标题", sourceLabel: "小红书" });
  ok(/^\d{4}-\d{2}-\d{2} 小红书 我的 标题$/.test(fn), `文件名模板渲染(${fn})`);

  console.log("\n[10] 英文检测与 LLM 翻译");
  ok(isMostlyEnglish("This is a long English article about technology and design. ".repeat(5)), "英文正文判定");
  ok(
    !isMostlyEnglish(
      "这是一篇中文文章，主要内容都是中文，只是夹杂少量 English 缩写如 AI、LLM、UX 等术语，但整体判断应当是中文而不是英文。".repeat(3),
    ),
    "中文正文判定",
  );
  ok(isMostlyEnglish("This is an English article with occasional Chinese words like 你好 and 谢谢."), "英文为主夹中文判定");
  ok(!isMostlyEnglish("short"), "过短不判定");
  ok(!isMostlyEnglish(""), "空文本不判定");

  let trCalls = 0;
  const trOkFetcher: Fetcher = {
    ...fixtureFetcher,
    async postJson(): Promise<{ status: number; json: unknown }> {
      trCalls += 1;
      return {
        status: 200,
        json: {
          choices: [{
            message: {
              content: JSON.stringify({ title_zh: "测试中文标题", content_zh: "【译文】翻译内容" }),
            },
          }],
        },
      };
    },
  };
  const tr1 = await translateWithLlm(trOkFetcher, TR_CFG, "Hello", "Hello world. ".repeat(100));
  ok(tr1.ok && tr1.titleZh === "测试中文标题", "翻译成功返回中文标题");
  ok(tr1.ok && tr1.contentZh.includes("【译文】"), "翻译成功返回译文");
  ok(tr1.ok && !tr1.truncated, "短文不截断");

  trCalls = 0;
  const tr2 = await translateWithLlm(trOkFetcher, TR_CFG, "Hello", "Hello world. ".repeat(600));
  eq(trCalls, 3, "长文按 3800 字符分块调用");
  ok(tr2.ok && !tr2.truncated, "7800 字符全文覆盖");

  trCalls = 0;
  const hugeText = "Hello world. ".repeat(3000);
  const tr3 = await translateWithLlm(trOkFetcher, TR_CFG, "Hello", hugeText);
  eq(trCalls, 8, "超长文最多 8 块");
  ok(tr3.ok && tr3.truncated && tr3.coveredChars < hugeText.length, "超长文标记截断且给出覆盖长度");

  const trBadFetcher: Fetcher = {
    ...fixtureFetcher,
    async postJson(): Promise<{ status: number; json: unknown }> {
      return { status: 500, json: null };
    },
  };
  const tr4 = await translateWithLlm(trBadFetcher, TR_CFG, "Hello", "Hello world. ".repeat(100));
  ok(!tr4.ok && tr4.reason.includes("500"), "接口 500 → 原因含状态码");

  const trJunkFetcher: Fetcher = {
    ...fixtureFetcher,
    async postJson(): Promise<{ status: number; json: unknown }> {
      return { status: 200, json: { choices: [{ message: { content: "抱歉我不能翻译" } }] } };
    },
  };
  const tr5 = await translateWithLlm(trJunkFetcher, TR_CFG, "Hello", "Hello world. ".repeat(100));
  ok(!tr5.ok && tr5.reason.includes("JSON"), "返回非 JSON → 原因说明");

  console.log("\n[10b] 接口地址规范化");
  eq(normalizeLlmEndpoint("https://api.openai.com/v1/chat/completions"), "https://api.openai.com/v1/chat/completions", "完整地址不变");
  eq(normalizeLlmEndpoint("https://api.deepseek.com"), "https://api.deepseek.com/chat/completions", "base 地址自动补全");
  eq(normalizeLlmEndpoint("https://api.example.com/v1/"), "https://api.example.com/v1/chat/completions", "尾斜杠 + v1 补全");

  console.log("\n[11] 翻译笔记组装");
  const enResult: ExtractResult = {
    source: "web",
    url: "https://news.example.com/en/1",
    title: "Original English Title",
    contentMarkdown: "Original English paragraph.",
    contentText: "Original English paragraph.",
    excerpt: "Original English paragraph.",
    images: [],
    warnings: [],
    translation: { titleZh: "英文标题的中文翻译", contentZh: "中文翻译段落内容。" },
  };
  const noteEn = buildNote(
    enResult,
    { category: "科技/AI", folder: "剪藏/科技", tags: ["tech"], via: "rules" },
    { filenameTemplate: "{{date}} {{title}}", appendSourceLink: false, useWikilinks: true },
  );
  ok(noteEn.includes('title: "英文标题的中文翻译"'), "frontmatter 标题为译文");
  ok(noteEn.includes('original_title: "Original English Title"'), "frontmatter 保留原英文标题");
  ok(noteEn.includes("## 中文翻译") && noteEn.includes("中文翻译段落内容。"), "译文段落");
  ok(noteEn.includes("## 原文") && noteEn.includes("Original English paragraph."), "原文完整保留");

  console.log("\n[12] 重复链接决策");
  eq(resolveDuplicate("reclip", false), "reclip", "总是重新剪藏(批量)");
  eq(resolveDuplicate("reclip", true), "reclip", "总是重新剪藏(单个)");
  eq(resolveDuplicate("skip", true), "skip", "总是跳过");
  eq(resolveDuplicate("ask", true), "ask", "询问模式(单个)→弹窗");
  eq(resolveDuplicate("ask", false), "skip", "询问模式(批量)→自动跳过");
}

runAll()
  .then(() => {
    console.log(`\n======== 测试结果：通过 ${passed} 项，失败 ${failures.length} 项 ========`);
    if (failures.length) {
      console.error("失败用例：", failures);
      process.exit(1);
    }
    process.exit(0);
  })
  .catch((e) => {
    console.error("测试执行异常：", e);
    process.exit(1);
  });
