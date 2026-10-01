import type { ClassResult, Fetcher } from "./types";
import { normalizeLlmEndpoint } from "./util";

export interface ClassRule {
  name: string;
  folder: string;
  tags: string[];
  keywords: string[];
}

/**
 * 规则格式（每行一条，竖线分隔）：
 * 分类名 | 目标文件夹 | 标签1,标签2 | 关键词1,关键词2
 * 文件夹可省略：默认 `defaultRoot/分类名`（defaultRoot 通常传保存目录）；标签可省略：默认 [分类名]
 */
export function parseRules(text: string, defaultRoot = "剪藏"): ClassRule[] {
  const rules: ClassRule[] = [];
  for (const line of (text || "").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const parts = t.split("|").map((p) => p.trim());
    if (!parts[0]) continue;
    const name = parts[0];
    rules.push({
      name,
      folder: parts[1] || `${defaultRoot}/${name}`,
      tags: parts[2]
        ? parts[2].split(/[,，]/).map((s) => s.trim()).filter(Boolean)
        : [name],
      keywords: parts[3]
        ? parts[3].split(/[,，]/).map((s) => s.trim()).filter(Boolean)
        : [],
    });
  }
  return rules;
}

/**
 * 关键词匹配：纯 ASCII 关键词按整词匹配（\b 词边界，避免 "AI" 误命中
 * "email / training / detail" 这类含 ai 子串的单词）；含中文的关键词按子串匹配。
 */
function makeKeywordTest(kw: string): (hay: string) => boolean {
  if (/^[A-Za-z0-9][A-Za-z0-9.+#_-]*$/.test(kw)) {
    try {
      const re = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
      return (hay) => re.test(hay);
    } catch {
      /* 正则构造失败退回子串 */
    }
  }
  const lw = kw.toLowerCase();
  return (hay) => hay.includes(lw);
}

/** 规则打分：命中关键词最多者胜；同分取靠前的规则（稳定） */
export function classifyByRules(
  title: string,
  contentText: string,
  rules: ClassRule[],
): ClassResult | null {
  const hay = `${title}\n${(contentText || "").slice(0, 4000)}`.toLowerCase();
  let best: { rule: ClassRule; hits: string[] } | null = null;
  for (const rule of rules) {
    if (!rule.keywords.length) continue;
    const tests = rule.keywords.map(makeKeywordTest);
    const hits = rule.keywords.filter((_, i) => tests[i](hay));
    if (!hits.length) continue;
    if (!best || hits.length > best.hits.length) best = { rule, hits };
  }
  if (!best) return null;
  return {
    category: best.rule.name,
    folder: best.rule.folder,
    tags: best.rule.tags.slice(),
    matchedKeywords: best.hits.slice(0, 5),
    via: "rules",
  };
}

/**
 * 可选 LLM 分类（OpenAI 兼容 chat/completions 接口，默认关闭）。
 * 任何异常都返回 null 走规则兜底，绝不因 LLM 挂掉阻塞剪藏。
 */
export async function classifyWithLlm(
  fetcher: Fetcher,
  cfg: { endpoint: string; apiKey: string; model: string; timeoutMs: number },
  title: string,
  contentText: string,
): Promise<{ category: string; tags: string[] } | null> {
  if (!cfg.endpoint || !cfg.apiKey || !cfg.model) return null;
  try {
    const sys =
      "你是知识库自动分类助手。根据标题和正文开头判断分类。只输出 JSON：{\"category\":\"2-6字分类名\",\"tags\":[\"标签1\",\"标签2\"]}，标签最多3个，不要输出其他内容。";
    const res = await fetcher.postJson(
      normalizeLlmEndpoint(cfg.endpoint),
      {
        model: cfg.model,
        temperature: 0.2,
        messages: [
          { role: "system", content: sys },
          {
            role: "user",
            content: `标题：${title}\n正文：${(contentText || "").slice(0, 1500)}`,
          },
        ],
      },
      { Authorization: `Bearer ${cfg.apiKey}` },
      cfg.timeoutMs,
    );
    if (res.status >= 400 || !res.json) return null;
    const j = res.json as { choices?: { message?: { content?: string } }[] };
    const content = j.choices?.[0]?.message?.content ?? "";
    const m = content.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]) as { category?: unknown; tags?: unknown };
    const category = typeof parsed.category === "string" ? parsed.category.trim() : "";
    if (!category) return null;
    const tags = Array.isArray(parsed.tags)
      ? parsed.tags.filter((t): t is string => typeof t === "string").slice(0, 3)
      : [];
    return { category, tags };
  } catch {
    return null;
  }
}

/** 合并规则结果与 LLM 结果：LLM 定分类名，文件夹优先取同名规则的配置，其次规则的命中结果，最后未分类目录 */
export function mergeClassification(
  ruleRes: ClassResult | null,
  llmRes: { category: string; tags: string[] } | null,
  rules: ClassRule[],
  fallbackFolder: string,
): ClassResult {
  if (llmRes) {
    const rule = rules.find((r) => r.name === llmRes.category);
    const tags = Array.from(new Set([...llmRes.tags, ...(ruleRes?.tags ?? [])])).slice(0, 6);
    return {
      category: llmRes.category,
      folder: rule?.folder ?? ruleRes?.folder ?? fallbackFolder,
      tags,
      via: "llm",
    };
  }
  if (ruleRes) return ruleRes;
  return { category: "未分类", folder: fallbackFolder, tags: [], via: "fallback" };
}
