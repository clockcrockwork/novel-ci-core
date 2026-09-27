import { parse as parseYaml } from 'yaml';

// POV subject rules are project configuration, supplied by the caller as an exact file.
// The core ships no character names.
//
// version: 1
// pov_rules:
//   - rule_id: POV-01
//     pov: <POV character>
//     forbidden_subjects: [<literal substring>, ...]   # literal match, no regex
//     message: <optional local-console wording>

const RULE_ID = /^POV-[0-9]{2}$/;

export class PovRulesError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function isShortString(v, max) {
  return typeof v === 'string' && v.trim() !== '' && [...v].length <= max;
}

export function parsePovRulesText(text) {
  let data;
  try {
    data = parseYaml(text, { maxAliasCount: 0 });
  } catch {
    throw new PovRulesError('pov_rules_yaml_parse_error');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.version !== 1 || !Array.isArray(data.pov_rules)) {
    throw new PovRulesError('pov_rules_invalid');
  }
  const seen = new Set();
  return data.pov_rules.map((r) => {
    if (
      !r ||
      typeof r !== 'object' ||
      !RULE_ID.test(String(r.rule_id)) ||
      seen.has(r.rule_id) ||
      !isShortString(r.pov, 32) ||
      !Array.isArray(r.forbidden_subjects) ||
      r.forbidden_subjects.length === 0 ||
      !r.forbidden_subjects.every((s) => isShortString(s, 32)) ||
      (r.message !== undefined && !isShortString(r.message, 120))
    ) {
      throw new PovRulesError('pov_rules_invalid');
    }
    seen.add(r.rule_id);
    return {
      ruleId: r.rule_id,
      pov: r.pov,
      subjects: [...r.forbidden_subjects],
      message: r.message ?? `${r.pov}POVの地の文に「${r.forbidden_subjects.join('/')}」`
    };
  });
}
