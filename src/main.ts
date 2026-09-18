import { Plugin, Notice, Setting, PluginSettingTab, App } from "obsidian";
import { DEFAULT_SETTINGS, DEFAULT_RULES_TEXT } from "./settings";
import { createObsidianFetcher } from "./fetcher";
import { extractClip, routeUrl } from "./extract";
import { parseRules, classifyByRules, classifyWithLlm, mergeClassification } from "./classify";
import { buildFilename, buildNote } from "./notebuild";
import { isMostlyEnglish, translateWithLlm } from "./translate";
import { downloadImages, saveMarkdown } from "./saver";
import { runPool } from "./queue";
import { normalizeUrl, extractFirstUrl, clamp, fullTimestamp, resolveDuplicate } from "./util";
import { SOURCE_LABEL } from "./types";
import type { ShiyueSettings, ExtractResult, ClassResult, BatchSummary, BatchResultEntry, ClipRecord, Fetcher } from "./types";
import { InputModal, BatchModal, ManualClipModal, PreviewModal, ResultModal, DuplicateModal, ConfirmClipModal } from "./modals";

export default class ShiyueWebclipPlugin extends Plugin {
  override settings: ShiyueSettings = DEFAULT_SETTINGS;
  fetcher!: Fetcher;

  override async onload(): Promise<void> {
    await this.loadSettings();
    this.refreshFetcher();

    this.addRibbonIcon("download", "识玥剪藏：剪藏剪贴板里的链接", () => {
      void this.clipClipboard();
    });

    this.addCommand({
      id: "shiyue-clip-clipboard",
      name: "剪藏剪贴板里的链接",
      callback: () => void this.clipClipboard(),
    });
    this.addCommand({
      id: "shiyue-clip-input",
      name: "输入链接剪藏",
      callback: () => {
        new InputModal(this.app, (url) => {
          if (url) void this.processUrls([url]);
        }).open();
      },
    });
    this.addCommand({
      id: "shiyue-clip-batch",
      name: "批量剪藏多个链接",
      callback: () => {
        new BatchModal(this.app, (text) => {
          if (text) void this.processUrls(text.split(/\r?\n/));
        }).open();
      },
    });
    this.addCommand({
      id: "shiyue-clip-manual",
      name: "手动粘贴内容剪藏（动态页/付费墙兜底）",
      callback: () => {
        new ManualClipModal(this.app, (data) => {
          if (data) void this.clipManual(data);
        }).open();
      },
    });
    this.addCommand({
      id: "shiyue-last-run",
      name: "查看上次剪藏结果",
      callback: () => {
        if (this.settings.lastRun) new ResultModal(this.app, this.settings.lastRun).open();
        else new Notice("识玥剪藏：还没有剪藏记录");
      },
    });

    this.addSettingTab(new ShiyueSettingTab(this.app, this));
  }

