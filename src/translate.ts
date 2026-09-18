import { normalizeLlmEndpoint } from "./util";
import type { Fetcher } from "./types";

/**
 * 英文检测 + LLM 翻译。
 * 设计约束：
 * - 只在 useLlm 开启且填了 API Key 时才会被调用（main.ts 里控制），未开启 LLM 完全不触发；
 * - 长文按段落切块翻译（每块 ≤3800 字符，最多 8 块），避免输出截断；
 * - 失败必须给出具体原因（HTTP 状态/超时/格式），上层写进笔记告警，用户能自查；
 * - 任何异常都返回 ok:false，上层降级为"保留英文原文 + 写告警"，绝不阻塞剪藏。
 */

const CHUNK_SIZE = 3800;
const MAX_CHUNKS = 8;

export interface TranslateConfig {
  endpoint: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

export type TranslateOutcome =
  | { ok: true; titleZh: string; contentZh: string; truncated: boolean; coveredChars: number }
  | { ok: false; reason: string };

/** 启发式判定主要内容是否为英文：ASCII 字母占比远高于 CJK 才算 */
export function isMostlyEnglish(text: string): boolean {
  const t = (text || "").slice(0, 4000);
  if (!t) return false;
  const ascii = (t.match(/[A-Za-z]/g) || []).length;
  const cjk = (t.match(/[\u4e00-\u9fff]/g) || []).length;
  if (ascii < 30) return false; // 太短不判定，避免误伤
  if (cjk === 0) return true;
  return ascii >= cjk * 2;
}

/** 按段落切块；单段超长则硬切，最多 max 块 */
export function splitChunks(text: string, size = CHUNK_SIZE, max = MAX_CHUNKS): string[] {
  const paragraphs = text.split(/\n{2,}/);
  const chunks: string[] = [];
  let cur = "";
  for (const p of paragraphs) {
    if (chunks.length >= max) break;
    const pieces =
      p.length > size ? (p.match(new RegExp(`[\\s\\S]{1,${size}}`, "g")) ?? [p]) : [p];
    for (const piece of pieces) {
      if (chunks.length >= max) break;
      const candidate = cur ? cur + "\n\n" + piece : piece;
      if (candidate.length > size && cur) {
        chunks.push(cur);
        cur = piece;
      } else {
        cur = candidate;
      }
    }
    if (cur && cur.length >= size) {
      chunks.push(cur);
      cur = "";
    }
  }
  if (cur && chunks.length < max) chunks.push(cur);
  return chunks.slice(0, max);
}

const SYS_PROMPT =
  "你是专业翻译助手。把输入 JSON 里的字段翻译成简体中文：title 翻译成 title_zh，content 翻译成 content_zh。" +
  "要求：专有名词、品牌名、代码、链接、邮箱保持原样；保持原文的段落结构；译文自然流畅，不要逐字直译。" +
  '只输出一个 JSON 对象 {"title_zh":"...","content_zh":"..."}，不要输出任何其他内容。';

/** 调 OpenAI 兼容接口分块翻译；失败返回 ok:false + 具体原因（上层写进笔记告警） */
export async function translateWithLlm(
  fetcher: Fetcher,
  cfg: TranslateConfig,
  title: string,
  text: string,
): Promise<TranslateOutcome> {
  if (!cfg.endpoint || !cfg.apiKey || !cfg.model) {
    return { ok: false, reason: "未配置接口地址 / API Key / 模型名" };
  }
  if (!text.trim()) return { ok: false, reason: "正文为空" };

  const endpoint = normalizeLlmEndpoint(cfg.endpoint);
  const chunks = splitChunks(text);
  if (!chunks.length) return { ok: false, reason: "正文为空" };
  const coveredChars = chunks.reduce((sum, c) => sum + c.length, 0);
  // 翻译长文比分类慢，超时放宽到至少 60s
  const timeoutMs = Math.max(cfg.timeoutMs, 60000);

  let titleZh = "";
  const translated: string[] = [];

  for (let i = 0; i < chunks.length; i++) {
    try {
      const res = await fetcher.postJson(
        endpoint,
        {
          model: cfg.model,
          temperature: 0.2,
          messages: [
            { role: "system", content: SYS_PROMPT },
            {
              role: "user",
              content: JSON.stringify({
                title: i === 0 ? title : undefined,
                content: chunks[i],
              }),
            },
          ],
        },
        { Authorization: `Bearer ${cfg.apiKey}` },
        timeoutMs,
      );
      if (res.status >= 400 || !res.json) {
        return {
          ok: false,
          reason: `接口返回 HTTP ${res.status || "空"}（请检查 API 地址 / Key / 模型名是否匹配）`,
        };
      }
      const j = res.json as { choices?: { message?: { content?: string } }[] };
      const content = j.choices?.[0]?.message?.content ?? "";
      const m = content.match(/\{[\s\S]*\}/);
      if (!m) {
        return { ok: false, reason: "模型返回内容里没有 JSON（检查模型名是否正确）" };
      }
      let parsed: { title_zh?: unknown; content_zh?: unknown };
      try {
        parsed = JSON.parse(m[0]) as { title_zh?: unknown; content_zh?: unknown };
      } catch {
        return { ok: false, reason: "模型返回的 JSON 解析失败" };
      }
      if (typeof parsed.content_zh !== "string" || !parsed.content_zh.trim()) {
        return { ok: false, reason: "模型返回缺少 content_zh 字段" };
      }
      if (i === 0 && typeof parsed.title_zh === "string" && parsed.title_zh.trim()) {
        titleZh = parsed.title_zh.trim();
      }
      translated.push(parsed.content_zh.trim());
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, reason: `请求异常：${msg}` };
    }
  }

  return {
    ok: true,
    titleZh: titleZh || title,
    contentZh: translated.join("\n\n"),
    truncated: text.length - coveredChars > 200,
    coveredChars,
  };
}
