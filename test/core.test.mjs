// Synthetic-fixture tests for novel-ci-core. All manuscript text here is invented
// for tests; no real work's text may be copied into this directory.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { run } from '../src/cli.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, 'fixtures');
const BIN = join(HERE, '..', 'bin', 'novel-ci.mjs');
const read = (name) => readFileSync(join(FIX, name), 'utf8');

function sandbox(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'novel-ci-core-'));
  cpSync(FIX, join(dir, 'fx'), { recursive: true });
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

function gate(dir, body, extra = []) {
  return run(['gate', '--root', dir, '--body', body, '--card', 'fx/card.md', '--rules', 'fx/rules.md', ...extra]);
}

const rules = (out) => [...out.errors, ...out.warnings].map((e) => e.rule_id);
const PASS_BODY = read('body-pass.md');

test('1. gate PASS on a well-formed synthetic body', () => {
  const dir = sandbox();
  const { exitCode, output } = gate(dir, 'fx/body-pass.md', ['--pov-rules', 'fx/pov-rules.yml']);
  assert.equal(output.status, 'PASS', JSON.stringify(output));
  assert.equal(output.files.pov_rules, 'fx/pov-rules.yml');
  assert.equal(exitCode, 0);
  assert.deepEqual(output.errors, []);
  assert.equal(output.scene_count, 2);
  assert.ok(output.metrics.sentences_per_line >= 1.5);
});

test('2. frontmatter FAIL (missing block -> FM-01)', () => {
  const dir = sandbox({ 'b.md': PASS_BODY.replace(/^---\ntitle: .*\nstatus: Phase1\n---\n/, '') });
  const { exitCode, output } = gate(dir, 'b.md');
  assert.equal(output.status, 'FAIL');
  assert.equal(exitCode, 1);
  assert.ok(output.errors.some((e) => e.rule_id === 'FM-01' && e.message_code === 'frontmatter_invalid'));
});

test('3. required line missing -> RQ-01 with ref_id only', () => {
  const dir = sandbox({ 'b.md': PASS_BODY.replace('「明日も晴れるって、ラジオで言ってた」', '「ラジオはずっと雑音だった」') });
  const { output } = gate(dir, 'b.md');
  const e = output.errors.find((x) => x.rule_id === 'RQ-01');
  assert.ok(e);
  assert.equal(e.ref_id, 'RL-02');
  assert.equal(e.message_code, 'required_line_missing');
});

test('4. required line order FAIL -> RQ-02', () => {
  const swapped = PASS_BODY.replace('「灯台の鍵を持ってきたよ」', '「明日も晴れるって、ラジオで言ってた」X').replace(
    '「明日も晴れるって、ラジオで言ってた」\n',
    '「灯台の鍵を持ってきたよ」\n'
  ).replace('」X', '」');
  const dir = sandbox({ 'b.md': swapped });
  const { output } = gate(dir, 'b.md');
  assert.ok(output.errors.some((e) => e.rule_id === 'RQ-02' && e.ref_id === 'RL-02'), JSON.stringify(output.errors));
});

test('5. forbidden word FAIL -> RQ-03 (card) and NG-01 (rules table)', () => {
  const body = PASS_BODY.replace('昨日の雨の気配はもうどこにもない。', '昨日の雨の気配はもうどこにもない。宝くじの話は然れども出なかった。');
  const dir = sandbox({ 'b.md': body });
  const { output } = gate(dir, 'b.md');
  const ids = rules(output);
  assert.ok(ids.includes('RQ-03'));
  assert.ok(ids.includes('NG-01'));
  assert.equal(output.status, 'FAIL');
});

test('6. short-line rhythm FAIL -> RY-01/RY-02', () => {
  const choppy = ['風。', '波。', '鳥。', '雲。', '砂。', '光。'].join('\n\n');
  const dir = sandbox({ 'b.md': PASS_BODY.replace('レンズ室の床には', `${choppy}\n\nレンズ室の床には`) });
  const { output } = gate(dir, 'b.md');
  const ids = rules(output);
  assert.ok(ids.includes('RY-02'), JSON.stringify(output));
  assert.equal(output.status, 'FAIL');
});