  override onunload(): void {
    /* 无需清理 */
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as Partial<ShiyueSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data ?? {});
    if (!Array.isArray(this.settings.index)) this.settings.index = [];
  }

  async saveSettings(): Promise<void> {
    if (this.settings.index.length > 3000) {
      this.settings.index = this.settings.index.slice(-3000);
    }
    await this.saveData(this.settings);
    this.refreshFetcher();
  }

  private refreshFetcher(): void {
    this.fetcher = createObsidianFetcher(this.settings.requestTimeoutMs, this.settings.requestRetries);
  }

  /** 单条剪藏：抓取 → 分类 → （预览）→ 图片本地化 → 写入笔记 → 建索引 */
  private async clipOne(rawUrl: string, interactive = false): Promise<BatchResultEntry> {
    const norm = normalizeUrl(rawUrl);
    const entry: BatchResultEntry = { url: norm.url, ok: false };

    if (this.settings.dedupe) {
      // 取最新一条记录（重新剪藏会产生同 key 多条记录）
      let rec: ClipRecord | undefined;
      for (let i = this.settings.index.length - 1; i >= 0; i--) {
        if (this.settings.index[i].key === norm.key) {
          rec = this.settings.index[i];
          break;
        }
      }
      if (rec) {
        const action = resolveDuplicate(this.settings.duplicateAction, interactive);
        if (action === "skip") {
          return { ...entry, ok: false, skipped: true, title: rec.title, reason: `已剪藏过 → ${rec.path}` };
        }
        if (action === "ask") {
          const reclip = await new Promise<boolean>((resolve) => {
            new DuplicateModal(this.app, rec, resolve).open();
          });
          if (!reclip) {
            return { ...entry, ok: false, skipped: true, title: rec.title, reason: `已剪藏过 → ${rec.path}（选择跳过）` };
          }
          // 选择重新剪藏：继续正常流程，生成新笔记（旧笔记不受影响）
        }
      }
    }

    try {
      const result = await extractClip(this.fetcher, norm.url, {
        xhsCookie: this.settings.xhsCookie,
        timeoutMs: this.settings.requestTimeoutMs,
        retries: this.settings.requestRetries,
      });

      const rules = parseRules(this.settings.rulesText);
      const ruleRes = classifyByRules(result.title, result.contentText || result.excerpt, rules);
      let llmRes: { category: string; tags: string[] } | null = null;
      if (this.settings.useLlm && this.settings.llmApiKey) {
        llmRes = await classifyWithLlm(
          this.fetcher,
          {
            endpoint: this.settings.llmEndpoint,
            apiKey: this.settings.llmApiKey,
            model: this.settings.llmModel,
            timeoutMs: this.settings.llmTimeoutMs,
          },
          result.title,
          result.contentText,
        );
      }
      const cls = mergeClassification(ruleRes, llmRes, rules, this.settings.fallbackFolder);

      // 英文内容自动翻译（仅 LLM 启用时；失败降级为保留原文 + 告警）
      if (
        this.settings.useLlm &&
        this.settings.translateWhenLlm &&
        this.settings.llmApiKey &&
        isMostlyEnglish(result.contentText)
      ) {
        const tr = await translateWithLlm(
          this.fetcher,
          {
            endpoint: this.settings.llmEndpoint,
            apiKey: this.settings.llmApiKey,
            model: this.settings.llmModel,
            timeoutMs: this.settings.llmTimeoutMs,
          },
          result.title,
          result.contentText,
        );
        if (tr.ok) {
          result.translation = { titleZh: tr.titleZh, contentZh: tr.contentZh };
          if (tr.truncated) {
            result.warnings.push(
              `正文较长（${result.contentText.length} 字符），翻译仅覆盖前 ${tr.coveredChars} 字符，英文原文完整保留。`,
            );
          }
        } else {
          result.warnings.push(`LLM 翻译失败（${tr.reason}），已保留英文原文。可检查设置里的 API 地址/Key/模型名后重新剪藏。`);
        }
      }

      if (this.settings.previewBeforeSave) {
        const save = await new Promise<boolean>((resolve) => {
          new PreviewModal(this.app, result, cls, resolve).open();
        });
        if (!save) return { ...entry, ok: false, skipped: true, reason: "预览后取消保存" };
      }

      const imagesMap = new Map<string, string>();
      if (this.settings.downloadImages && result.images.length) {
        const dl = await downloadImages(this.app, this.fetcher, result.images, {
          attachmentsFolder: this.settings.attachmentsFolder,
          baseName: result.title,
          max: this.settings.maxImages,
          timeoutMs: this.settings.requestTimeoutMs,
        });
        if (dl.failures > 0) {
          result.warnings.push(`有 ${dl.failures} 张图片下载失败，已保留原始链接。`);
        }
        for (const [k, v] of dl.map) imagesMap.set(k, v);
      }

      const filename = buildFilename(this.settings.filenameTemplate, {
        title: result.translation?.titleZh ?? result.title,
        sourceLabel: SOURCE_LABEL[result.source],
        author: result.author,
        siteName: result.siteName,
      });
      const folder = cls.folder || this.settings.fallbackFolder;
      const content = buildNote(
        result,
        cls,
        {
          filenameTemplate: this.settings.filenameTemplate,
          appendSourceLink: this.settings.appendSourceLink,
          useWikilinks: this.settings.useWikilinks,
        },
        imagesMap,
      );
      const saved = await saveMarkdown(this.app, folder, filename, content);

      const record: ClipRecord = {
        key: norm.key,
        url: result.url || norm.url,
        path: saved.path,
        time: fullTimestamp(),
        title: result.title,
        source: SOURCE_LABEL[result.source],
      };
      this.settings.index.push(record);
      new Notice(`✅ 识玥剪藏：已保存「${saved.path}」`, 5000);
      return { ...entry, ok: true, path: saved.path, title: result.title, source: SOURCE_LABEL[result.source] };
    } catch (e) {
      const reason =
        e instanceof Error && e.name === "ClipError" && "userMessage" in e
          ? (e as Error & { userMessage: string }).userMessage
          : `未知错误：${e instanceof Error ? e.message : String(e)}`;
      new Notice(`❌ 识玥剪藏失败：${reason}`, 9000);
      return { ...entry, ok: false, reason };
    }
  }

  /** 批量处理：限速池 + 汇总 */
  private async processUrls(urls: string[]): Promise<BatchSummary> {
    const cleaned: string[] = [];
    for (const u of urls) {
      const f = extractFirstUrl(u) ?? u.trim();
      if (f && /^https?:\/\//i.test(f) && !cleaned.includes(f)) cleaned.push(f);
    }
    const summary: BatchSummary = {
      startedAt: fullTimestamp(),
      finishedAt: "",
      results: [],
      okCount: 0,
      failCount: 0,
      skipCount: 0,
    };
    if (!cleaned.length) {
      new Notice("识玥剪藏：没有找到可用的链接");
      return summary;
    }
    const notice = new Notice(`识玥剪藏：开始处理 ${cleaned.length} 个链接…`, 0);

    const items = cleaned.map((u, i) => {
      let preDelayMs = i === 0 ? 0 : Math.max(0, this.settings.interTaskDelayMs);
      if (i > 0 && routeUrl(normalizeUrl(u).url) === "wechat") preDelayMs += 800;
      return { v: u, preDelayMs };
    });

    await runPool(
      items,
      async (url, i) => {
        notice.setMessage(`识玥剪藏：(${i + 1}/${cleaned.length}) 处理中…`);
        const entry = await this.clipOne(url, cleaned.length === 1);
        summary.results.push(entry);
        if (entry.ok) summary.okCount += 1;
        else if (entry.skipped) summary.skipCount += 1;
        else summary.failCount += 1;
      },
      { concurrency: Math.max(1, Math.min(3, this.settings.concurrency)) },
    );

    notice.hide();
    summary.finishedAt = fullTimestamp();
    this.settings.lastRun = summary;
    await this.saveSettings();
    new Notice(`识玥剪藏完成：✅${summary.okCount} ⏭️${summary.skipCount} ❌${summary.failCount}`, 6000);
    if (cleaned.length > 1 || summary.failCount > 0 || summary.skipCount > 0) {
      new ResultModal(this.app, summary).open();
    }
    return summary;
  }

  private async clipClipboard(): Promise<void> {
    let text = "";
    try {
      text = await navigator.clipboard.readText();
    } catch {
      text = "";
    }
    const url = text ? extractFirstUrl(text) : null;
    if (!url) {
      new Notice("识玥剪藏：剪贴板里没有链接，请手动输入");
      new InputModal(this.app, (u) => {
        if (u) void this.processUrls([u]);
      }).open();
      return;
    }
    // 默认先确认再入库：剪贴板里的链接可能只是要分享给朋友，不能悄悄写进知识库
    if (this.settings.clipboardMode === "confirm") {
      const proceed = await new Promise<boolean>((resolve) => {
        new ConfirmClipModal(this.app, url, resolve).open();
      });
      if (!proceed) {
        new Notice("识玥剪藏：已取消，剪贴板内容未入库", 4000);
        return;
      }
    }
    await this.processUrls([url]);
  }

  private async clipManual(data: { title: string; url: string; content: string }): Promise<void> {
    if (!data.content.trim()) {
      new Notice("识玥剪藏：内容为空");
      return;
    }
    const norm = data.url ? normalizeUrl(data.url) : null;
    if (norm && this.settings.dedupe) {
      const rec = this.settings.index.find((r) => r.key === norm.key);
      if (rec) {
        new Notice(`识玥剪藏：该链接已剪藏过 → ${rec.path}`, 6000);
        return;
      }
    }
    const title = data.title || data.content.trim().split(/\r?\n/)[0].slice(0, 60) || "手动笔记";
    const result: ExtractResult = {
      source: "manual",
      url: norm?.url ?? "",
      title,
      contentText: data.content.trim(),
      excerpt: clamp(data.content.trim(), 160),
      images: [],
      warnings: [],
    };
    const rules = parseRules(this.settings.rulesText);
    const ruleRes = classifyByRules(result.title, result.contentText, rules);
    const cls = mergeClassification(ruleRes, null, rules, this.settings.fallbackFolder);
    const filename = buildFilename(this.settings.filenameTemplate, {
      title: result.title,
      sourceLabel: SOURCE_LABEL.manual,
    });
    const content = buildNote(result, cls, {
      filenameTemplate: this.settings.filenameTemplate,
      appendSourceLink: this.settings.appendSourceLink,
      useWikilinks: this.settings.useWikilinks,
    });
    const saved = await saveMarkdown(this.app, cls.folder || this.settings.fallbackFolder, filename, content);
    if (norm) {
      this.settings.index.push({
        key: norm.key,
        url: norm.url,
        path: saved.path,
        time: fullTimestamp(),
        title: result.title,
        source: SOURCE_LABEL.manual,
      });
    }
    await this.saveSettings();
    new Notice(`✅ 识玥剪藏：已保存「${saved.path}」`, 5000);
  }
}

