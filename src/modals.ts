import { Modal, App, Notice } from "obsidian";
import { SOURCE_LABEL } from "./types";
import type { ExtractResult, ClassResult, BatchSummary } from "./types";
import { clamp } from "./util";

function addButtons(el: HTMLElement, actions: { text: string; cta?: boolean; onClick: () => void }[]) {
  const row = el.createDiv({ cls: "modal-button-container" });
  for (const a of actions) {
    const btn = row.createEl("button", { text: a.text });
    if (a.cta) btn.addClass("mod-cta");
    btn.addEventListener("click", () => a.onClick());
  }
}

/** 单链接输入弹窗 */
export class InputModal extends Modal {
  constructor(app: App, private onSubmit: (url: string | null) => void) {
    super(app);
  }
  override onOpen(): void {
    this.modalEl.addClass("shiyue-modal");
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "识玥剪藏：输入链接" });
    contentEl.createEl("p", { text: "支持 X(Twitter) 推文、微信公众号文章、小红书笔记、普通网页/新闻链接。", cls: "shiyue-muted" });
    const input = contentEl.createEl("input", { type: "text" });
    input.addClass("shiyue-input-wide");
    input.placeholder = "粘贴链接，例如 https://x.com/xx/status/123 或 https://mp.weixin.qq.com/s/xxx";
    const submit = () => {
      const v = input.value.trim();
      this.close();
      this.onSubmit(v || null);
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
    });
    addButtons(contentEl, [
      { text: "剪藏", cta: true, onClick: () => submit() },
      { text: "取消", onClick: () => { this.close(); this.onSubmit(null); } },
    ]);
    window.setTimeout(() => input.focus(), 50);
  }
  override onClose(): void {
    this.contentEl.empty();
  }
}

/** 批量链接弹窗（每行一个） */
export class BatchModal extends Modal {
  constructor(app: App, private onSubmit: (text: string | null) => void) {
    super(app);
  }
  override onOpen(): void {
    this.modalEl.addClass("shiyue-modal");
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "识玥剪藏：批量剪藏" });
    contentEl.createEl("p", { text: "每行一个链接。公众号链接会自动限速抓取，避免触发微信风控。", cls: "shiyue-muted" });
    const ta = contentEl.createEl("textarea");
    ta.addClass("shiyue-textarea");
    ta.rows = 8;
    ta.placeholder = "https://x.com/xx/status/1\nhttps://mp.weixin.qq.com/s/xxx\nhttps://www.xiaohongshu.com/explore/xxx\nhttps://news.example.com/article";
    const submit = () => {
      const v = ta.value.trim();
      this.close();
      this.onSubmit(v || null);
    };
    addButtons(contentEl, [
      { text: "批量剪藏", cta: true, onClick: () => submit() },
      { text: "取消", onClick: () => { this.close(); this.onSubmit(null); } },
    ]);
    window.setTimeout(() => ta.focus(), 50);
  }
  override onClose(): void {
    this.contentEl.empty();
  }
}

/** 剪贴板剪藏确认：链接可能是要分享给朋友的，先问一句再入库 */
export class ConfirmClipModal extends Modal {
  private decided = false;
  constructor(app: App, private url: string, private onChoose: (proceed: boolean) => void) {
    super(app);
  }
  override onOpen(): void {
    this.modalEl.addClass("shiyue-modal");
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "识玥剪藏：确认剪藏这个链接？" });
    const urlEl = contentEl.createEl("p", { text: this.url });
    urlEl.style.wordBreak = "break-all";
    contentEl.createEl("p", {
      text: "确认后将抓取正文并保存进知识库。如果这个链接只是要分享给朋友、不想入库，点取消即可，不会有任何写入。",
      cls: "shiyue-muted",
    });
    const choose = (v: boolean) => {
      if (this.decided) return;
      this.decided = true;
      this.close();
      this.onChoose(v);
    };
    addButtons(contentEl, [
      { text: "剪藏入库", cta: true, onClick: () => choose(true) },
      { text: "取消", onClick: () => choose(false) },
    ]);
  }
  override onClose(): void {
    if (!this.decided) {
      this.decided = true;
      this.onChoose(false);
    }
    this.contentEl.empty();
  }
}