test('7. a required phrase in the frontmatter title does not pollute order checks', () => {
  // title already contains RL-02's phrase ("明日も晴れる") before RL-01 appears in the body
  assert.match(PASS_BODY, /^---\ntitle: 灯台と明日も晴れる空/);
  const dir = sandbox();
  const { output } = gate(dir, 'fx/body-pass.md');
  assert.ok(!rules(output).includes('RQ-02'));
  assert.equal(output.status, 'PASS');
});

test('8. P15 scan: clean body -> 0 candidates', () => {
  const dir = sandbox();
  const { exitCode, output } = run(['p15', 'scan', '--root', dir, '--body', 'fx/p15-clean.md']);
  assert.equal(exitCode, 0);
  assert.equal(output.candidate_count, 0);
});

test('9. P15 scan: short-sentence run -> P15-05 candidate with deterministic id', () => {
  const dir = sandbox();
  const a = run(['p15', 'scan', '--root', dir, '--body', 'fx/p15-short-run.md']).output;
  const b = run(['p15', 'scan', '--root', dir, '--body', 'fx/p15-short-run.md']).output;
  const c = a.candidates.find((x) => x.rule_id === 'P15-05');
  assert.ok(c);
  assert.match(c.candidate_id, /^P15-05-[0-9a-f]{6}$/);
  assert.equal(c.category, 'rhythm');
  assert.deepEqual(a, b);
});

test('10. P15 scan: repetition -> P15-04 (head) / P15-07 (token) candidates', () => {
  const dir = sandbox();
  const { output } = run(['p15', 'scan', '--root', dir, '--body', 'fx/p15-repetition.md']);
  const ids = output.candidates.map((c) => c.rule_id);
  assert.ok(ids.includes('P15-04'), JSON.stringify(ids));
  assert.ok(ids.includes('P15-07'), JSON.stringify(ids));
});

function shortRunId(dir) {
  return run(['p15', 'scan', '--root', dir, '--body', 'fx/p15-short-run.md']).output.candidates.find((c) => c.rule_id === 'P15-05')
    .candidate_id;
}

test('11. verify: judgment missing -> FAIL with unjudged id', () => {
  const dir = sandbox({ 'j.yml': 'episode: x\nfindings: []\n' });
  const id = shortRunId(dir);
  const { exitCode, output } = run(['p15', 'verify', '--root', dir, '--body', 'fx/p15-short-run.md', '--judgments', 'j.yml']);
  assert.equal(exitCode, 1);
  assert.equal(output.status, 'FAIL');
  assert.deepEqual(output.unjudged_ids, [id]);
});

test('12. verify: candidate id mismatch -> unjudged + orphan', () => {
  const rec = 'findings:\n  - id: P15-05-000000\n    status: accepted_as_intentional\n    reason: 合成理由\n';
  const dir = sandbox({ 'j.yml': rec });
  const id = shortRunId(dir);
  const { output } = run(['p15', 'verify', '--root', dir, '--body', 'fx/p15-short-run.md', '--judgments', 'j.yml']);
  assert.equal(output.status, 'FAIL');
  assert.deepEqual(output.unjudged_ids, [id]);
  assert.deepEqual(output.orphan_ids, ['P15-05-000000']);
});

test('13. verify PASS when every candidate is judged', () => {
  const probe = sandbox();
  const id = shortRunId(probe);
  const rec = `findings:\n  - id: ${id}\n    category: rhythm\n    status: accepted_as_intentional\n    reason: 合成理由\n`;
  const dir = sandbox({ 'j.yml': rec });
  const { exitCode, output } = run(['p15', 'verify', '--root', dir, '--body', 'fx/p15-short-run.md', '--judgments', 'j.yml']);
  assert.equal(output.status, 'PASS', JSON.stringify(output));
  assert.equal(exitCode, 0);
  assert.equal(output.unresolved_count, 0);
});

