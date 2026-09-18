import { ClipError } from "./errors";

export function clamp(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

/** 清洗成合法的 Obsidian 文件名 */
export function sanitizeFilename(name: string, maxLen = 90): string {
  let s = (name || "").replace(/[\\/:*?"<>|#^[\]]/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  s = s.replace(/^[.\s]+|[.\s]+$/g, "");
  if (s.length > maxLen) s = s.slice(0, maxLen).trim();
  return s || "未命名";
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function todayStr(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function fullTimestamp(d: Date = new Date()): string {
  return `${todayStr(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function formatDateTime(ms: number): string {
  return fullTimestamp(new Date(ms)).slice(0, 16);
}

/** 解析 Twitter 的时间格式：Fri Aug 29 12:00:00 +0000 2026 */
export function parseTwitterDate(s: string): string | undefined {
  if (!s) return undefined;
  const MONTHS: Record<string, number> = {
    Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6,
    Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12,
  };
  const parts = s.trim().split(/\s+/);
  if (parts.length !== 6) return undefined;
  const mon = MONTHS[parts[1]];
  const day = parseInt(parts[2], 10);
  const time = parts[3].split(":").map((x) => parseInt(x, 10));
  const tz = parts[4];
  const year = parseInt(parts[5], 10);
  if (!mon || isNaN(day) || isNaN(year) || time.length < 3) return undefined;
  const utc = Date.UTC(year, mon - 1, day, time[0], time[1], time[2]);
  let offMin = 0;
  const m = tz.match(/^([+-])(\d{2})(\d{2})$/);
  if (m) {
    offMin = (m[1] === "-" ? -1 : 1) * (parseInt(m[2], 10) * 60 + parseInt(m[3], 10));
  }
  return formatDateTime(utc - offMin * 60000);
}

/** YAML 双引号字符串转义 */
export function escapeYaml(s: string): string {
  return (
    '"' +
    String(s)
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\r?\n/g, " ") +
    '"'
  );
}

const TRACKING_KEYS = [
  "spm", "spm_id_from", "vd_source", "vd_type", "share_token", "share_id",
  "share_medium", "share_plat", "share_from", "share_source", "app_platform",
  "client_version", "x_link_click_time", "ref", "referer", "scene",
  "share_app_id", "share_link_id", "entry", "entrytime", "entrytype",
  "wxshare", "from_timeline", "isappinstalled",
];

/** 从任意文本中提取第一个 http(s) 链接 */
export function extractFirstUrl(text: string): string | null {
  const m = (text || "").match(/https?:\/\/[^\s<>"')\]]+/i);
  return m ? m[0] : null;
}

/**
 * 规范化链接：去 hash、去追踪参数、小写域名。
 * 返回 url（用于抓取）与 key（用于去重索引）。
 * 小红书保留 xsec_token / xsec_source（拿正文必需）。
 */
export function normalizeUrl(raw: string): { url: string; key: string } {
  const first = extractFirstUrl(raw) ?? raw.trim();
  let u: URL;
  try {
    u = new URL(first);
  } catch {
    return { url: first, key: first };
  }
  u.hash = "";
  u.hostname = u.hostname.toLowerCase();
  const host = u.hostname;
  const keep = /(^|\.)(xiaohongshu\.com|xhslink\.com)$/.test(host)
    ? ["xsec_token", "xsec_source"]
    : [];
  const keys = Array.from(u.searchParams.keys());
  for (const k of keys) {
    const lk = k.toLowerCase();
    const isTrack = TRACKING_KEYS.includes(lk) || lk.startsWith("utm_");
    if (isTrack && !keep.includes(lk)) u.searchParams.delete(k);
  }
  const url = u.toString();
  return { url, key: url };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function withTimeout<T>(p: Promise<T>, ms: number, label = "请求"): Promise<T> {
  if (!ms || ms <= 0) return p;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new ClipError(
          `${label}超时(${ms}ms)`,
          `${label}超时。可在设置里调大「请求超时毫秒数」后重试；若反复超时，说明目标站点拒绝了本机网络访问。`,
        ),
      );
    }, ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export function absoluteUrl(src: string, baseUrl: string): string | null {
  if (!src) return null;
  try {
    return new URL(src, baseUrl).href;
  } catch {
    return null;
  }
}

export type DuplicateAction = "ask" | "skip" | "reclip";

/** LLM 接口地址规范化：兼容完整 chat/completions 地址和 base 地址（自动补 /chat/completions） */
export function normalizeLlmEndpoint(raw: string): string {
  const s = (raw || "").trim().replace(/\/+$/, "");
  if (!s) return s;
  if (/\/chat\/completions$/i.test(s)) return s;
  return `${s}/chat/completions`;
}

/** 重复链接决策：ask 模式仅单个剪藏时弹窗询问，批量一律跳过 */
export function resolveDuplicate(
  action: DuplicateAction,
  interactive: boolean,
): "reclip" | "ask" | "skip" {
  if (action === "reclip") return "reclip";
  if (action === "ask") return interactive ? "ask" : "skip";
  return "skip";
}

export function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 把 __INITIAL_STATE__ 里的 undefined 字面量清洗成 null 再 parse（兼容尾部分号） */
export function parseInitState(raw: string): unknown {
  const body = raw.trim().replace(/;\s*$/, "");
  try {
    return JSON.parse(body);
  } catch {
    /* 继续降级处理 */
  }
  const cleaned = body.replace(/\bundefined\b(?=\s*[,}\]])/g, "null");
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}
