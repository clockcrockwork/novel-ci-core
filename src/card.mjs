// Design-card gate definition reader: the fenced yaml block under a
// "## 9. ...ゲート定義" heading. Input is card text; the core never discovers cards.

const GATE_HEADING = /^##\s*9\..*ゲート定義/;
const SCENE_NUMBER = /^[1-9][0-9]{0,2}$/;

function extractGateYaml(cardText) {
  const lines = cardText.split(/\r?\n/);
  let inGateSection = false;
  let inFence = false;
  const yamlLines = [];

  for (const line of lines) {
    if (!inGateSection) {
      if (GATE_HEADING.test(line.trim())) {
        inGateSection = true;
      }
      continue;
    }
    if (!inFence) {
      if (/^```ya?ml\s*$/.test(line.trim())) {
        inFence = true;
      } else if (/^##\s/.test(line)) {
        break;
      }
      continue;
    }
    if (line.trim() === '```') {
      return yamlLines;
    }
    yamlLines.push(line);
  }
  return inFence ? yamlLines : null;
}

function parseScalar(value) {
  let v = value.trim();
  const comment = v.indexOf(' #');
  if (comment >= 0) {
    v = v.slice(0, comment).trim();
  }
  if (
    (v.startsWith('"') && v.endsWith('"') && v.length >= 2) ||
    (v.startsWith("'") && v.endsWith("'") && v.length >= 2)
  ) {
    v = v.slice(1, -1);
  }
  return v;
}

// Limited YAML subset: top-level `key: scalar`, and `key:` followed by a list of
// maps (`- key: value` with `  key: value` continuation lines).
function parseLimitedYaml(yamlLines) {
  const root = {};
  let currentList = null;
  let currentItem = null;

  for (const raw of yamlLines) {
    if (raw.trim() === '' || raw.trim().startsWith('#')) {
      continue;
    }
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();

    if (indent === 0) {
      currentItem = null;
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
      if (!m) {
        return { error: `解釈できない行: ${line}` };
      }
      if (m[2] === '') {
        currentList = [];
        root[m[1]] = currentList;
      } else {
        currentList = null;
        root[m[1]] = parseScalar(m[2]);
      }
      continue;
    }

    if (line.startsWith('- ')) {
      if (!currentList) {
        return { error: `リスト外のリスト項目: ${line}` };
      }
      currentItem = {};
      currentList.push(currentItem);
      const m = line.slice(2).match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
      if (!m) {
        return { error: `解釈できないリスト項目: ${line}` };
      }
      currentItem[m[1]] = parseScalar(m[2]);
      continue;
    }

    if (currentItem) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
      if (!m) {
        return { error: `解釈できない継続行: ${line}` };
      }
      currentItem[m[1]] = parseScalar(m[2]);
      continue;
    }

    return { error: `解釈できない行: ${line}` };
  }

  return { data: root };
}

// -> { gate: {pov, povByScene, requiredLines, forbidden} | null, error: string|null, code }
// gate === null && error === null means the card has no §9 gate definition.
export function parseCardGateText(cardText) {
  const yamlLines = extractGateYaml(cardText);
  if (yamlLines === null) {
    return { gate: null, error: null, code: null };
  }

  const parsed = parseLimitedYaml(yamlLines);
  if (parsed.error) {
    return { gate: null, error: `ゲート定義のパース失敗: ${parsed.error}`, code: 'card_gate_parse_error' };
  }

  const data = parsed.data;
  const gate = {
    pov: typeof data.pov === 'string' ? data.pov : null,
    // Optional, backward compatible: per-scene POV overrides for mixed-POV contents.
    // Scenes not listed fall back to `pov`.
    povByScene: new Map(),
    requiredLines: [],
    forbidden: []
  };

  if (Array.isArray(data.required_lines)) {
    for (const item of data.required_lines) {
      if (!item.text) {
        return { gate: null, error: 'required_lines に text のない項目があります', code: 'card_required_line_text_missing' };
      }
      gate.requiredLines.push({
        id: item.id ?? '(id未設定)',
        text: item.text,
        match: item.match === 'fuzzy' ? 'fuzzy' : 'exact'
      });
    }
  }

  if (Array.isArray(data.forbidden)) {
    for (const item of data.forbidden) {
      if (!item.text) {
        return { gate: null, error: 'forbidden に text のない項目があります', code: 'card_forbidden_text_missing' };
      }
      gate.forbidden.push({ text: item.text, note: item.note ?? '' });
    }
  }

  if (data.pov_by_scene !== undefined) {
    if (!Array.isArray(data.pov_by_scene)) {
      return { gate: null, error: 'pov_by_scene はリストで指定してください', code: 'card_pov_by_scene_invalid' };
    }
    for (const item of data.pov_by_scene) {
      if (!SCENE_NUMBER.test(String(item.scene ?? '')) || !item.pov) {
        return {
          gate: null,
          error: 'pov_by_scene の各項目には scene(1始まりの整数) と pov が必要です',
          code: 'card_pov_by_scene_invalid'
        };
      }
      const scene = Number(item.scene);
      if (gate.povByScene.has(scene)) {
        return { gate: null, error: `pov_by_scene の scene ${scene} が重複しています`, code: 'card_pov_by_scene_invalid' };
      }
      gate.povByScene.set(scene, item.pov);
    }
  }

  return { gate, error: null, code: null };
}
