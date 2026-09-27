import { lstatSync, realpathSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export const MAX_INPUT_BYTES = 4 * 1024 * 1024;

export class InputError extends Error {
  constructor(code, option) {
    super(code);
    this.code = code;
    this.option = option ?? null;
  }
}

function inside(root, target) {
  const rel = relative(root, target);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
}

export function resolveExactInput(rawPath, root, option) {
  if (typeof rawPath !== 'string' || rawPath.length === 0) throw new InputError('path_missing', option);
  if (rawPath.includes(String.fromCharCode(0))) throw new InputError('path_invalid', option);
  if (/[*?\[\]{}]/.test(rawPath)) throw new InputError('path_glob_rejected', option);
  if (rawPath.split(/[\\/]+/).includes('..')) throw new InputError('path_traversal_rejected', option);

  let rootReal;
  try { rootReal = realpathSync(resolve(root)); }
  catch { throw new InputError('root_not_found', '--root'); }

  const abs = resolve(rootReal, rawPath);
  if (!inside(rootReal, abs)) throw new InputError('path_outside_root', option);

  let stat;
  try { stat = lstatSync(abs); }
  catch { throw new InputError('path_not_found', option); }

  if (stat.isSymbolicLink()) throw new InputError('symlink_rejected', option);
  if (!stat.isFile()) throw new InputError('not_a_regular_file', option);

  let real;
  try { real = realpathSync(abs); }
  catch { throw new InputError('path_not_found', option); }

  if (!inside(rootReal, real)) throw new InputError('symlink_escape_rejected', option);
  if (stat.size > MAX_INPUT_BYTES) throw new InputError('file_too_large', option);

  return { abs: real, rel: relative(rootReal, real) };
}

export function readExactText(rawPath, root, option) {
  const { abs, rel } = resolveExactInput(rawPath, root, option);
  try {
    return { text: readFileSync(abs, 'utf8'), rel };
  } catch {
    throw new InputError('read_failed', option);
  }
}
