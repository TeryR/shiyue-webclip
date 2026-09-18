/**
 * 把提取出来的 DOM 转成 Markdown。
 * 故意不依赖 Obsidian 的 MarkdownRenderer：纯函数、确定性、可在 Node 测试。
 */

const SKIP_TAGS = new Set([
  "SCRIPT", "STYLE", "NOSCRIPT", "IFRAME", "BUTTON", "FORM", "INPUT",
  "SELECT", "TEXTAREA", "SVG", "VIDEO", "AUDIO", "CANVAS", "NAV", "LINK", "META",
]);

function collapse(s: string): string {
  return (s || "").replace(/[\t\n\r ]+/g, " ");
}

function inlineSerialize(node: Node): string {
  if (node.nodeType === 3 /* TEXT */) {
    return collapse(node.nodeValue || "");
  }
  if (node.nodeType !== 1 /* ELEMENT */) return "";
  const el = node as HTMLElement;
  const tag = el.tagName;
  if (SKIP_TAGS.has(tag)) return "";
  if (tag === "BR") return "\n";
  if (tag === "IMG") {
    const src = el.getAttribute("src") || el.getAttribute("data-src") || "";
    return src ? `![图片](${src})` : "";
  }
  const inner = Array.from(el.childNodes).map(inlineSerialize).join("");
  switch (tag) {
    case "A": {
      const href = el.getAttribute("href") || "";
      const text = collapse(inner).trim();
      if (!href) return inner;
      if (!text || text === href) return `<${href}>`;
      return `[${text}](${href})`;
    }
    case "STRONG":
    case "B": {
      const t = collapse(inner).trim();
      return t ? `**${t}**` : "";
    }
    case "EM":
    case "I": {
      const t = collapse(inner).trim();
      return t ? `*${t}*` : "";
    }
    case "CODE":
      return "`" + (el.textContent || "") + "`";
    case "DEL":
    case "S": {
      const t = collapse(inner).trim();
      return t ? `~~${t}~~` : "";
    }
    default:
      return inner;
  }
}

function markdownTable(el: Element): string[] {
  const rows = Array.from(el.querySelectorAll("tr")).slice(0, 50);
  if (!rows.length) {
    const t = collapse(el.textContent || "").trim();
    return t ? [t] : [];
  }
  const lines: string[] = [];
  rows.forEach((row, ri) => {
    const cells = Array.from(row.children).map((c) =>
      collapse(c.textContent || "").trim().replace(/\|/g, "\\|"),
    );
    if (!cells.length) return;
    lines.push("| " + cells.join(" | ") + " |");
    if (ri === 0) lines.push("|" + cells.map(() => " --- ").join("|") + "|");
  });
  return lines.length ? [lines.join("\n")] : [];
}

function isBlockEl(n: Node): boolean {
  if (n.nodeType !== 1) return false;
  const tag = (n as HTMLElement).tagName;
  return (
    ["P", "DIV", "SECTION", "ARTICLE", "MAIN", "HEADER", "FOOTER", "ASIDE",
      "UL", "OL", "BLOCKQUOTE", "PRE", "TABLE", "FIGURE", "FIGCAPTION",
      "H1", "H2", "H3", "H4", "H5", "H6", "HR", "DL", "DETAILS"].includes(tag)
  );
}

function blockSerialize(el: Element): string[] {
  const tag = el.tagName;
  switch (tag) {
    case "H1": case "H2": case "H3": case "H4": case "H5": case "H6": {
      const level = parseInt(tag.slice(1), 10);
      const t = collapse(el.textContent || "").trim();
      return t ? [`${"#".repeat(level)} ${t}`] : [];
    }
    case "P": {
      const t = inlineSerialize(el).trim();
      return t ? [t] : [];
    }
    case "IMG": {
      const t = inlineSerialize(el).trim();
      return t ? [t] : [];
    }
    case "UL": case "OL": {
      const items: string[] = [];
      let ordered = 0;
      for (const li of Array.from(el.children)) {
        if (li.tagName !== "LI") continue;
        ordered += 1;
        const prefix = tag === "OL" ? `${ordered}. ` : "- ";
        const t = inlineSerialize(li).trim().replace(/\n+/g, " ");
        if (t) items.push(prefix + t);
      }
      return items.length ? [items.join("\n")] : [];
    }
    case "BLOCKQUOTE": {
      const sub = blocksSerialize(el)
        .map((b) => b.split("\n").map((l) => "> " + l).join("\n"))
        .join("\n>\n");
      return sub ? [sub] : [];
    }
    case "PRE": {
      const t = (el.textContent || "").replace(/\n+$/, "");
      return t ? ["```\n" + t + "\n```"] : [];
    }
    case "HR":
      return ["---"];
    case "TABLE":
      return markdownTable(el);
    case "FIGCAPTION": {
      const t = collapse(el.textContent || "").trim();
      return t ? [`*${t}*`] : [];
    }
    case "FIGURE": case "DETAILS": case "DL":
      return blocksSerialize(el);
    default: {
      // DIV / SECTION 等容器
      const hasBlock = Array.from(el.childNodes).some(isBlockEl);
      if (hasBlock) return blocksSerialize(el);
      const t = inlineSerialize(el).trim();
      return t ? [t] : [];
    }
  }
}

function blocksSerialize(root: Node): string[] {
  const out: string[] = [];
  let buf = "";
  const flush = () => {
    const t = buf.replace(/\s+\n/g, "\n").trim();
    if (t) out.push(t);
    buf = "";
  };
  for (const node of Array.from(root.childNodes)) {
    if (isBlockEl(node)) {
      flush();
      out.push(...blockSerialize(node as Element));
    } else {
      buf += inlineSerialize(node);
    }
  }
  flush();
  return out;
}

/** DOM → Markdown 文本 */
export function domToMarkdown(root: Element): string {
  const blocks = blocksSerialize(root);
  return blocks.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** 收集正文里的图片（绝对地址、去重、限量） */
export function collectImages(root: Element, baseUrl: string, cap = 30): string[] {
  const seen = new Set<string>();
  const imgs: string[] = [];
  for (const img of Array.from(root.querySelectorAll("img"))) {
    const raw =
      img.getAttribute("src") ||
      img.getAttribute("data-src") ||
      img.getAttribute("data-original") ||
      "";
    if (!raw || raw.startsWith("data:image")) continue;
    if (/\.svg(\?|$)/i.test(raw)) continue;
    let abs = raw;
    if (!/^https?:\/\//i.test(raw)) {
      try {
        abs = new URL(raw, baseUrl).href;
      } catch {
        continue;
      }
    }
    if (!/^https?:\/\//i.test(abs)) continue;
    if (seen.has(abs)) continue;
    seen.add(abs);
    imgs.push(abs);
    if (imgs.length >= cap) break;
  }
  return imgs;
}
