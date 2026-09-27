import { LINE_TYPES, splitSentences, charLength, proseStats, parseEpisode, sceneIndexByLine } from './episode.mjs';
import { parseCardGateText } from './card.mjs';
import { parseNgWords } from './rules.mjs';

export const THRESHOLDS = {
  sentencesPerLineMin: 1.5, // RY-01
  shortLineRatioMax: 0.10, // RY-02
  shortLineChars: 13, // 12字以下を短行と数える
  avgLineLengthError: 30, // RY-03
  avgLineLengthWarn: 40,
  taRunError: 3, // RY-04
  taRunWarn: 2,
  singleSentenceParagraphRun: 3, // RY-05
  shortLinesPerSceneMax: 2, // RY-06
  cushionChainError: 3, // RY-07
  dialogueRunAvgWarn: 2.0,
  fuzzyDice: 0.65
};

// `message` is for local human-facing tools only and may quote the manuscript.
// Machine output (see output.mjs) uses only id / severity / line / code / ref.
function issue(id, severity, line, message, code, ref) {
  const out = { id, severity, line, message, code };
  if (ref !== undefined) {
    out.ref = ref;
  }
  return out;
}

// ---------- 構造 ----------

export function checkStructure(episode, phase) {
  const issues = [];
  const { meta, lines } = episode;

  for (const w of meta.warnings) {
    issues.push(issue('FM-01', 'error', 1, `frontmatter不備: ${w}`, 'frontmatter_invalid'));
  }

  for (const line of lines) {
    const trimmed = line.raw.trim();
    if (line.type === LINE_TYPES.HEADING) {
      issues.push(issue('ST-01', 'error', line.lineNo, `作業見出しの本文混入(AP-02): ${trimmed}`, 'heading_in_body'));
      continue;
    }
    if (/^\*\*(POV|タイトル|文体|L3|状態)/.test(trimmed) || /^(POV|シーン\d+)\s*[：:]/.test(trimmed)) {
      issues.push(issue('ST-02', 'error', line.lineNo, `照合メモ・ヘッダの本文混入: ${trimmed}`, 'memo_header_in_body'));
      continue;
    }
    if (/^([*＊]\s*){3,}$/.test(trimmed) || /^[─═＝-]{3,}$/.test(trimmed) && trimmed !== '---') {
      issues.push(issue('ST-03', 'error', line.lineNo, `シーン区切りは「---」のみ: ${trimmed}`, 'invalid_scene_delimiter'));
    }
  }

  const strictBrackets = phase >= 3;
  for (const line of lines) {
    const matches = line.raw.match(/＜[^＞]*＞/g);
    if (!matches) {
      continue;
    }
    for (const m of matches) {
      issues.push(
        issue(
          'ST-04',
          strictBrackets ? 'error' : 'info',
          line.lineNo,
          strictBrackets ? `＜＞が展開されずに残っています: ${m}` : `補完依頼(Phase 3で展開): ${m}`,
          strictBrackets ? 'unexpanded_completion_request' : 'completion_request'
        )
      );
    }
  }

  return issues;
}

// ---------- リズム ----------

