# mend: one patch tool for every AI edit format

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Aboys25/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Aboys25/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend` applies an edit that an AI model wrote to a tree of text files. Models write edits in
four formats — a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A
patch format, and text-editor tool calls as JSON — and `mend` reads each one as `SPEC.md` says,
finds the lines each edit names at the first of three matching tiers, and writes every change
or none. Practice score 100/100.

## Run it

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- The working directory is the root of the tree. Every path in a patch is relative to it.
- `PATCH` is the patch file, relative to the working directory. When it is absent or `-`, the
  patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`, `v4a` or `json`;
  `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code as without it, and no
  file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).
- Options and `PATCH` may come in any order. `--` ends the options.

Exit 0 prints one line per changed path (`A`, `D`, `M`, or `R <old> -> <new>` for a move) and
`ok: <n> files`. Exit 1 prints one `error: <code> <path>` line per failed edit and
`failed: <k> of <n> edits`; no file is written. Exit 2 prints one line for a usage, no-patch,
format or parse error. `SPEC.md` is the whole contract.

## The files

- `main.ts`: the CLI, Node 22 and its standard library alone, run as `node main.ts [options] [PATCH]`.
- `runner.ts`: keep it as it is. In a trial it reads the checks from the env, runs `node main.ts`
  on each one in a fresh directory, and posts what it did.
- `check.ts`: the practice set on your own machine. The kit carries it at
  `program/generator/practice.json`:

      node check.ts ../program/generator/practice.json
      node check.ts ../program/generator/practice.json u-offset s-basic

  It prints every check `main.ts` gets wrong, with what differed, and the practice score.
- `SPEC.md`: the specification.
- `LICENSE`: MIT.