test('13b. verify: unresolved and invalid judgments FAIL; malformed YAML errors without echo', () => {
  const probe = sandbox();
  const id = shortRunId(probe);
  const dir = sandbox({
    'u.yml': `findings:\n  - id: ${id}\n    status: unresolved\n`,
    'bad.yml': 'findings: [ {id: 合成の秘密文字列, status: \n'
  });
  const u = run(['p15', 'verify', '--root', dir, '--body', 'fx/p15-short-run.md', '--judgments', 'u.yml']).output;
  assert.deepEqual(u.unresolved_ids, [id]);
  const bad = run(['p15', 'verify', '--root', dir, '--body', 'fx/p15-short-run.md', '--judgments', 'bad.yml']).output;
  assert.equal(bad.status, 'ERROR');
  assert.ok(!JSON.stringify(bad).includes('秘密'));
});

test('14. scene delimiter handling: only "---" splits scenes; other rules are flagged', () => {
  const body = '---\ntitle: 合成\nstatus: Phase1\n---\n\n一つ目の場面で、港の坂を上りきったところで振り返ると朝の光が届いていた。\n\n---\n\n二つ目の場面で、灯台の階段を上ると窓の外に水平線が見えた。\n\n***\n\n三つ目のつもりの場面で、レンズ室の床に埃が積もっていた。\n\n＊＊＊\n\n最後の行で、二人は階段を下りた。\n';
  const dir = sandbox({ 'b.md': body });
  const { output } = gate(dir, 'b.md');
  assert.equal(output.scene_count, 2);
  assert.equal(output.errors.filter((e) => e.rule_id === 'ST-03').length, 2);
});

test('14b. pov_by_scene applies POV rules per scene (mixed POV)', () => {
  const card = '## 9. ゲート定義\n\n```yaml\npov: 青木\npov_by_scene:\n  - scene: 2\n    pov: 凪\n```\n';
  const body = '---\ntitle: 合成\nstatus: Phase1\n---\n\n俺は坂を上った。凪は後ろから来ていた。\n\n---\n\n私は階段を上った。青木は先に着いていた。\n';
  const dir = sandbox({ 'b.md': body, 'c.md': card });
  const out = run(['gate', '--root', dir, '--body', 'b.md', '--card', 'c.md', '--rules', 'fx/rules.md', '--pov-rules', 'fx/pov-rules.yml'])
    .output;
  const pov = out.errors.filter((e) => e.rule_id.startsWith('POV'));
  assert.deepEqual(pov, [], JSON.stringify(pov));
  const single = '## 9. ゲート定義\n\n```yaml\npov: 青木\n```\n';
  writeFileSync(join(dir, 'c1.md'), single);
  const out1 = run(['gate', '--root', dir, '--body', 'b.md', '--card', 'c1.md', '--rules', 'fx/rules.md', '--pov-rules', 'fx/pov-rules.yml'])
    .output;
  assert.ok(out1.errors.some((e) => e.rule_id === 'POV-02' && e.line === 10), JSON.stringify(out1.errors));
  const bad = '## 9. ゲート定義\n\n```yaml\npov: 青木\npov_by_scene:\n  - scene: 9\n    pov: 凪\n```\n';
  writeFileSync(join(dir, 'c2.md'), bad);
  const out2 = run(['gate', '--root', dir, '--body', 'b.md', '--card', 'c2.md', '--rules', 'fx/rules.md', '--pov-rules', 'fx/pov-rules.yml'])
    .output;
  assert.ok(out2.errors.some((e) => e.rule_id === 'POV-00'));
});

