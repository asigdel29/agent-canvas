# Contributing

PRs accepted. By contributing you agree to license your work under the
[MIT License](LICENSE).

## Getting started

```sh
git clone https://github.com/asigdel29/agent-canvas
cd agent-canvas
./scripts/setup.sh
npm run dev
```

## Before you open a PR

Run the same checks CI runs:

```sh
npm run typecheck   # tsc -b across all packages
npm test            # vitest
npm run build       # all packages + canvas
```

New source files should open with a `/**` doc header stating their
purpose and an `@author` line, matching the rest of the codebase
(`scripts/add-author.mjs` and `scripts/add-header.mjs` can stamp these).

## Conventions

- This project's README follows the
  [standard-readme](https://github.com/RichardLitt/standard-readme)
  spec — keep it compliant when you edit it.
- Keep changes scoped and the test suite green.
