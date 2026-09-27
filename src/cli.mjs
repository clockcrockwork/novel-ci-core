import { readFileSync } from 'node:fs';
import { InputError, readExactText } from './safe-io.mjs';
import { evaluateGate } from './gate.mjs';
import { parseEpisode } from './episode.mjs';
import { scanP15 } from './p15-scan.mjs';
import { parseRecordText, verifyRecord, RecordFormatError } from './p15-verify.mjs';
import { parsePovRulesText, PovRulesError } from './pov-rules.mjs';
import { gateJson, scanJson, verifyJson, errorJson, assertSanitized } from './output.mjs';

export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const COMMANDS = {
  gate: { required: ['--body', '--card', '--rules'], optional: ['--pov-rules', '--root', '--format', '--phase'] },
  'p15 scan': { required: ['--body'], optional: ['--root', '--format'] },
  'p15 verify': { required: ['--body', '--judgments'], optional: ['--root', '--format'] }
};

const PHASE_VALUES = ['Phase1', 'Phase2', 'Phase3', 'Phase4', 'public'];

class UsageError extends Error {
  constructor(code, option) {
    super(code);
    this.code = code;
    this.option = option ?? null;
  }
}

function parseArgs(argv) {
  let command = null;
  let rest = argv;
  if (argv[0] === 'gate') {
    command = 'gate';
    rest = argv.slice(1);
  } else if (argv[0] === 'p15' && (argv[1] === 'scan' || argv[1] === 'verify')) {
    command = `p15 ${argv[1]}`;
    rest = argv.slice(2);
  } else if (argv[0] === 'version' || argv[0] === '--version') {
    return { command: 'version', opts: {} };
  } else {
    throw new UsageError('unknown_command');
  }

  const spec = COMMANDS[command];
  const allowed = new Set([...spec.required, ...spec.optional]);
  const opts = {};
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (!allowed.has(flag)) {
      throw new UsageError('unknown_option');
    }
    if (Object.hasOwn(opts, flag)) {
      throw new UsageError('duplicate_option', flag);
    }
    const value = rest[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new UsageError('option_value_missing', flag);
    }
    opts[flag] = value;
    i += 1;
  }
  for (const flag of spec.required) {
    if (!Object.hasOwn(opts, flag)) {
      throw new UsageError('required_option_missing', flag);
    }
  }
  if ((opts['--format'] ?? 'json') !== 'json') {
    throw new UsageError('unsupported_format', '--format');
  }
  if (opts['--phase'] !== undefined && !PHASE_VALUES.includes(opts['--phase'])) {
    throw new UsageError('invalid_phase', '--phase');
  }
  return { command, opts };
}

// Returns { exitCode, output } — never throws, never includes input text.
export function run(argv, { cwd = process.cwd() } = {}) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    return { exitCode: 2, output: errorJson(e.code ?? 'usage_error', e.option, VERSION) };
  }
  if (parsed.command === 'version') {
    return { exitCode: 0, output: { tool: 'novel-ci-core', version: VERSION, status: 'PASS' } };
  }

  const { command, opts } = parsed;
  const root = opts['--root'] ?? cwd;
  try {
    if (command === 'gate') {
      const body = readExactText(opts['--body'], root, '--body');
      const card = readExactText(opts['--card'], root, '--card');
      const rules = readExactText(opts['--rules'], root, '--rules');
      const files = { body: body.rel, card: card.rel, rules: rules.rel };
      let povRules = [];
      if (opts['--pov-rules'] !== undefined) {
        const pov = readExactText(opts['--pov-rules'], root, '--pov-rules');
        try {
          povRules = parsePovRulesText(pov.text);
        } catch (e) {
          if (e instanceof PovRulesError) {
            return { exitCode: 2, output: errorJson(e.code, '--pov-rules', VERSION) };
          }
          throw e;
        }
        files.pov_rules = pov.rel;
      }
      const result = evaluateGate({
        bodyText: body.text,
        cardText: card.text,
        rulesText: rules.text,
        povRules,
        phase: opts['--phase'] ?? null
      });
      const output = assertSanitized(gateJson(result, files, VERSION), new Set(Object.values(files)));
      return { exitCode: result.pass ? 0 : 1, output };
    }

    const body = readExactText(opts['--body'], root, '--body');
    const candidates = scanP15(parseEpisode(body.text));

    if (command === 'p15 scan') {
      const files = { body: body.rel };
      return { exitCode: 0, output: assertSanitized(scanJson(candidates, files, VERSION), new Set(Object.values(files))) };
    }

    const judgments = readExactText(opts['--judgments'], root, '--judgments');
    let record;
    try {
      record = parseRecordText(judgments.text);
    } catch (e) {
      if (e instanceof RecordFormatError) {
        return { exitCode: 1, output: errorJson(e.code, '--judgments', VERSION) };
      }
      throw e;
    }
    const verify = verifyRecord(record, candidates);
    const files = { body: body.rel, judgments: judgments.rel };
    const output = assertSanitized(verifyJson(verify, candidates, true, files, VERSION), new Set(Object.values(files)));
    return { exitCode: verify.pass ? 0 : 1, output };
  } catch (e) {
    if (e instanceof InputError) {
      return { exitCode: 2, output: errorJson(e.code, e.option, VERSION) };
    }
    // Never surface exception messages: parsers may quote input text.
    return { exitCode: 2, output: errorJson('internal_error', null, VERSION) };
  }
}

export function main(argv = process.argv.slice(2)) {
  const { exitCode, output } = run(argv);
  process.stdout.write(`${JSON.stringify(output)}\n`);
  process.exitCode = exitCode;
}
