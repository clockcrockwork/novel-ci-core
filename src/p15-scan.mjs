import { createHash } from 'node:crypto';
import { LINE_TYPES, splitSentences, charLength, sceneIndexByLine } from './episode.mjs';

// Thresholds mirror the consuming project's P15 standard. Change them only together with
// that standard and a fixture replay (see README: versioning).
// severityは全て candidate（違反ではなく判断候補）。数値だけで合否を決めない。
export const P15_THRESHOLDS = {
  // P15-01: シーン内の地の文の文長変動係数(CV)。参照コーパス実測の下限(約0.30)未満を候補化
  sentenceLengthCvMin: 0.28,
  sentenceLengthMinSamples: 10,
  // P15-02: 段落長(文数・文字数)の均質化
  paragraphMinSamples: 6,
  paragraphLengthCvMin: 0.3,
  // P15-03: 文末パターン(末尾2字)の窓内反復。「た。」はRY-04が担当するため除外。
  // 参照コーパスにも「ない。」4回/8文が出るため、5回以上を候補化
  endingWindow: 8,
  endingRepeatMax: 4,
  // P15-04: 同一の文頭(先頭2字)で始まる文の連続
  headRunMax: 2,
  // P15-05: 短文(20字以下)の連続
  shortSentenceChars: 20,
  shortSentenceRunMax: 3,
  // P15-07: シーン内の同一語句(漢字・カタカナ4字以上)の反復。シーンの主題語は参照コーパスにも出るため高頻度のみ
  tokenRepeatMax: 7,
  // P15-08: 平易さの逸脱
  commasPerSentenceMax: 3,
  sentenceCharsMax: 120,
  kanjiRatioMax: 0.45,
  kanjiRatioMinChars: 200
};

// P15-06 翻訳調・硬い表現のパターン表
export const TRANSLATION_LIKE_PATTERNS = [
  'することができ',
  'することが出来',
  'と言っても過言ではな',
  'に他ならな',
  'を余儀なくされ',
  'と言えるだろう',
  'といえよう',
  'のである',
  'なのである',
  'という事実',
  'という存在'
];

// P15-07 言い直しマーカー
export const RESTATEMENT_MARKERS = [
  'つまり',
  '要するに',
  '言い換えれば',
  'すなわち',
  'ということだ',
  'というわけだ'
];

const CATEGORY = {
  'P15-01': 'rhythm',
  'P15-02': 'rhythm',
  'P15-03': 'repetition',
  'P15-04': 'repetition',
  'P15-05': 'rhythm',
  'P15-06': 'translation_like',
  'P15-07': 'over_explanation',
  'P15-08': 'readability'
};

// 候補ID: 行番号に依存しない内容ベースの署名(局所修正後も無関係な候補のIDが変わらないように)。
// 安定性の対象は「シーン内の局所編集」まで。シーン自体の挿入・削除でsceneIdxがずれる変更
// (P1構造チェック・Phase 3側の管轄)は対象外で、以降のシーンの候補IDが再生成される
function candidateId(check, sceneIdx, core) {
  const hash = createHash('sha1').update(`${check}|${sceneIdx}|${core}`).digest('hex').slice(0, 6);
  return `${check}-${hash}`;
}

function finding(check, sceneIdx, core, line, endLine, problem) {
  return {
    id: candidateId(check, sceneIdx, core),
    check,
    scene: sceneIdx + 1,
    category: CATEGORY[check],
    line,
    endLine: endLine ?? line,
    location: `L${line}${endLine && endLine !== line ? `-L${endLine}` : ''} シーン${sceneIdx + 1}`,
    problem
  };
}