export function checkRhythm(episode) {
  const issues = [];
  const stats = proseStats(episode.lines);
  const T = THRESHOLDS;

  if (stats.proseLineCount === 0) {
    issues.push(issue('RY-00', 'warn', 0, '地の文が検出できませんでした', 'no_prose_lines'));
    return { issues, stats };
  }

  if (stats.sentencesPerLine < T.sentencesPerLineMin) {
    issues.push(
      issue(
        'RY-01',
        'error',
        0,
        `地の文の文/行=${stats.sentencesPerLine.toFixed(2)}(基準≥${T.sentencesPerLineMin}。一文一行を段落にまとめる)`,
        'sentences_per_line_low'
      )
    );
  }

  if (stats.shortLineRatio > T.shortLineRatioMax) {
    issues.push(
      issue(
        'RY-02',
        'error',
        0,
        `一文短行率=${Math.round(stats.shortLineRatio * 100)}%(基準≤${T.shortLineRatioMax * 100}%。短行は重い一撃に限定)`,
        'short_line_rate_high'
      )
    );
  }

  if (stats.avgLineLength < T.avgLineLengthError) {
    issues.push(
      issue('RY-03', 'error', 0, `地の文平均行長=${Math.round(stats.avgLineLength)}字(基準≥${T.avgLineLengthError}字)`, 'avg_line_length_low')
    );
  } else if (stats.avgLineLength < T.avgLineLengthWarn) {
    issues.push(
      issue('RY-03', 'warn', 0, `地の文平均行長=${Math.round(stats.avgLineLength)}字(目標45〜60字にやや不足)`, 'avg_line_length_below_target')
    );
  }

  // RY-04: 文末「た。」の連続(地の文の文の並び、シーン内)
  for (const scene of episode.scenes) {
    let run = 0;
    let runStartLine = 0;
    for (const line of scene) {
      if (line.type !== LINE_TYPES.PROSE) {
        if (line.type === LINE_TYPES.DIALOGUE || line.type === LINE_TYPES.BREAK) {
          run = 0;
        }
        continue;
      }
      for (const sentence of splitSentences(line.raw.trim())) {
        if (/た[。！？!?]?$/.test(sentence)) {
          if (run === 0) {
            runStartLine = line.lineNo;
          }
          run += 1;
          if (run === T.taRunError) {
            issues.push(issue('RY-04', 'error', runStartLine, `文末「た。」が${T.taRunError}連続(L${runStartLine}〜)`, 'ta_ending_run'));
          }
        } else {
          run = 0;
        }
      }
    }
  }

  // RY-05: 一文一行段落の連打(AP-01)
  const paragraphs = buildParagraphs(episode.lines);
  let ssRun = 0;
  let ssStart = 0;
  for (const para of paragraphs) {
    const isSingle =
      para.type === 'prose' &&
      para.lines.length === 1 &&
      splitSentences(para.lines[0].raw.trim()).length <= 1;
    if (isSingle) {
      if (ssRun === 0) {
        ssStart = para.lines[0].lineNo;
      }
      ssRun += 1;
      if (ssRun === T.singleSentenceParagraphRun) {
        issues.push(
          issue(
            'RY-05',
            'error',
            ssStart,
            `一文だけの地の文段落が${T.singleSentenceParagraphRun}連続(AP-01, L${ssStart}〜)`,
            'single_sentence_paragraph_run'
          )
        );
      }
    } else {
      ssRun = 0;
    }
  }

  // RY-06: シーン内の短行回数
  episode.scenes.forEach((scene, idx) => {
    let count = 0;
    let firstLine = 0;
    for (const line of scene) {
      if (line.type !== LINE_TYPES.PROSE) {
        continue;
      }
      const trimmed = line.raw.trim();
      if (splitSentences(trimmed).length <= 1 && charLength(trimmed) < T.shortLineChars) {
        count += 1;
        if (count === T.shortLinesPerSceneMax + 1) {
          firstLine = line.lineNo;
        }
      }
    }
    if (count > T.shortLinesPerSceneMax) {
      issues.push(
        issue(
          'RY-06',
          'error',
          firstLine,
          `シーン${idx + 1}の一文短行が${count}回(基準≤${T.shortLinesPerSceneMax}回)`,
          'scene_short_line_count_high'
        )
      );
    }
  });

  // RY-07: 会話クッション(AP-04)
  issues.push(...checkCushion(paragraphs));

  return { issues, stats };
}

