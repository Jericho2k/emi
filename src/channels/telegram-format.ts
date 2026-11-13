/**
 * Telegram renders a small HTML subset. Emi's task answers come back as
 * ordinary Markdown, so the parts Telegram can show are converted and the
 * rest is left as readable text.
 */

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function inline(text: string): string {
  // Inline code is taken out first so its contents are never read as markup.
  return text.split(/(`[^`\n]+`)/g).map((part) => {
    if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
    return escapeHtml(part)
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>')
      .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
      .replace(/(^|[\s(])\*([^*\s][^*\n]*?)\*(?=[\s).,!?:;]|$)/gm, "$1<i>$2</i>")
      .replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");
  }).join("");
}

export function toTelegramHtml(markdown: string): string {
  return markdown.split(/(```[\s\S]*?```)/g).map((part) => {
    const fence = /^```([\w+-]*)\n?([\s\S]*?)```$/.exec(part);
    if (!fence) return inline(part);
    const code = escapeHtml((fence[2] ?? "").replace(/\n$/, ""));
    return fence[1] ? `<pre><code class="language-${fence[1]}">${code}</code></pre>` : `<pre>${code}</pre>`;
  }).join("");
}

/**
 * Splits a long answer into pieces Telegram accepts (4096 characters), on
 * line breaks, closing and reopening a code block that straddles a cut.
 */
export function chunkText(text: string, limit = 3500): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let current = "", inFence = false, fenceOpener = "```";
  const flush = () => {
    if (!current.trim()) return;
    chunks.push(inFence ? `${current}\n\`\`\`` : current);
    current = inFence ? fenceOpener : "";
  };
  for (const rawLine of text.split("\n")) {
    // A single line longer than the limit is cut hard; nothing else can be done.
    const pieces = rawLine.length > limit ? rawLine.match(new RegExp(`[\\s\\S]{1,${limit}}`, "g")) ?? [rawLine] : [rawLine];
    for (const line of pieces) {
      if (current.length + line.length + 1 > limit) flush();
      current = current ? `${current}\n${line}` : line;
      if (line.trimStart().startsWith("```")) {
        inFence = !inFence;
        if (inFence) fenceOpener = line.trim();
      }
    }
  }
  inFence = false;
  flush();
  return chunks;
}
