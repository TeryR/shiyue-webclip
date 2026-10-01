import { SOURCE_LABEL } from "./types";
import type { ClassResult, ExtractResult } from "./types";
import { escapeYaml, sanitizeFilename, todayStr, fullTimestamp } from "./util";

export interface NoteBuildOptions {
  filenameTemplate: string;
  appendSourceLink: boolean;
  useWikilinks: boolean;
  /** 插件版本，写进 frontmatter clipper 字段；不传则只写插件 id */
  clipperVersion?: string;
}

/** 生成笔记文件名（不含 .md） */
export function buildFilename(
  template: string,
  parts: { title: string; sourceLabel: string; author?: string; siteName?: string; date?: Date },
): string {
  const date = parts.date ?? new Date();
  const name = (template || "{{date}} {{title}}")
    .replace(/\{\{title\}\}/g, parts.title || "未命名")
    .replace(/\{\{date\}\}/g, todayStr(date))
    .replace(/\{\{datetime\}\}/g, fullTimestamp(date).replace(":", "-"))
    .replace(/\{\{source\}\}/g, parts.sourceLabel)
    .replace(/\{\{author\}\}/g, parts.author || "")
    .replace(/\{\{site\}\}/g, parts.siteName || "");
  return sanitizeFilename(name.replace(/\s+/g, " ").trim());
}

function buildFrontmatter(fields: Record<string, string | string[] | undefined>): string {
  const lines: string[] = ["---"];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === "") continue;
    if (Array.isArray(v)) {
      if (!v.length) continue;
      lines.push(`${k}:`);
      for (const item of v) lines.push(`  - ${escapeYaml(item)}`);
    } else {
      lines.push(`${k}: ${escapeYaml(v)}`);
    }
  }
  lines.push("---");
  return lines.join("\n");
}

function plainTextToMarkdown(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => p.replace(/(?<=\S)\n(?=\S)/g, "  \n").trim())
    .filter(Boolean)
    .join("\n\n");
}

function imageEmbed(linktext: string, useWikilinks: boolean): string {
  return useWikilinks ? `![[${linktext}]]` : `![图片](<${linktext}>)`;
}

/**
 * 组装完整笔记内容。
 * imagesMap: 远程图片 URL → 已下载的本地链接文本（未下载成功的保留远程地址）
 */
export function buildNote(
  result: ExtractResult,
  cls: ClassResult,
  opts: NoteBuildOptions,
  imagesMap: Map<string, string> = new Map(),
): string {
  const now = fullTimestamp();
  const sourceLabel = SOURCE_LABEL[result.source];
  const warnings = result.warnings ?? [];
  const hasTranslation = !!result.translation;

  const frontmatter = buildFrontmatter({
    title: hasTranslation ? result.translation!.titleZh : result.title,
    original_title: hasTranslation ? result.title : undefined,
    source: sourceLabel,
    url: result.url || undefined,
    author: result.author,
    publish_time: result.publishTime,
    site: result.siteName,
    category: cls.category,
    tags: ["剪藏", ...cls.tags],
    clipper: opts.clipperVersion ? `shiyue-webclip/${opts.clipperVersion}` : "shiyue-webclip",
    clipped_at: now,
    status: warnings.length ? "partial" : "ok",
  });

  const metaLines: string[] = ["> [!quote] 来源信息"];
  metaLines.push(`> - 平台：${sourceLabel}`);
  if (result.author) metaLines.push(`> - 作者：${result.author}`);
  if (result.siteName && result.siteName !== sourceLabel) {
    metaLines.push(`> - 站点：${result.siteName}`);
  }
  if (result.publishTime) metaLines.push(`> - 发布：${result.publishTime}`);
  if (result.url) metaLines.push(`> - 原文：${result.url}`);

  const sections: string[] = [frontmatter, "", metaLines.join("\n"), ""];

  // 正文：有 LLM 翻译时，译文在前、英文原文完整保留在后
  const originalBody =
    result.source === "wechat" || result.source === "web" || result.source === "toutiao"
      ? (result.contentMarkdown || result.contentText || "").trim()
      : plainTextToMarkdown(result.contentText || "");

  if (result.translation) {
    sections.push("## 中文翻译\n\n" + result.translation.contentZh.trim());
    sections.push("---");
    sections.push("## 原文");
    sections.push(originalBody);
  } else {
    sections.push(originalBody);
  }

  // 图片：web/微信的图已在正文 markdown 内，此处把远程地址替换为本地链接。
  // 本地路径可能含空格（来自标题），wikilinks 模式用 ![[...]]，markdown 模式必须包 <...>，否则链接失效。
  let body = sections.join("\n");
  if (imagesMap.size) {
    for (const [remote, local] of imagesMap) {
      const embed = opts.useWikilinks ? imageEmbed(local, true) : imageEmbed(local, false);
      body = body.split(`![图片](${remote})`).join(embed);
      // 兜底：不在上述精确形态里的裸地址（如正文引用了同一 URL）也替换成带尖括号的链接
      if (body.includes(remote)) {
        body = body.split(remote).join(opts.useWikilinks ? local : `<${local}>`);
      }
    }
  }

  // X / 小红书 / 手动：图片以附录形式追加
  if (
    (result.source === "x" || result.source === "xhs" || result.source === "manual") &&
    result.images.length
  ) {
    const embeds = result.images
      .map((remote) => {
        const local = imagesMap.get(remote);
        return local ? imageEmbed(local, opts.useWikilinks) : `![图片](${remote})`;
      })
      .join("\n\n");
    body += "\n\n---\n\n" + embeds;
  }

  if (warnings.length) {
    body +=
      "\n\n> [!warning] 剪藏提示\n" +
      warnings.map((w) => `> - ${w}`).join("\n");
  }

  if (opts.appendSourceLink && result.url) {
    body += `\n\n---\n原文链接：${result.url}`;
  }

  return body.replace(/\n{4,}/g, "\n\n\n").trimEnd() + "\n";
}