function buildParagraphs(lines) {
  const paragraphs = [];
  let current = null;
  for (const line of lines) {
    if (line.type === LINE_TYPES.BLANK || line.type === LINE_TYPES.BREAK) {
      current = null;
      continue;
    }
    if (line.type !== LINE_TYPES.PROSE && line.type !== LINE_TYPES.DIALOGUE) {
      current = null;
      continue;
    }
    const type = line.type === LINE_TYPES.DIALOGUE ? 'dialogue' : 'prose';
    if (!current || current.type !== type) {
      current = { type, lines: [] };
      paragraphs.push(current);
    }
    current.lines.push(line);
  }
  return paragraphs;
}

function checkCushion(paragraphs) {
  const issues = [];
  const T = THRESHOLDS;

  // 会話ラン = 空行をまたいで連続する会話段落の塊(地の文が来るまで)
  const blocks = [];
  for (const para of paragraphs) {
    const last = blocks[blocks.length - 1];
    const sentenceCount = para.lines.reduce((sum, l) => sum + splitSentences(l.raw.trim()).length, 0);
    if (last && last.type === para.type) {
      last.lineCount += para.lines.length;
      last.sentenceCount += sentenceCount;
    } else {
      blocks.push({
        type: para.type,
        lineCount: para.lines.length,
        sentenceCount,
        lineNo: para.lines[0].lineNo
      });
    }
  }

  const runs = blocks.filter((b) => b.type === 'dialogue');
  if (runs.length >= 3) {
    const avg = runs.reduce((sum, r) => sum + r.lineCount, 0) / runs.length;
    if (avg < T.dialogueRunAvgWarn) {
      issues.push(
        issue(
          'RY-07',
          'warn',
          0,
          `会話ランの平均長=${avg.toFixed(1)}行(目標≥${T.dialogueRunAvgWarn}。応酬をブロックで走らせる)`,
          'dialogue_run_short'
        )
      );
    }
  }

  // サンドイッチ: 短い会話ラン(≤2)→短い地の文クッション(1行かつ1文以下)→… の交互連鎖
  // ※「1行=複数文の段落」はクッション扱いしない
  let chain = 0;
  let chainStart = 0;
  for (let i = 0; i < blocks.length; i += 1) {
    const b = blocks[i];
    const next = blocks[i + 1];
    const isShortDialogue = b.type === 'dialogue' && b.lineCount <= 2;
    const followedByCushion = next && next.type === 'prose' && next.lineCount <= 1 && next.sentenceCount <= 1;
    if (isShortDialogue && followedByCushion) {
      if (chain === 0) {
        chainStart = b.lineNo;
      }
      chain += 1;
      if (chain === T.cushionChainError) {
        issues.push(
          issue(
            'RY-07',
            'error',
            chainStart,
            `会話1〜2行ごとに地の文クッションを挟む型が${T.cushionChainError}回連続(AP-04, L${chainStart}〜)`,
            'dialogue_cushion_chain'
          )
        );
      }
      i += 1; // クッションを消費
    } else if (b.type === 'dialogue') {
      chain = 0;
    }
  }

  return issues;
}

// ---------- 語彙・POV ----------

