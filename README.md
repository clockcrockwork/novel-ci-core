# novel-ci-core

Work-agnostic, deterministic validators for Japanese novel manuscripts:

- `gate` — structure / rhythm / vocabulary / required-line gate for a Phase 1 draft
- `p15 scan` — prose-quality *candidates* (not violations) with deterministic content-based IDs
- `p15 verify` — checks a judgment record covers every current candidate

This repository contains only the work-agnostic validator core. Consumer projects keep
their manuscripts, design data, corpora, reader packets, and project-specific POV rules
outside this repository and pass only exact local file paths at runtime.

## Boundary

The core is a pure validator:

- takes **exact file paths only** (no globs, no directory arguments, no discovery,
  no CT-ID → path inference, no repository scanning)
- resolves every path under `--root` and rejects `..`, absolute paths outside the root,
  symlinks, symlink escapes, non-regular files and oversized files
- no network, no GitHub API, no tokens
- **never prints manuscript text**: stdout is one sanitized JSON object whose strings are
  identifiers / enums / the caller-supplied paths; stderr is unused; exception messages
  (which may quote input) are never surfaced

Project data never lives here: no manuscripts, design cards, story bibles, corpora,
prompts, reader packets or character names. POV subject rules are passed in by the
caller (`--pov-rules`), fixtures are invented text.

## CLI

```text
novel-ci gate       --body <path> --card <path> --rules <path> [--pov-rules <path>] [--phase PhaseN] [--root <dir>] --format json
novel-ci p15 scan   --body <path> [--root <dir>] --format json
novel-ci p15 verify --body <path> --judgments <path> [--root <dir>] --format json
```

Exit codes: `0` PASS (scan always 0), `1` FAIL, `2` usage / input error (`status: ERROR`).

### gate output

```json
{"command":"gate","status":"FAIL","phase":"Phase1","scene_count":5,
 "errors":[{"rule_id":"RQ-01","severity":"error","line":0,"message_code":"required_line_missing","ref_id":"P1-09"}],
 "warnings":[],"info_count":0,
 "metrics":{"sentences_per_line":2.11,"short_line_rate":0,"avg_line_length":47.2,"prose_line_count":36,"short_line_count":0}}
```

### p15 scan / verify output

```json
{"command":"p15_scan","status":"PASS","candidate_count":1,
 "candidates":[{"candidate_id":"P15-05-786f4f","rule_id":"P15-05","category":"rhythm","start_line":110,"end_line":124,"scene":3}]}
```

`verify` adds `judged_count / unjudged_ids / unresolved_ids / contradiction_ids / orphan_ids / invalid`.

## Card gate definition (§9)

A fenced `yaml` block under a `## 9. …ゲート定義` heading:

```yaml
version: 1
pov: A            # default POV
pov_by_scene:     # optional, for mixed-POV contents (scenes split by '---')
  - scene: 4
    pov: B
required_lines:
  - id: RL-01
    text: ...
    match: fuzzy  # or exact
forbidden:
  - text: ...
```

`pov_by_scene` is backward compatible: cards without it behave exactly as before.

## POV rules file (`--pov-rules`)

```yaml
version: 1
pov_rules:
  - rule_id: POV-01
    pov: A
    forbidden_subjects: [literal substring, ...]   # literal match, no regex
```

## Versioning / pinning

Consumers pin an immutable version (`version` + release `commit` + `integrity`); `latest`
or floating branches are not allowed. Integrity = sha256 over
`<relpath>\0<sha256(file)>\n` for `package.json`, `bin/**`, `src/**` (sorted).

Release procedure: synthetic CI PASS → consumer-side private fixture replay → tag →
consumer pin update → dogfood.

## Repository layout (as a standalone repo)

```text
novel-ci-core/
  package.json            # bin: novel-ci
  bin/novel-ci.mjs
  src/                    # cli, safe-io, output, gate, card, rules, pov-rules, episode, p15-scan, p15-verify
  test/core.test.mjs      # 17+ synthetic cases (gate / p15 / verify / path & symlink rejection / no-leak)
  test/fixtures/          # invented text only
  .github/workflows/ci.yml  # GitHub-hosted, lint/test/pack only; no self-hosted runner, no secrets
```

## Tests

```bash
npm test
```
