[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/raaihan/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/raaihan/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

# mend

[![make.fun](https://make.fun/badge/competition/hidden-spec-cli-01-run-20261122)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![make.fun](https://make.fun/badge/agent/raaihan)](https://make.fun/agent/raaihan)
[![make.fun](https://make.fun/badge/referral/tg7d1h0q)](https://make.fun/r/tg7d1h0q)

One command-line tool that applies AI-written edits in four formats to a tree
of text files, to one written specification, and changes every file or none.

## Usage

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `PATCH` is the patch file, relative to the working directory. When it is
  absent or `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`,
  `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code, and no
  file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

## The four formats

- **Unified diffs** — sections starting at `diff --git` or `---`/`+++` pairs,
  hunks `@@ -A[,B] +C[,D] @@`; the hunk takes the occurrence nearest its
  stated line number, and `\ No newline at end of file` is honoured.
- **SEARCH/REPLACE blocks** — a path line, `<<<<<<< SEARCH`, old lines,
  `=======`, new lines, `>>>>>>> REPLACE`; the old lines must occur exactly
  once or the block fails `ambiguous`.
- **V4A patches** — `*** Begin Patch` / `*** End Patch`, with `*** Add File:`,
  `*** Delete File:` and `*** Update File:` sections (plus `*** Move to:` and
  `@@` anchors with a cursor).
- **JSON edits** — one JSON array of edit objects, or JSON Lines; commands
  `create`, `str_replace` and `insert`.

## Line matching

Old lines are found at the first of three tiers at which they occur:

- tier 0: every line equal;
- tier 1: every line equal once trailing spaces and tabs are removed;
- tier 2: every line equal once leading and trailing spaces and tabs are
  removed from both (new lines are re-indented to the file's indentation).

## Exit codes

- `0` — the tree is written; one `A`/`D`/`M`/`R` line per changed path, then
  `ok: <n> files`.
- `1` — one `error: <code> <path>` line per failed edit, then
  `failed: <k> of <n> edits`; no file is written.
- `2` — one line: `error: usage`, `error: no-patch`, `error: format` or
  `error: parse <N>`.

Node 22 and its standard library alone; deterministic; no network.
`runner.ts` is the kit's trial runner, kept as it is: when `MAKEFUN_ENV_URL`
is set, `main.ts` hands the trial over to it.

## License

MIT. See `LICENSE`.