// gateDef: {pov, povByScene} from the card gate, or null. povRules: parsed POV
// subject rules (see pov-rules.mjs); empty/null disables POV checks.
export function checkVocabulary(episode, ngEntries, gateDef, povRules = []) {
  const issues = [];
  const defaultPov = gateDef?.pov ?? null;
  const povByScene = gateDef?.povByScene ?? null;
  const sceneOfLine = povByScene && povByScene.size > 0 ? sceneIndexByLine(episode) : null;
  const rules = povRules ?? [];

  if (povByScene) {
    for (const scene of povByScene.keys()) {
      if (scene > episode.scenes.length) {
        issues.push(
          issue('POV-00', 'error', 0, `pov_by_scene のscene ${scene} は本文のシーン数(${episode.scenes.length})を超えています`, 'pov_by_scene_out_of_range')
        );
      }
    }
  }

  for (const line of episode.lines) {
    if (line.type !== LINE_TYPES.PROSE) {
      continue;
    }
    const text = line.raw;

    for (const entry of ngEntries) {
      let idx = text.indexOf(entry.word);
      while (idx !== -1) {
        const after = text[idx + entry.word.length] ?? '';
        // 接尾型(〜とて 等)は直後が句読点・文末のときのみ違反(「とても」等の誤検出防止)
        if (!entry.suffix || after === '' || /[、。！？!?…]/.test(after)) {
          issues.push(issue('NG-01', 'error', line.lineNo, `NG語彙「${entry.raw}」(執筆ルール§1参照)`, 'ng_vocabulary'));
          break;
        }
        idx = text.indexOf(entry.word, idx + 1);
      }
    }

    let pov = defaultPov;
    if (sceneOfLine) {
      const sceneNo = (sceneOfLine.get(line.lineNo) ?? 0) + 1;
      pov = povByScene.get(sceneNo) ?? defaultPov;
    }
    for (const rule of rules) {
      if (pov === rule.pov && rule.subjects.some((subject) => text.includes(subject))) {
        issues.push(issue(rule.ruleId, 'error', line.lineNo, rule.message, 'pov_subject_mismatch'));
      }
    }
  }

  return issues;
}

// ---------- 必須セリフ ----------

function normalize(text) {
  return text
    .replace(/[～]/g, '〜')
    .replace(/[\s　]/g, '')
    .replace(/[。、！？!?…‥「」『』（）()・]/g, '');
}

function bigrams(text) {
  const set = new Set();
  const chars = [...text];
  for (let i = 0; i < chars.length - 1; i += 1) {
    set.add(chars[i] + chars[i + 1]);
  }
  return set;
}

function diceCoefficient(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (A.size === 0 || B.size === 0) {
    return a === b ? 1 : 0;
  }
  let common = 0;
  for (const bg of A) {
    if (B.has(bg)) {
      common += 1;
    }
  }
  return (2 * common) / (A.size + B.size);
}

export function checkRequiredLines(episode, gate) {
  const issues = [];
  const found = [];

  const bodyLines = episode.lines
    .filter((l) => l.type === LINE_TYPES.DIALOGUE || l.type === LINE_TYPES.PROSE)
    .map((l) => ({ lineNo: l.lineNo, norm: normalize(l.raw) }));

  for (const req of gate.requiredLines) {
    const target = normalize(req.text);
    let hit = null;

    if (req.match === 'exact') {
      hit = bodyLines.find((l) => l.norm.includes(target)) ?? null;
    } else {
      // 順序検査(RQ-02)のため、閾値以上の「最初の」行を初出とする
      for (const l of bodyLines) {
        const score = l.norm.includes(target) ? 1 : diceCoefficient(target, l.norm);
        if (score >= THRESHOLDS.fuzzyDice) {
          hit = { lineNo: l.lineNo };
          break;
        }
      }
    }

    if (!hit) {
      issues.push(
        issue('RQ-01', 'error', 0, `必須セリフ ${req.id}「${req.text}」が本文にありません(match: ${req.match})`, 'required_line_missing', req.id)
      );
    } else {
      found.push({ id: req.id, text: req.text, lineNo: hit.lineNo });
    }
  }

  for (let i = 1; i < found.length; i += 1) {
    if (found[i].lineNo < found[i - 1].lineNo) {
      issues.push(
        issue(
          'RQ-02',
          'error',
          found[i].lineNo,
          `必須セリフの順序逆転: ${found[i].id}(L${found[i].lineNo})が${found[i - 1].id}(L${found[i - 1].lineNo})より前に必要`,
          'required_line_order',
          found[i].id
        )
      );
    }
  }

  gate.forbidden.forEach((fb, idx) => {
    for (const line of episode.lines) {
      if (line.type !== LINE_TYPES.DIALOGUE && line.type !== LINE_TYPES.PROSE) {
        continue;
      }
      if (line.raw.includes(fb.text)) {
        issues.push(
          issue('RQ-03', 'error', line.lineNo, `禁止要素「${fb.text}」${fb.note ? `(${fb.note})` : ''}`, 'forbidden_element', `forbidden-${idx + 1}`)
        );
      }
    }
  });

  return issues;
}

