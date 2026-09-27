import { parseMarkdownMetadata } from './frontmatter.mjs';

const SCAN_WINDOW_LINES = 10;
const DIALOGUE_OPENERS = ['「', '『', '（', '(', '【', '＜'];
const SENTENCE_ENDERS = /[。！？!?]/;

export const LINE_TYPES = {
  BLANK: 'blank',
  BREAK: 'break',
  HEADING: 'heading',
  DIALOGUE: 'dialogue',
  PROSE: 'prose'
};

function classifyLine(raw) {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return LINE_TYPES.BLANK;
  }
  if (trimmed === '---') {
    return LINE_TYPES.BREAK;
  }
  if (/^#/.test(trimmed)) {
    return LINE_TYPES.HEADING;
  }
  const head = trimmed[0];
  if (DIALOGUE_OPENERS.includes(head)) {
    return LINE_TYPES.DIALOGUE;
  }
  return LINE_TYPES.PROSE;
}

export function splitSentences(text) {
  const sentences = [];
  let current = '';
  for (const ch of text) {
    current += ch;
    if (SENTENCE_ENDERS.test(ch)) {
      if (current.trim() !== '') {
        sentences.push(current.trim());
      }
      current = '';
    }
  }
  if (current.trim() !== '') {
    sentences.push(current.trim());
  }
  return sentences;
}

export function charLength(text) {
  return [...text].length;
}

// Frontmatter lines are excluded from `lines`, so a title never takes part in
// required-line matching or rhythm metrics.
export function parseEpisode(text) {
  const meta = parseMarkdownMetadata(text, SCAN_WINDOW_LINES);
  const allLines = text.split(/\r?\n/);
  const bodyStart = meta.hasMetadata ? meta.metadataEndLine + 1 : 0;

  const lines = [];
  for (let i = bodyStart; i < allLines.length; i += 1) {
    const raw = allLines[i];
    lines.push({
      lineNo: i + 1,
      raw,
      type: classifyLine(raw)
    });
  }

  const scenes = [[]];
  for (const line of lines) {
    if (line.type === LINE_TYPES.BREAK) {
      scenes.push([]);
      continue;
    }
    scenes[scenes.length - 1].push(line);
  }

  return { meta, lines, scenes };
}

// lineNo -> 0-based scene index
export function sceneIndexByLine(episode) {
  const map = new Map();
  episode.scenes.forEach((scene, idx) => {
    for (const line of scene) {
      map.set(line.lineNo, idx);
    }
  });
  return map;
}

export function proseStats(lines) {
  const proseLines = lines.filter((l) => l.type === LINE_TYPES.PROSE);
  let sentenceCount = 0;
  let charCount = 0;
  let shortCount = 0;

  for (const line of proseLines) {
    const trimmed = line.raw.trim();
    const sentences = splitSentences(trimmed);
    const len = charLength(trimmed);
    sentenceCount += sentences.length;
    charCount += len;
    if (sentences.length <= 1 && len < 10) {
      shortCount += 1;
    }
  }

  const count = proseLines.length;
  return {
    proseLineCount: count,
    sentencesPerLine: count > 0 ? sentenceCount / count : 0,
    shortLineRatio: count > 0 ? shortCount / count : 0,
    shortLineCount: shortCount,
    avgLineLength: count > 0 ? charCount / count : 0
  };
}
