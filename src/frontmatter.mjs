// Minimal Markdown frontmatter reader (title / status).
// Semantics are intentionally identical to the reference implementation the
// gate was built on, so candidate IDs / line numbers stay stable across callers.

function parseKeyValue(line) {
  const m = line.match(/^\s*(title|status)\s*:\s*(.*?)\s*$/i);
  if (!m) {
    return null;
  }
  return { key: m[1].toLowerCase(), value: m[2] ?? '' };
}

export function parseMarkdownMetadata(text, scanWindowLines) {
  const lines = text.split(/\r?\n/);
  const warnings = [];

  const result = {
    title: null,
    status: null,
    warnings,
    hasMetadata: false,
    metadataEndLine: -1,
    canFix: true,
    ambiguous: false
  };

  if (lines[0]?.trim() !== '---') {
    warnings.push('metadata-block-missing');
    return result;
  }

  const max = Math.min(lines.length - 1, scanWindowLines);
  let end = -1;
  for (let i = 1; i <= max; i += 1) {
    if (lines[i]?.trim() === '---') {
      end = i;
      break;
    }
  }

  if (end === -1) {
    warnings.push('opening-dashes-without-closing-metadata-block');
    result.canFix = false;
    result.ambiguous = true;
    return result;
  }

  const blockLines = lines.slice(1, end);
  const entries = {};

  for (const line of blockLines) {
    if (line.trim() === '') {
      continue;
    }

    const parsed = parseKeyValue(line);
    if (parsed) {
      entries[parsed.key] = parsed.value;
    } else {
      result.ambiguous = true;
      result.canFix = false;
    }
  }

  if (!('title' in entries) && !('status' in entries)) {
    warnings.push('leading-dashes-look-like-scene-separator');
    result.canFix = false;
    result.ambiguous = true;
    return result;
  }

  result.hasMetadata = true;
  result.metadataEndLine = end;
  result.title = entries.title ?? null;
  result.status = entries.status ?? null;

  if (result.title == null || result.title === '') {
    warnings.push('title-missing');
  }
  if (result.status == null || result.status === '') {
    warnings.push('status-missing');
  }

  return result;
}