/** 重复链接弹窗：给用户一次重新剪藏的机会 */
export class DuplicateModal extends Modal {
  private decided = false;
  constructor(
    app: App,
    private rec: { path: string; time: string; title: string },
    private onChoose: (reclip: boolean) => void,
  ) {
    super(app);
  }
  override onOpen(): void {
    this.modalEl.addClass("shiyue-modal");
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "识玥剪藏：该链接已剪藏过" });
    contentEl.createEl("p", { text: `已有笔记：${this.rec.path}`, cls: "shiyue-muted" });
    contentEl.createEl("p", { text: `剪藏时间：${this.rec.time}`, cls: "shiyue-muted" });
    contentEl.createEl("p", { text: `标题：${this.rec.title}` });
    contentEl.createEl("p", {
      text: "重新剪藏会生成一份新笔记（文件名自动加序号，不影响已有笔记）。也可以在设置里把「重复链接处理」改为总是重新剪藏或总是跳过。",
      cls: "shiyue-muted",
    });
    const choose = (v: boolean) => {
      if (this.decided) return;
      this.decided = true;
      this.close();
      this.onChoose(v);
    };
    addButtons(contentEl, [
      { text: "重新剪藏一份", cta: true, onClick: () => choose(true) },
      { text: "跳过", onClick: () => choose(false) },
    ]);
  }
  override onClose(): void {
    if (!this.decided) {
      this.decided = true;
      this.onChoose(false);
    }
    this.contentEl.empty();
  }
}

/** 手动粘贴内容弹窗（动态渲染页/付费墙的兜底方案） */
export class ManualClipModal extends Modal {
  constructor(
    app: App,
    private onSubmit: (data: { title: string; url: string; content: string } | null) => void,
  ) {
    super(app);
  }
  override onOpen(): void {
    this.modalEl.addClass("shiyue-modal");
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "识玥剪藏：手动粘贴内容" });
    contentEl.createEl("p", { text: "适用于需要 JS 渲染、付费墙或被平台风控的页面：复制网页正文粘到这里，插件照样帮你分类归档。", cls: "shiyue-muted" });

    const titleInput = contentEl.createEl("input", { type: "text" });
    titleInput.addClass("shiyue-input-wide");
    titleInput.placeholder = "标题（可选，留空取正文第一行）";
    const urlInput = contentEl.createEl("input", { type: "text" });
    urlInput.addClass("shiyue-input-wide");
    urlInput.style.marginTop = "8px";
    urlInput.placeholder = "来源链接（可选）";
    const ta = contentEl.createEl("textarea");
    ta.addClass("shiyue-textarea");
    ta.rows = 10;
    ta.style.marginTop = "8px";
    ta.placeholder = "把网页正文粘贴到这里（必填）";

    const submit = () => {
      const content = ta.value.trim();
      if (!content) {
        new Notice("识玥剪藏：正文内容不能为空");
        return;
      }
      this.close();
      this.onSubmit({ title: titleInput.value.trim(), url: urlInput.value.trim(), content });
    };
    addButtons(contentEl, [
      { text: "保存并分类", cta: true, onClick: () => submit() },
      { text: "取消", onClick: () => { this.close(); this.onSubmit(null); } },
    ]);
    window.setTimeout(() => titleInput.focus(), 50);
  }
  override onClose(): void {
    this.contentEl.empty();
  }
}