export function mean(xs) {
  if (xs.length === 0) {
    return 0;
  }
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function cv(xs) {
  if (xs.length === 0) {
    return 0;
  }
  const m = mean(xs);
  if (m === 0) {
    return 0;
  }
  const variance = xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length;
  return Math.sqrt(variance) / m;
}

// シーンごとの地の文の文リスト [{text, line}]
function proseSentencesByScene(episode) {
  return episode.scenes.map((scene) =>
    scene
      .filter((l) => l.type === LINE_TYPES.PROSE)
      .flatMap((l) => splitSentences(l.raw.trim()).map((text) => ({ text, line: l.lineNo })))
  );
}

// 地の文段落(空行・会話・区切りで分割) [{lines: [...], sentenceCount, charCount}]
function proseParagraphs(episode) {
  const paragraphs = [];
  let current = null;
  for (const line of episode.lines) {
    if (line.type !== LINE_TYPES.PROSE) {
      current = null;
      continue;
    }
    if (!current) {
      current = { firstLine: line.lineNo, sentenceCount: 0, charCount: 0 };
      paragraphs.push(current);
    }
    const trimmed = line.raw.trim();
    current.sentenceCount += splitSentences(trimmed).length;
    current.charCount += charLength(trimmed);
  }
  return paragraphs;
}

function sentenceEnding(text) {
  const stripped = text.replace(/[。！？!?…‥」』）\s]+$/u, '');
  return [...stripped].slice(-2).join('');
}

function checkSentenceLengthUniformity(sentencesByScene, T) {
  const out = [];
  sentencesByScene.forEach((sentences, sceneIdx) => {
    if (sentences.length === 0 || sentences.length < T.sentenceLengthMinSamples) {
      return;
    }
    const lengths = sentences.map((s) => charLength(s.text));
    const c = cv(lengths);
    if (c < T.sentenceLengthCvMin) {
      out.push(
        finding(
          'P15-01',
          sceneIdx,
          'uniform-sentence-length',
          sentences[0].line,
          sentences[sentences.length - 1].line,
          `文長の変動係数=${c.toFixed(2)}(基準<${T.sentenceLengthCvMin}で候補化)。文長が機械的に均質。長短の意図的な混在があるか判断する`
        )
      );
    }
  });
  return out;
}

function checkParagraphUniformity(episode, T) {
  const paragraphs = proseParagraphs(episode);
  if (paragraphs.length === 0 || paragraphs.length < T.paragraphMinSamples) {
    return [];
  }
  const sentenceCounts = paragraphs.map((p) => p.sentenceCount);
  const charCounts = paragraphs.map((p) => p.charCount);
  const allSame = new Set(sentenceCounts).size === 1;
  const c = cv(charCounts);
  if (allSame || c < T.paragraphLengthCvMin) {
    return [
      finding(
        'P15-02',
        0,
        'uniform-paragraph-length',
        paragraphs[0].firstLine,
        paragraphs[paragraphs.length - 1].firstLine,
        allSame
          ? `全${paragraphs.length}段落が同じ文数(${sentenceCounts[0]}文)。段落構成が機械的に均質`
          : `地の文段落の文字数変動係数=${c.toFixed(2)}(基準<${T.paragraphLengthCvMin}で候補化)。段落長が機械的に均質`
      )
    ];
  }
  return [];
}

function checkEndingRepetition(sentencesByScene, T) {
  const out = [];
  const reported = new Set();
  sentencesByScene.forEach((sentences, sceneIdx) => {
    for (let i = 0; i + T.endingWindow <= sentences.length; i += 1) {
      const window = sentences.slice(i, i + T.endingWindow);
      const counts = new Map();
      for (const s of window) {
        const end = sentenceEnding(s.text);
        if (end === '' || end.endsWith('た')) {
          continue; // 「た。」連続はRY-04が担当
        }
        counts.set(end, (counts.get(end) ?? 0) + 1);
      }
      for (const [end, count] of counts) {
        if (count > T.endingRepeatMax) {
          const id = `${sceneIdx}:${end}`;
          if (reported.has(id)) {
            continue;
          }
          reported.add(id);
          const first = window.find((s) => sentenceEnding(s.text) === end);
          out.push(
            finding(
              'P15-03',
              sceneIdx,
              `ending:${end}`,
              first.line,
              window[window.length - 1].line,
              `語尾「〜${end}。」が${T.endingWindow}文中${count}回(基準≤${T.endingRepeatMax})。同一語尾の反復`
            )
          );
        }
      }
    }
  });
  return out;
}

function checkHeadRepetition(sentencesByScene, T) {
  const out = [];
  sentencesByScene.forEach((sentences, sceneIdx) => {
    let run = 1;
    for (let i = 1; i <= sentences.length; i += 1) {
      const prevHead = [...sentences[i - 1].text].slice(0, 2).join('');
      const head = i < sentences.length ? [...sentences[i].text].slice(0, 2).join('') : null;
      if (head !== null && head === prevHead) {
        run += 1;
        continue;
      }
      if (run > T.headRunMax) {
        const start = sentences[i - run];
        out.push(
          finding(
            'P15-04',
            sceneIdx,
            `head:${prevHead}`,
            start.line,
            sentences[i - 1].line,
            `文頭「${prevHead}」で始まる文が${run}連続(基準≤${T.headRunMax})。文頭・接続の反復`
          )
        );
      }
      run = 1;
    }
  });
  return out;
}

function checkShortSentenceRun(sentencesByScene, T) {
  const out = [];
  sentencesByScene.forEach((sentences, sceneIdx) => {
    let run = 0;
    let startIdx = 0;
    for (let i = 0; i <= sentences.length; i += 1) {
      const isShort = i < sentences.length && charLength(sentences[i].text) <= T.shortSentenceChars;
      if (isShort) {
        if (run === 0) {
          startIdx = i;
        }
        run += 1;
        continue;
      }
      if (run > T.shortSentenceRunMax) {
        out.push(
          finding(
            'P15-05',
            sceneIdx,
            `short-run:${startIdx}`,
            sentences[startIdx].line,
            sentences[i - 1].line,
            `${T.shortSentenceChars}字以下の短文が${run}連続(基準≤${T.shortSentenceRunMax})。AI的短文連打か、意図した圧縮(カード§4の温度速度が高温/応酬/加速ならaccepted候補)かを判断する`
          )
        );
      }
      run = 0;
    }
  });
  return out;
}

// 同一シーン内の同一パターンn回目、をIDの核にする(行番号のずれでIDが変わらないように)
function occurrenceCounter() {
  const counts = new Map();
  return (key) => {
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    return n;
  };
}

function checkTranslationLike(episode, sceneOfLine) {
  const out = [];
  const occ = occurrenceCounter();
  for (const line of episode.lines) {
    if (line.type !== LINE_TYPES.PROSE) {
      continue;
    }
    const sceneIdx = sceneOfLine.get(line.lineNo) ?? 0;
    for (const pattern of TRANSLATION_LIKE_PATTERNS) {
      if (line.raw.includes(pattern)) {
        const n = occ(`${sceneIdx}:${pattern}`);
        out.push(
          finding(
            'P15-06',
            sceneIdx,
            `pattern:${pattern}:${n}`,
            line.lineNo,
            line.lineNo,
            `翻訳調・硬い表現「${pattern}」(パターン表はフェーズゲート基準§3.5)`
          )
        );
      }
    }
  }
  return out;
}

function checkRestatement(episode, sentencesByScene, sceneOfLine, T) {
  const out = [];
  const occ = occurrenceCounter();
  for (const line of episode.lines) {
    if (line.type !== LINE_TYPES.PROSE) {
      continue;
    }
    const sceneIdx = sceneOfLine.get(line.lineNo) ?? 0;
    for (const marker of RESTATEMENT_MARKERS) {
      if (line.raw.includes(marker)) {
        const n = occ(`${sceneIdx}:${marker}`);
        out.push(
          finding(
            'P15-07',
            sceneIdx,
            `marker:${marker}:${n}`,
            line.lineNo,
            line.lineNo,
            `言い直しマーカー「${marker}」。直前の内容の言い直し・意味の重複になっていないか判断する`
          )
        );
      }
    }
  }

  // シーン内の同一語句(漢字・カタカナ4字以上)の反復
  sentencesByScene.forEach((sentences, sceneIdx) => {
    const counts = new Map();
    for (const s of sentences) {
      const tokens = s.text.match(/[一-鿿]{4,}|[゠-ヿー]{4,}/gu) ?? [];
      for (const token of new Set(tokens)) {
        const entry = counts.get(token) ?? { count: 0, firstLine: s.line, lastLine: s.line };
        entry.count += 1;
        entry.lastLine = s.line;
        counts.set(token, entry);
      }
    }
    for (const [token, entry] of counts) {
      if (entry.count > T.tokenRepeatMax) {
        out.push(
          finding(
            'P15-07',
            sceneIdx,
            `token:${token}`,
            entry.firstLine,
            entry.lastLine,
            `語句「${token}」がシーン内の${entry.count}文に出現(基準≤${T.tokenRepeatMax})。説明の重複か、意図した反復かを判断する`
          )
        );
      }
    }
  });
  return out;
}

function checkReadability(episode, sentencesByScene, sceneOfLine, T) {
  const out = [];
  const occ = occurrenceCounter();
  for (const line of episode.lines) {
    if (line.type !== LINE_TYPES.PROSE) {
      continue;
    }
    const sceneIdx = sceneOfLine.get(line.lineNo) ?? 0;
    for (const sentence of splitSentences(line.raw.trim())) {
      const commas = (sentence.match(/、/g) ?? []).length;
      const len = charLength(sentence);
      const head = [...sentence].slice(0, 8).join('');
      if (commas > T.commasPerSentenceMax) {
        out.push(
          finding(
            'P15-08',
            sceneIdx,
            `commas:${head}:${occ(`${sceneIdx}:commas:${head}`)}`,
            line.lineNo,
            line.lineNo,
            `一文に読点${commas}個(基準≤${T.commasPerSentenceMax})。情報過積載・平易さの逸脱候補`
          )
        );
      }
      if (len > T.sentenceCharsMax) {
        out.push(
          finding(
            'P15-08',
            sceneIdx,
            `long:${head}:${occ(`${sceneIdx}:long:${head}`)}`,
            line.lineNo,
            line.lineNo,
            `一文${len}字(基準≤${T.sentenceCharsMax}字)。意図した長文か情報過積載かを判断する`
          )
        );
      }
    }
  }

  sentencesByScene.forEach((sentences, sceneIdx) => {
    const text = sentences.map((s) => s.text).join('');
    const chars = [...text.replace(/[\s、。！？!?…‥]/gu, '')];
    if (chars.length < T.kanjiRatioMinChars) {
      return;
    }
    const kanji = chars.filter((c) => /[一-鿿]/u.test(c)).length;
    const ratio = kanji / chars.length;
    if (ratio > T.kanjiRatioMax) {
      out.push(
        finding(
          'P15-08',
          sceneIdx,
          'kanji-ratio',
          sentences[0].line,
          sentences[sentences.length - 1].line,
          `シーンの漢字率=${Math.round(ratio * 100)}%(基準≤${Math.round(T.kanjiRatioMax * 100)}%)。硬さ・平易さの逸脱候補`
        )
      );
    }
  });
  return out;
}

// 全チェックを実行し、候補一覧を返す。range={start,end}で行範囲を限定(Phase 3の接合検査用)
export function scanP15(episode, options = {}) {
  const T = { ...P15_THRESHOLDS, ...(options.thresholds ?? {}) };
  const sentencesByScene = proseSentencesByScene(episode);

  const sceneOfLine = sceneIndexByLine(episode);

  const findings = [
    ...checkSentenceLengthUniformity(sentencesByScene, T),
    ...checkParagraphUniformity(episode, T),
    ...checkEndingRepetition(sentencesByScene, T),
    ...checkHeadRepetition(sentencesByScene, T),
    ...checkShortSentenceRun(sentencesByScene, T),
    ...checkTranslationLike(episode, sceneOfLine),
    ...checkRestatement(episode, sentencesByScene, sceneOfLine, T),
    ...checkReadability(episode, sentencesByScene, sceneOfLine, T)
  ];

  let filtered = findings;
  if (options.range) {
    const { start, end } = options.range;
    filtered = findings.filter((f) => f.line <= end && (f.endLine ?? f.line) >= start);
  }

  return filtered.sort((a, b) => a.line - b.line || a.check.localeCompare(b.check));
}
