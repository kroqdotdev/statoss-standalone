# Contributing

Thank you for helping with statoss-standalone. This page tells you how to set up the project, how to make a change, and how to send it in.

## Set up the project

1. Install Node.js 22 or later and pnpm 11 or later.
2. Fork the repository and clone your fork.
3. Install the dependencies: `pnpm install`
4. Create a configuration file: `cp config.example.yaml config.yaml`
5. Run the tests: `pnpm test`

All tests pass on `main`. If they do not pass for you, open an issue before you start.

## Make a change

1. Create a branch from `main`.
2. Write a failing test for the behaviour you want, when the change is testable.
3. Write the code that makes the test pass.
4. Run all checks: `pnpm lint && pnpm format:check && pnpm test && pnpm build`
5. Commit with a clear message.

### Code style

- ESLint and Prettier enforce the style. Run `pnpm format` before you commit.
- Keep the dependency list short. Add a dependency only when writing the code yourself would be clearly worse. The chart is plain SVG for this reason.
- Keep each file to one job. The files in `src/lib/` are the pattern to follow: pure functions with the database or configuration passed in.
- Write user-facing text as short, plain sentences. Do not use em dashes.

### Commit messages

Start the subject with a prefix that names the kind of change:

| Prefix   | Use it for                         |
| -------- | ---------------------------------- |
| `feat:`  | a new feature                      |
| `fix:`   | a bug fix                          |
| `docs:`  | documentation only                 |
| `chore:` | maintenance, tooling, dependencies |

Example: `fix: cancel the response body in runCheck to release the socket`

### Tests

- Put tests next to the code. `src/lib/foo.ts` has its tests in `src/lib/foo.test.ts`.
- Test real behaviour. The checker tests use a local HTTP server. The database tests use an in-memory SQLite database.
- Do not weaken or delete a test to make it pass. If a test is wrong, say why in the pull request.

## Send a pull request

1. Push your branch to your fork.
2. Open a pull request against `main`.
3. Describe the problem, your solution, and how you tested it. The pull request template asks for these.
4. Make sure the CI checks pass.

`main` is protected. Every change arrives through a pull request.

## Report a bug

Open an issue with the bug report template. Include what you did, what you expected, and what happened, with the exact error message or log line. If you can, include the relevant part of your `config.yaml` with any secrets removed.

## Ask a question

Open an issue. There are no wrong questions, and answers often turn into documentation.

## Security

Do not open a public issue for a security problem. [SECURITY.md](SECURITY.md) explains how to report it privately.