/** 保存前预览弹窗 */
export class PreviewModal extends Modal {
  private decided = false;
  constructor(
    app: App,
    private result: ExtractResult,
    private cls: ClassResult,
    private onChoose: (save: boolean) => void,
  ) {
    super(app);
  }
  override onOpen(): void {
    this.modalEl.addClass("shiyue-modal");
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "识玥剪藏：保存前预览" });
    const badgeRow = contentEl.createDiv();
    badgeRow.createEl("span", { cls: "shiyue-badge", text: SOURCE_LABEL[this.result.source] });
    badgeRow.createEl("span", { cls: "shiyue-badge", text: `分类：${this.cls.category}` });
    badgeRow.createEl("span", { cls: "shiyue-badge", text: `归档：${this.cls.folder}` });
    if (this.cls.tags.length) {
      badgeRow.createEl("span", { cls: "shiyue-badge", text: `标签：${this.cls.tags.join(" / ")}` });
    }
    contentEl.createEl("p", { text: this.result.title }).style.fontWeight = "600";
    if (this.result.translation) {
      contentEl.createEl("p", { text: `翻译标题：${this.result.translation.titleZh}`, cls: "shiyue-muted" });
    }
    if (this.result.author || this.result.publishTime) {
      const meta = [this.result.author, this.result.publishTime].filter(Boolean).join(" · ");
      contentEl.createEl("p", { text: meta, cls: "shiyue-muted" });
    }
    const box = contentEl.createDiv({ cls: "shiyue-preview-box" });
    const preview = this.result.translation
      ? this.result.translation.contentZh
      : this.result.contentMarkdown || this.result.contentText || "";
    box.textContent = clamp(preview, 1200);
    if (this.result.images.length) {
      contentEl.createEl("p", { text: `共 ${this.result.images.length} 张图片（将下载到附件目录，失败保留原链）`, cls: "shiyue-muted" });
    }
    for (const w of this.result.warnings) {
      contentEl.createEl("p", { text: `⚠ ${w}`, cls: "shiyue-warning" });
    }
    const choose = (v: boolean) => {
      if (this.decided) return;
      this.decided = true;
      this.close();
      this.onChoose(v);
    };
    addButtons(contentEl, [
      { text: "保存并归档", cta: true, onClick: () => choose(true) },
      { text: "取消", onClick: () => choose(false) },
    ]);
  }
  override onClose(): void {
    if (!this.decided) {
      this.decided = true;
      this.onChoose(false);
    }
    this.contentEl.empty();
  }
}

/** 批量结果弹窗 */
export class ResultModal extends Modal {
  constructor(app: App, private summary: BatchSummary) {
    super(app);
  }
  override onOpen(): void {
    this.modalEl.addClass("shiyue-modal");
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "识玥剪藏：本次结果" });
    contentEl.createEl("p", {
      text: `✅ 成功 ${this.summary.okCount}　⏭️ 跳过 ${this.summary.skipCount}　❌ 失败 ${this.summary.failCount}　（${this.summary.startedAt} → ${this.summary.finishedAt}）`,
    });
    const table = contentEl.createEl("table", { cls: "shiyue-table" });
    const thead = table.createEl("thead");
    const hr = thead.createEl("tr");
    for (const h of ["链接", "结果", "路径 / 原因"]) hr.createEl("th", { text: h });
    const tbody = table.createEl("tbody");
    for (const r of this.summary.results) {
      const tr = tbody.createEl("tr");
      tr.createEl("td", { text: clamp(r.url, 60) });
      const tdStatus = tr.createEl("td");
      if (r.ok) {
        tdStatus.setText("✅ 成功");
        tdStatus.classList.add("shiyue-ok");
      } else if (r.skipped) {
        tdStatus.setText("⏭️ 跳过");
        tdStatus.classList.add("shiyue-muted");
      } else {
        tdStatus.setText("❌ 失败");
        tdStatus.classList.add("shiyue-fail");
      }
      tr.createEl("td", { text: r.ok ? (r.path ?? "") : (r.reason ?? "") });
    }
    addButtons(contentEl, [{ text: "关闭", onClick: () => this.close() }]);
  }
  override onClose(): void {
    this.contentEl.empty();
  }
}
