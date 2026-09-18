/** 识玥网页剪藏 - 共享类型定义 */

export type SourceKind = "x" | "wechat" | "xhs" | "web" | "manual" | "toutiao";

export const SOURCE_LABEL: Record<SourceKind, string> = {
  x: "X (Twitter)",
  wechat: "微信公众号",
  xhs: "小红书",
  web: "网页",
  manual: "手动粘贴",
  toutiao: "今日头条",
};

/** 一次 HTTP 抓取的结果（平台无关，便于测试注入） */
export interface FetchedPage {
  url: string;
  finalUrl: string;
  status: number;
  text: string;
  headers: Record<string, string>;
}

export interface FetchOpts {
  headers?: Record<string, string>;
  timeoutMs?: number;
  retries?: number;
}

/** 抓取器接口：插件运行时用 obsidian requestUrl 实现，测试用本地夹具实现 */
export interface Fetcher {
  fetchText(url: string, opts?: FetchOpts): Promise<FetchedPage>;
  fetchBinary(
    url: string,
    opts?: { headers?: Record<string, string>; timeoutMs?: number },
  ): Promise<ArrayBuffer>;
  postJson(
    url: string,
    body: unknown,
    headers?: Record<string, string>,
    timeoutMs?: number,
  ): Promise<{ status: number; json: unknown }>;
}

/** 平台提取器的标准产出 */
export interface ExtractResult {
  source: SourceKind;
  url: string;
  finalUrl?: string;
  title: string;
  author?: string;
  /** YYYY-MM-DD HH:mm */
  publishTime?: string;
  siteName?: string;
  /** web / 微信的正文 Markdown */
  contentMarkdown?: string;
  /** 纯文本正文（分类、预览、X/小红书保存用） */
  contentText: string;
  excerpt: string;
  /** 绝对地址图片列表 */
  images: string[];
  extra?: Record<string, string>;
  /** 非致命告警，会写入笔记的 callout */
  warnings: string[];
  /** LLM 英文翻译（仅 useLlm 开启且正文为英文时由 main.ts 填充） */
  translation?: { titleZh: string; contentZh: string };
}

export interface ClassResult {
  category: string;
  folder: string;
  tags: string[];
  matchedKeywords?: string[];
  via: "rules" | "llm" | "fallback";
}

export interface ClipRecord {
  key: string;
  url: string;
  path: string;
  time: string;
  title: string;
  source: string;
}

export interface BatchResultEntry {
  url: string;
  ok: boolean;
  skipped?: boolean;
  path?: string;
  title?: string;
  reason?: string;
  source?: string;
}

export interface BatchSummary {
  startedAt: string;
  finishedAt: string;
  results: BatchResultEntry[];
  okCount: number;
  failCount: number;
  skipCount: number;
}

export interface ShiyueSettings {
  saveFolder: string;
  attachmentsFolder: string;
  filenameTemplate: string;
  useWikilinks: boolean;
  downloadImages: boolean;
  maxImages: number;
  dedupe: boolean;
  duplicateAction: "ask" | "skip" | "reclip";
  clipboardMode: "confirm" | "instant";
  previewBeforeSave: boolean;
  appendSourceLink: boolean;
  rulesText: string;
  fallbackFolder: string;
  useLlm: boolean;
  llmEndpoint: string;
  llmApiKey: string;
  llmModel: string;
  llmTimeoutMs: number;
  translateWhenLlm: boolean;
  xhsCookie: string;
  requestTimeoutMs: number;
  requestRetries: number;
  concurrency: number;
  interTaskDelayMs: number;
  index: ClipRecord[];
  lastRun: BatchSummary | null;
}