class ShiyueSettingTab extends PluginSettingTab {
  plugin: ShiyueWebclipPlugin;
  constructor(app: App, plugin: ShiyueWebclipPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;
    const save = () => void this.plugin.saveSettings();

    containerEl.createEl("h3", { text: "保存位置" });

    new Setting(containerEl)
      .setName("笔记保存目录")
      .setDesc("所有剪藏笔记的根目录，分类规则可以指定到子目录")
      .addText((t) => t.setValue(s.saveFolder).onChange((v) => { s.saveFolder = v.trim() || "剪藏"; save(); }));

    new Setting(containerEl)
      .setName("附件目录")
      .setDesc("下载的图片存放目录")
      .addText((t) => t.setValue(s.attachmentsFolder).onChange((v) => { s.attachmentsFolder = v.trim() || "剪藏/附件"; save(); }));

    new Setting(containerEl)
      .setName("未分类目录")
      .setDesc("没有任何规则命中（且未启用 LLM）时的归档目录")
      .addText((t) => t.setValue(s.fallbackFolder).onChange((v) => { s.fallbackFolder = v.trim() || "剪藏/未分类"; save(); }));

    new Setting(containerEl)
      .setName("文件名模板")
      .setDesc("可用变量：{{title}} {{date}} {{datetime}} {{source}} {{author}} {{site}}")
      .addText((t) => t.setValue(s.filenameTemplate).onChange((v) => { s.filenameTemplate = v.trim() || "{{date}} {{title}}"; save(); }));

    containerEl.createEl("h3", { text: "剪藏行为" });

    new Setting(containerEl).setName("下载正文图片到本地").addToggle((tg) =>
      tg.setValue(s.downloadImages).onChange((v) => { s.downloadImages = v; save(); }));

    new Setting(containerEl)
      .setName("每篇最多下载图片数")
      .setDesc("防止超长文章拖慢剪藏；超出部分保留原始链接")
      .addText((t) =>
        t.setValue(String(s.maxImages)).onChange((v) => {
          const n = parseInt(v, 10);
          if (!isNaN(n) && n > 0) { s.maxImages = Math.min(50, n); save(); }
        }));

    new Setting(containerEl).setName("图片用 Wiki 链接嵌入").setDesc("关闭则用标准 Markdown 链接").addToggle((tg) =>
      tg.setValue(s.useWikilinks).onChange((v) => { s.useWikilinks = v; save(); }));

    new Setting(containerEl).setName("链接去重").setDesc("同一链接不会重复剪藏（重复时的处理方式见下一项）").addToggle((tg) =>
      tg.setValue(s.dedupe).onChange((v) => { s.dedupe = v; save(); }));

    new Setting(containerEl)
      .setName("重复链接处理")
      .setDesc("已剪藏过的链接再次剪藏时：询问=单个剪藏时弹窗确认是否重新剪藏（批量时自动跳过）；总是重新剪藏=不询问直接生成新笔记；总是跳过=维持旧行为。重新剪藏不会删除或修改旧笔记。")
      .addDropdown((d) =>
        d
          .addOption("ask", "询问（推荐）")
          .addOption("reclip", "总是重新剪藏")
          .addOption("skip", "总是跳过")
          .setValue(s.duplicateAction)
          .onChange((v) => { s.duplicateAction = (v as "ask" | "skip" | "reclip") || "ask"; save(); }));

    new Setting(containerEl)
      .setName("剪贴板剪藏方式")
      .setDesc("先确认（推荐）：点侧栏图标后先弹窗展示链接，确认后才入库——避免「复制链接只是想分享给朋友」被误入库。一键直接剪藏：保持旧版速度。")
      .addDropdown((d) =>
        d
          .addOption("confirm", "先确认再剪藏（推荐）")
          .addOption("instant", "一键直接剪藏")
          .setValue(s.clipboardMode)
          .onChange((v) => { s.clipboardMode = (v as "confirm" | "instant") || "confirm"; save(); }));

    new Setting(containerEl).setName("保存前预览").setDesc("抓取后先弹窗确认标题、分类和内容摘要，再决定是否入库").addToggle((tg) =>
      tg.setValue(s.previewBeforeSave).onChange((v) => { s.previewBeforeSave = v; save(); }));

    new Setting(containerEl).setName("笔记底部追加原文链接").addToggle((tg) =>
      tg.setValue(s.appendSourceLink).onChange((v) => { s.appendSourceLink = v; save(); }));

    containerEl.createEl("h3", { text: "自动分类规则" });

    new Setting(containerEl)
      .setName("分类规则（每行一条）")
      .setDesc("格式：分类名 | 目标文件夹 | 标签1,标签2 | 关键词1,关键词2。关键词命中最多者胜出；文件夹/标签可省略。以 # 开头的行是注释。")
      .addTextArea((ta) => {
        ta.setValue(s.rulesText).onChange((v) => { s.rulesText = v; save(); });
        ta.inputEl.addClass("shiyue-textarea");
        ta.inputEl.rows = 10;
      })
      .addExtraButton((btn) =>
        btn.setIcon("reset").setTooltip("恢复默认规则").onClick(() => {
          s.rulesText = DEFAULT_RULES_TEXT;
          void this.plugin.saveSettings();
          this.display();
        }));

    containerEl.createEl("h3", { text: "智能分类（可选，默认关闭）" });

    new Setting(containerEl)
      .setName("启用 LLM 分类")
      .setDesc("规则命中优先；未命中时调用 OpenAI 兼容接口判断分类。接口异常自动回退到规则/未分类，不会阻塞剪藏。")
      .addToggle((tg) => tg.setValue(s.useLlm).onChange((v) => { s.useLlm = v; save(); }));

    new Setting(containerEl).setName("API 地址").setDesc("OpenAI 兼容接口：填完整 chat/completions 地址，或 base 地址（如 https://api.deepseek.com 或 …/v1，自动补全 /chat/completions）").addText((t) =>
      t.setValue(s.llmEndpoint).onChange((v) => { s.llmEndpoint = v.trim(); save(); }));
    new Setting(containerEl).setName("API Key").addText((t) => {
      t.setValue(s.llmApiKey).onChange((v) => { s.llmApiKey = v.trim(); save(); });
      t.inputEl.type = "password";
    });
    new Setting(containerEl).setName("模型名").addText((t) =>
      t.setValue(s.llmModel).onChange((v) => { s.llmModel = v.trim(); save(); }));

    new Setting(containerEl)
      .setName("英文内容自动翻译")
      .setDesc("启用 LLM 且检测到主要内容为英文时，自动翻译成中文并保留英文原文（标题一并翻译，frontmatter 保留 original_title）。未启用 LLM 或未填 Key 时此开关无效，行为不变。")
      .addToggle((tg) => tg.setValue(s.translateWhenLlm).onChange((v) => { s.translateWhenLlm = v; save(); }));

    containerEl.createEl("h3", { text: "平台与网络" });

    new Setting(containerEl)
      .setName("小红书 Cookie")
      .setDesc("小红书有登录墙：电脑浏览器登录 → F12 → Network → 复制任意 xiaohongshu 请求的 Cookie 头粘贴到这里。Cookie 会过期，失效时重新复制即可。")
      .addText((t) => {
        t.setValue(s.xhsCookie).onChange((v) => { s.xhsCookie = v.trim(); save(); });
        t.inputEl.type = "password";
        t.inputEl.addClass("shiyue-input-wide");
      });

    new Setting(containerEl)
      .setName("请求超时（毫秒）")
      .setDesc("单次网络请求的最长等待时间")
      .addText((t) =>
        t.setValue(String(s.requestTimeoutMs)).onChange((v) => {
          const n = parseInt(v, 10);
          if (!isNaN(n) && n >= 3000) { s.requestTimeoutMs = n; save(); }
        }));

    new Setting(containerEl)
      .setName("失败重试次数")
      .setDesc("网络错误 / 5xx / 429 自动重试次数")
      .addText((t) =>
        t.setValue(String(s.requestRetries)).onChange((v) => {
          const n = parseInt(v, 10);
          if (!isNaN(n) && n >= 0 && n <= 5) { s.requestRetries = n; save(); }
        }));

    new Setting(containerEl)
      .setName("批量并发数")
      .setDesc("1=串行（对公众号最友好），最多 3")
      .addDropdown((d) =>
        d
          .addOption("1", "1（串行，最稳）")
          .addOption("2", "2")
          .addOption("3", "3")
          .setValue(String(s.concurrency))
          .onChange((v) => { s.concurrency = parseInt(v, 10) || 1; save(); }));

    new Setting(containerEl)
      .setName("批量任务间隔（毫秒）")
      .setDesc("两个链接之间的最小间隔；公众号链接会自动追加 800ms 限速")
      .addText((t) =>
        t.setValue(String(s.interTaskDelayMs)).onChange((v) => {
          const n = parseInt(v, 10);
          if (!isNaN(n) && n >= 0) { s.interTaskDelayMs = n; save(); }
        }));

    containerEl.createEl("h3", { text: "诚实声明（能力边界）" });
    const ul = containerEl.createEl("ul");
    for (const item of [
      "小红书：无 Cookie 基本拿不到正文（平台登录墙）；有 Cookie 可用但会过期，过期后插件会明确报错而不是存半页垃圾。",
      "X(Twitter)：走公开 syndication/oembed 端点，单条推文成功率高；受限推（年龄/地区）、已删推、纯视频推拿不到全文，会明确报错。不支持线程串整串抓取。",
      "微信公众号：大多数图文可抓；触发「环境异常」风控或文章被删时明确报错。批量时自动限速。",
      "需要 JS 渲染或付费墙的网页：静态抓取拿不到完整正文，插件会提示改用「手动粘贴内容剪藏」。",
      "Cookie 仅保存在你本机的 .obsidian/plugins/shiyue-webclip/data.json，请勿分享该文件。",
    ]) {
      ul.createEl("li", { text: item, cls: "shiyue-muted" });
    }
  }
}
