/**
 * Convert standard Markdown to Slack mrkdwn format.
 *
 * Key transformations:
 *   - **bold** → *bold*
 *   - [text](url) → <url|text>
 *   - Markdown tables → monospaced code blocks
 *   - Headers (## text) → *text* (bold)
 *
 * Things that are the same in both formats:
 *   - _italic_ / *italic* (Slack treats * as bold, so we leave _italic_ alone)
 *   - `inline code`
 *   - ```code blocks```
 *   - > blockquotes
 *   - • bullet lists
 */

/**
 * Transform Markdown content to Slack mrkdwn.
 * Preserves code blocks untouched, transforms everything else.
 */
export function markdownToMrkdwn(md: string): string {
  // Split on code blocks to avoid transforming code content
  const parts = md.split(/(```[\s\S]*?```)/);

  return parts.map((part, i) => {
    // Odd indices are code blocks — leave them alone
    if (i % 2 === 1) return part;
    return transformNonCode(part);
  }).join('');
}

function transformNonCode(text: string): string {
  const lines = text.split('\n');
  const result: string[] = [];
  let i = 0;

  while (i < lines.length) {
    // Detect markdown table (line with pipes and a separator line following)
    if (isTableRow(lines[i]) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const tableLines: string[] = [];
      tableLines.push(lines[i]); // header
      i++; // skip separator
      i++; // move past separator
      while (i < lines.length && isTableRow(lines[i])) {
        tableLines.push(lines[i]);
        i++;
      }
      result.push(renderTableAsCode(tableLines));
      continue;
    }

    result.push(transformLine(lines[i]));
    i++;
  }

  return result.join('\n');
}

function transformLine(line: string): string {
  // Preserve inline code spans — split on them
  const parts = line.split(/(`[^`]+`)/);
  const transformed = parts.map((part, i) => {
    if (i % 2 === 1) return part; // inline code — leave alone
    return transformInline(part);
  }).join('');

  return transformed;
}

function transformInline(text: string): string {
  // Headers → bold (## Header → *Header*)
  text = text.replace(/^(#{1,6})\s+(.+)$/, (_, _hashes, content) => `*${content.trim()}*`);

  // Bold: **text** or __text__ → *text*
  text = text.replace(/\*\*(.+?)\*\*/g, '*$1*');
  text = text.replace(/__(.+?)__/g, '*$1*');

  // Images: ![alt](url) → <url|alt> (must come before links)
  text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<$2|$1>');

  // Links: [text](url) → <url|text>
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>');

  // Strikethrough: ~~text~~ → ~text~
  text = text.replace(/~~(.+?)~~/g, '~$1~');

  return text;
}

// ── Table rendering ──────────────────────────────────────────

function isTableRow(line: string): boolean {
  if (!line) return false;
  const trimmed = line.trim();
  return trimmed.includes('|') && !isTableSeparator(line);
}

function isTableSeparator(line: string): boolean {
  if (!line) return false;
  // Matches lines like |---|---|---| or | --- | --- |
  return /^\|?\s*[-:]+[-|\s:]*$/.test(line.trim());
}

function renderTableAsCode(rows: string[]): string {
  // Parse cells from each row
  const parsed = rows.map(row =>
    row.split('|')
      .map(cell => cell.trim())
      .filter((_, i, arr) => {
        // Remove empty first/last from leading/trailing pipes
        if (i === 0 && arr[i] === '') return false;
        if (i === arr.length - 1 && arr[i] === '') return false;
        return true;
      })
  );

  if (parsed.length === 0) return '';

  // Calculate column widths
  const colCount = Math.max(...parsed.map(r => r.length));
  const widths: number[] = Array(colCount).fill(0);
  for (const row of parsed) {
    for (let c = 0; c < colCount; c++) {
      widths[c] = Math.max(widths[c], (row[c] ?? '').length);
    }
  }

  // Render as aligned monospace
  const lines = parsed.map(row =>
    row.map((cell, c) => cell.padEnd(widths[c])).join('  ')
  );

  // Add separator after header
  const separator = widths.map(w => '─'.repeat(w)).join('──');
  lines.splice(1, 0, separator);

  return '```\n' + lines.join('\n') + '\n```';
}