// ---------- フェーズ ----------

// 'Phase1'/'phase2'/'Phase３'/'public' -> {num, label, warnings}
export function normalizePhase(statusRaw) {
  const warnings = [];
  if (statusRaw == null || statusRaw === '') {
    return { num: null, label: '(不明)', warnings };
  }
  const s = String(statusRaw).trim();
  if (/^public$/i.test(s)) {
    return { num: 4, label: 'public', warnings };
  }
  const m = s.match(/^phase\s*([1-4１-４])$/i);
  if (!m) {
    return { num: null, label: s, warnings };
  }
  const num = '１２３４'.includes(m[1]) ? '１２３４'.indexOf(m[1]) + 1 : Number(m[1]);
  const canonical = `Phase${num}`;
  if (s !== canonical) {
    warnings.push(`status表記ゆれ: "${s}"(推奨: ${canonical})`);
  }
  return { num, label: canonical, warnings };
}

// Pure gate evaluation over already-read texts.
// cardText === null means "no card"; povRules comes from parsePovRulesText; cardPreIssues lets a caller (legacy discovery)
// insert its own card-resolution issues at the same position as before.
export function evaluateGate({ bodyText, cardText, rulesText, povRules = [], phase = null, cardPreIssues = [] }) {
  const episode = parseEpisode(bodyText);
  const issues = [];

  const phaseInfo = normalizePhase(phase ?? episode.meta.status);
  for (const w of phaseInfo.warnings) {
    issues.push(issue('FM-02', 'warn', 1, w, 'status_notation_variant'));
  }
  if (phaseInfo.num == null) {
    issues.push(
      issue(
        'FM-02',
        'warn',
        1,
        `statusからフェーズを判定できません("${phaseInfo.label}")。Phase1基準で検査します`,
        'status_unrecognized'
      )
    );
  }
  const phaseNum = phaseInfo.num ?? 1;

  issues.push(...checkStructure(episode, phaseNum));

  // リズム(Phase1/3でenforce。Phase2/publicは計測表示のみ)
  const rhythm = checkRhythm(episode);
  if (phaseNum === 1 || phaseNum === 3) {
    issues.push(...rhythm.issues);
  }

  issues.push(...cardPreIssues);

  let gateDef = null;
  if (cardText != null) {
    const { gate, error, code } = parseCardGateText(cardText);
    if (error) {
      issues.push(issue('RQ-00', 'error', 0, error, code));
    } else if (!gate) {
      const strict = phaseNum === 1 || phaseNum === 3;
      issues.push(
        issue(
          'RQ-00',
          strict ? 'error' : 'warn',
          0,
          strict
            ? 'カードに「## 9. ゲート定義」がありません。Phase 0でカードに§9を追加してから検査してください'
            : 'カードに「## 9. ゲート定義」がありません。必須セリフ検査をスキップします',
          'card_gate_missing'
        )
      );
    } else {
      gateDef = gate;
      issues.push(...checkRequiredLines(episode, gate));
    }
  } else {
    issues.push(issue('RQ-00', 'warn', 0, '設計カード未発見。必須セリフ・POV検査をスキップします', 'card_not_provided'));
  }

  const ng = parseNgWords(rulesText);
  if (ng.error) {
    issues.push(issue('NG-00', 'error', 0, ng.error, ng.code));
  } else {
    issues.push(...checkVocabulary(episode, ng.entries, gateDef, povRules));
  }

  return {
    phaseLabel: phaseInfo.label,
    phaseNum,
    stats: rhythm.stats,
    sceneCount: episode.scenes.length,
    issues,
    pass: issues.every((i) => i.severity !== 'error')
  };
}