test('15. path traversal / outside-root / glob inputs are rejected', () => {
  const dir = sandbox();
  const outside = mkdtempSync(join(tmpdir(), 'novel-ci-outside-'));
  writeFileSync(join(outside, 'x.md'), PASS_BODY);
  const cases = [
    ['../x.md', 'path_traversal_rejected'],
    ['fx/../../x.md', 'path_traversal_rejected'],
    [join(outside, 'x.md'), 'path_outside_root'],
    ['fx/*.md', 'path_glob_rejected'],
    ['fx', 'not_a_regular_file']
  ];
  for (const [p, code] of cases) {
    const { exitCode, output } = run(['p15', 'scan', '--root', dir, '--body', p]);
    assert.equal(exitCode, 2, p);
    assert.equal(output.error.code, code, p);
  }
  rmSync(outside, { recursive: true, force: true });
});

test('16. symlinks are rejected (file symlink and directory symlink escape)', () => {
  const dir = sandbox();
  const outside = mkdtempSync(join(tmpdir(), 'novel-ci-outside-'));
  writeFileSync(join(outside, 'secret.md'), PASS_BODY);
  symlinkSync(join(outside, 'secret.md'), join(dir, 'link.md'));
  symlinkSync(join(FIX, 'body-pass.md'), join(dir, 'inside-link.md'));
  symlinkSync(outside, join(dir, 'linkdir'));
  assert.equal(run(['p15', 'scan', '--root', dir, '--body', 'link.md']).output.error.code, 'symlink_rejected');
  assert.equal(run(['p15', 'scan', '--root', dir, '--body', 'inside-link.md']).output.error.code, 'symlink_rejected');
  assert.equal(run(['p15', 'scan', '--root', dir, '--body', 'linkdir/secret.md']).output.error.code, 'symlink_escape_rejected');
  rmSync(outside, { recursive: true, force: true });
});

test('17. stdout/stderr never contain manuscript text (bin, all commands, error paths)', () => {
  const canary = '合成カナリア文字列が漏れてはいけない';
  const body = PASS_BODY.replace('港の坂を', `# ${canary}\n\n**POV: ${canary}\n\n＜${canary}＞港の坂を`).replace(
    '昨日の雨の気配はもうどこにもない。',
    `昨日の雨の気配はもうどこにもない。宝くじと${canary}。`
  );
  const card = read('card.md').replace('text: 明日も晴れる', `text: ${canary}`);
  const dir = sandbox({
    'b.md': body,
    'c.md': card,
    'j.yml': `findings:\n  - id: ${canary}\n    status: 何か\n`,
    'bad.yml': `findings: [ ${canary}: {\n`
  });
  const invocations = [
    ['gate', '--root', dir, '--body', 'b.md', '--card', 'c.md', '--rules', 'fx/rules.md'],
    ['p15', 'scan', '--root', dir, '--body', 'b.md'],
    ['p15', 'verify', '--root', dir, '--body', 'b.md', '--judgments', 'j.yml'],
    ['p15', 'verify', '--root', dir, '--body', 'b.md', '--judgments', 'bad.yml'],
    ['p15', 'scan', '--root', dir, '--body', `${canary}.md`]
  ];
  const bodyLines = body.split('\n').map((l) => l.trim()).filter((l) => [...l].length >= 6 && l !== '---');
  for (const args of invocations) {
    const r = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });
    const all = `${r.stdout}${r.stderr}`;
    assert.equal(r.stderr, '', args.join(' '));
    assert.ok(!all.includes(canary), `canary leaked: ${args.join(' ')}`);
    for (const l of bodyLines) {
      assert.ok(!all.includes(l), `body line leaked: ${args.join(' ')}`);
    }
    JSON.parse(r.stdout);
  }
});

test('CLI: unknown options, duplicates and non-json formats are refused', () => {
  const dir = sandbox();
  assert.equal(run(['p15', 'scan', '--root', dir, '--body', 'fx/p15-clean.md', '--glob', 'x']).output.error.code, 'unknown_option');
  assert.equal(run(['p15', 'scan', '--body', 'a', '--body', 'b']).output.error.code, 'duplicate_option');
  assert.equal(run(['p15', 'scan', '--root', dir, '--body', 'fx/p15-clean.md', '--format', 'text']).output.error.code, 'unsupported_format');
  assert.equal(run(['exec', 'ls']).output.error.code, 'unknown_command');
});
