# Contributing

Thank you for your interest in this project. This document tells you how to set up the project, make a change, and send a pull request.

## Set up the project

1. Install Node.js 22 or later.
2. Install pnpm 11 or later.
3. Fork and clone the repository.
4. Install the dependencies: `pnpm install`
5. Create a configuration file: `cp config.example.yaml config.yaml`
6. Run the tests: `pnpm test`

All 44 tests must pass before you start.

## Make a change

1. Create a branch from `main`.
2. Write a failing test for your change.
3. Write the code that makes the test pass.
4. Run the checks: `pnpm lint && pnpm format:check && pnpm test`
5. Commit with a clear message.

### Code style

- ESLint and Prettier enforce the style. Run `pnpm format` to format all files.
- Do not add dependencies without a clear need. The latency chart is plain SVG for this reason.
- Keep each file focused on one responsibility. See the files in `src/lib/` as examples.

### Commit messages

Use a short prefix that names the type of change:

- `feat:` for a new feature
- `fix:` for a bug fix
- `docs:` for documentation
- `chore:` for maintenance

Example: `fix: cancel response body in runCheck to release sockets`

### Tests

- Put tests next to the code: `src/lib/foo.ts` has its tests in `src/lib/foo.test.ts`.
- Test real behavior. The checker tests use a real local HTTP server. The database tests use a real in-memory SQLite database.
- Do not weaken or delete a test to make it pass.

## Send a pull request

1. Push your branch to your fork.
2. Open a pull request against `main`.
3. Describe the problem and your solution in the description.
4. Make sure all checks pass.

The `main` branch is protected. All changes arrive through pull requests.

## Report a bug

Open an issue. Include:

- What you did
- What you expected
- What happened, with the exact error message or log line

## Security

Do not open a public issue for a security problem. Report it privately to the maintainer through GitHub's private vulnerability reporting.
