export const TOOL = 'novel-ci-core';

const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

export function safeId(value) {
  return typeof value === 'string' && SAFE_TOKEN.test(value) ? value : 'invalid-id';
}

const round = (value, digits) => {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
};

const issueItem = (issue) => {
  const out = {
    rule_id: safeId(issue.id),
    severity: issue.severity,
    line: Number.isInteger(issue.line) ? issue.line : 0,
    message_code: safeId(issue.code ?? 'unspecified')
  };
  if (issue.ref !== undefined) out.ref_id = safeId(issue.ref);
  return out;
};

export function gateJson(result, files, version) {
  const stats = result.stats;
  return {
    tool: TOOL,
    version,
    command: 'gate',
    status: result.pass ? 'PASS' : 'FAIL',
    phase: /^(Phase[1-4]|public)$/.test(result.phaseLabel) ? result.phaseLabel : 'unrecognized',
    files,
    scene_count: result.sceneCount,
    errors: result.issues.filter((i) => i.severity === 'error').map(issueItem),
    warnings: result.issues.filter((i) => i.severity === 'warn').map(issueItem),
    info_count: result.issues.filter((i) => i.severity === 'info').length,
    metrics: {
      sentences_per_line: round(stats.sentencesPerLine, 2),
      short_line_rate: round(stats.shortLineRatio, 4),
      avg_line_length: round(stats.avgLineLength, 1),
      prose_line_count: stats.proseLineCount,
      short_line_count: stats.shortLineCount
    }
  };
}

export function candidateItem(candidate) {
  return {
    candidate_id: safeId(candidate.id),
    rule_id: safeId(candidate.check),
    category: safeId(candidate.category),
    start_line: candidate.line,
    end_line: candidate.endLine ?? candidate.line,
    scene: candidate.scene
  };
}

export function scanJson(candidates, files, version) {
  return {
    tool: TOOL,
    version,
    command: 'p15_scan',
    status: 'PASS',
    files,
    candidate_count: candidates.length,
    candidates: candidates.map(candidateItem)
  };
}

export function verifyJson(verify, candidates, recordPresent, files, version) {
  return {
    tool: TOOL,
    version,
    command: 'p15_verify',
    status: verify.pass ? 'PASS' : 'FAIL',
    files,
    record_present: recordPresent,
    candidate_count: candidates.length,
    judged_count: candidates.length - verify.unjudged.length,
    unjudged_count: verify.unjudged.length,
    unresolved_count: verify.unresolved.length,
    contradiction_count: verify.contradictions.length,
    invalid_count: verify.structured.length,
    candidates: candidates.map(candidateItem),
    unjudged_ids: verify.unjudged.map(safeId),
    unresolved_ids: verify.unresolved.map(safeId),
    contradiction_ids: verify.contradictions.map(safeId),
    orphan_ids: verify.orphans.map(safeId),
    invalid: verify.structured.map((item) => ({
      message_code: safeId(item.code),
      id: item.id == null ? null : safeId(item.id)
    }))
  };
}

export function errorJson(code, option, version) {
  const output = { tool: TOOL, version, status: 'ERROR', error: { code: safeId(code) } };
  if (option) output.error.option = safeId(String(option).replace(/^--/, ''));
  return output;
}

export function assertSanitized(value, allowedStrings = new Set()) {
  function visit(node) {
    if (node == null || typeof node === 'number' || typeof node === 'boolean') return;
    if (typeof node === 'string') {
      if (SAFE_TOKEN.test(node) || allowedStrings.has(node)) return;
      throw new Error('output_not_sanitized');
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    for (const item of Object.values(node)) visit(item);
  }
  visit(value);
  return value;
}
