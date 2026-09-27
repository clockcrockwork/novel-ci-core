import { parse as parseYaml } from 'yaml';

export const STATUS_VALUES = ['resolved_by_revision', 'accepted_as_intentional', 'not_applicable', 'unresolved'];

export const CATEGORY_VALUES = ['rhythm', 'repetition', 'translation_like', 'readability', 'pov', 'over_explanation', 'other'];

export const SCOPE_VALUES = ['local', 'scene', 'full'];

export class RecordFormatError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// Parse judgment-record YAML text. Throws RecordFormatError (never includes source text in code).
export function parseRecordText(text, label = 'judgments') {
  let data;
  try {
    data = parseYaml(text, { maxAliasCount: 0 });
  } catch {
    throw new RecordFormatError('record_yaml_parse_error', `判断記録のYAMLを解釈できません: ${label}`);
  }
  if (data == null || typeof data !== 'object' || Array.isArray(data)) {
    throw new RecordFormatError('record_not_a_mapping', `判断記録の形式が不正です(YAMLマップではありません): ${label}`);
  }
  if (data.findings == null) {
    data.findings = [];
  }
  if (!Array.isArray(data.findings)) {
    throw new RecordFormatError('record_findings_not_a_list', `判断記録の findings がリストではありません: ${label}`);
  }
  return data;
}

// Structured validity problems: [{code, id|null, message}]
export function validateRecordStructured(record) {
  const problems = [];
  const push = (code, id, message) => problems.push({ code, id: id ?? null, message });
  if (!record || !Array.isArray(record.findings)) {
    push('record_findings_not_a_list', null, '判断記録の形式が不正です(findingsが配列ではありません)');
    return problems;
  }
  const seen = new Set();
  for (const f of record.findings) {
    const label = f?.id ?? '(idなし)';
    if (!f || typeof f !== 'object') {
      push('finding_not_a_mapping', null, 'findingsにマップでない要素があります');
      continue;
    }
    if (!f.id) {
      push('finding_id_missing', null, 'idのないfindingがあります');
    } else if (seen.has(f.id)) {
      push('finding_id_duplicate', f.id, `idが重複しています: ${f.id}`);
    } else {
      seen.add(f.id);
    }
    if (!STATUS_VALUES.includes(f.status)) {
      push('finding_status_invalid', f.id, `${label}: statusが不正です("${f.status}"。許可: ${STATUS_VALUES.join('|')})`);
    }
    if (f.category != null && !CATEGORY_VALUES.includes(f.category)) {
      push('finding_category_invalid', f.id, `${label}: categoryが不正です("${f.category}"。許可: ${CATEGORY_VALUES.join('|')})`);
    }
    if (f.revision_scope != null && !SCOPE_VALUES.includes(f.revision_scope)) {
      push('finding_scope_invalid', f.id, `${label}: revision_scopeが不正です("${f.revision_scope}"。許可: ${SCOPE_VALUES.join('|')})`);
    }
    if (f.status === 'resolved_by_revision' && !f.revision_policy) {
      push('finding_revision_policy_missing', f.id, `${label}: 修正済みなのにrevision_policy(維持したビート・必須会話・意味)がありません`);
    }
    if (f.status === 'accepted_as_intentional' && !f.reason) {
      push('finding_reason_missing', f.id, `${label}: 意図的維持なのにreason(なぜこの場面・POVでは維持するか)がありません`);
    }
  }
  return problems;
}

export function validateRecord(record) {
  return validateRecordStructured(record).map((p) => p.message);
}

// Merge scan candidates into a record (idempotent). Existing judgments are kept;
// only unknown candidates get an `unresolved` stub. Returns a new object.
export function mergeCandidates(record, candidates, meta) {
  const next = {
    ...record,
    episode: record?.episode ?? meta.episode,
    scanned_at: meta.scannedAt,
    findings: record?.findings ? [...record.findings] : []
  };
  const known = new Set(next.findings.filter((f) => f && typeof f === 'object' && f.id).map((f) => f.id));
  let added = 0;
  for (const c of candidates) {
    if (known.has(c.id)) {
      continue;
    }
    next.findings.push({
      id: c.id,
      location: c.location,
      category: c.category,
      problem: c.problem,
      reason: '',
      revision_scope: 'local',
      revision_policy: '',
      status: 'unresolved'
    });
    added += 1;
  }
  return { record: next, added };
}

// PASS iff (a) every current candidate has a judgment (b) no `unresolved`
// (c) the record is valid (d) candidates recorded as resolved_by_revision no longer appear.
export function verifyRecord(record, candidates) {
  const problems = [];

  if (!record) {
    problems.push('判断記録がありません(--initで作成してください)');
    return {
      pass: false,
      problems,
      structured: [],
      unjudged: candidates.map((c) => c.id),
      unresolved: [],
      contradictions: [],
      orphans: []
    };
  }

  const structured = validateRecordStructured(record);
  problems.push(...structured.map((p) => p.message));

  const validFindings = Array.isArray(record.findings)
    ? record.findings.filter((f) => f && typeof f === 'object' && f.id)
    : [];
  const byId = new Map(validFindings.map((f) => [f.id, f]));
  const unjudged = [];
  const contradictions = [];
  for (const c of candidates) {
    const f = byId.get(c.id);
    if (!f) {
      unjudged.push(c.id);
      problems.push(`候補 ${c.id}(${c.location})に対応する判断がありません(--initで取り込み、判定してください)`);
    } else if (f.status === 'resolved_by_revision') {
      contradictions.push(c.id);
      problems.push(
        `矛盾: 候補 ${c.id}(${c.location})はresolved_by_revisionと記録されていますが、再scanで依然として検出されています。修正が反映されていないか、statusの見直し(accepted_as_intentional等)が必要です`
      );
    }
  }

  const unresolved = validFindings.filter((f) => f.status === 'unresolved').map((f) => f.id);
  for (const id of unresolved) {
    problems.push(`未解決: ${id}(判断・修正が完了していません)`);
  }

  // Judgments that match no current candidate (history, or source-aware-only records).
  const candidateIds = new Set(candidates.map((c) => c.id));
  const orphans = validFindings.filter((f) => !candidateIds.has(f.id)).map((f) => f.id);

  return { pass: problems.length === 0, problems, structured, unjudged, unresolved, contradictions, orphans };
}
