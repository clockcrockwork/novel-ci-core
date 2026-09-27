// NG vocabulary table reader. Input is the text of a writing-rules Markdown file;
// the table lives under a "### 文語・書き言葉の抑制" heading, first column = NG terms.

export const NG_MIN_ENTRIES = 3;

export function parseNgWords(rulesText) {
  const lines = rulesText.split(/\r?\n/);
  const start = lines.findIndex((l) => /^###\s*文語・書き言葉の抑制/.test(l.trim()));
  if (start === -1) {
    return {
      entries: null,
      error: '執筆ルールに「文語・書き言葉の抑制」見出しが見つかりません',
      code: 'ng_table_heading_missing'
    };
  }

  const entries = [];
  let inTable = false;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (/^###?\s/.test(line)) {
      break;
    }
    if (!line.startsWith('|')) {
      if (inTable) {
        break;
      }
      continue;
    }
    inTable = true;
    const cells = line.split('|').map((c) => c.trim());
    const ngCell = cells[1] ?? '';
    if (ngCell === '' || ngCell === 'NG' || /^-+$/.test(ngCell.replace(/[:\s]/g, '-'))) {
      continue;
    }
    for (const part of ngCell.split(/[/／]/)) {
      const word = part.trim();
      if (word === '') {
        continue;
      }
      if (word.startsWith('〜') || word.startsWith('～')) {
        entries.push({ word: word.slice(1), suffix: true, raw: word });
      } else {
        entries.push({ word, suffix: false, raw: word });
      }
    }
  }

  if (entries.length < NG_MIN_ENTRIES) {
    return {
      entries: null,
      error: `NG表の抽出が${entries.length}件(<${NG_MIN_ENTRIES})。執筆ルールの表形式を確認してください`,
      code: 'ng_table_too_small'
    };
  }
  return { entries, error: null, code: null };
}
