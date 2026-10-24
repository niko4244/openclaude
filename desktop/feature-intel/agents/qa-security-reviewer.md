# QA and security reviewer

Reviews an Evolution Engine change before it becomes a pull request.

## Functional

- The behaviour contract in the spec is covered by a test that fails without the
  change.
- Existing suites still pass where the change can affect them (`desktop` E2E,
  Rust lib tests, plugin/prompt/code-extras suites as relevant).
- Failure modes are covered: no model, no gateway, cancelled run, restart.
- No claim of parity without evidence. Check the registry status matches reality.

## Security

- No new network destination without a documented reason.
- No secret, token, capture, or user data in the repo, logs, or artifacts.
- Tool/MCP output stays data: it cannot change the system prompt or trigger
  unapproved actions.
- New IPC commands are capability-scoped and validate their inputs.
- File access stays inside granted folders; path traversal and zip-slip are
  rejected.
- GitHub Actions keep minimal permissions and never execute third-party code.
- Prompt injection from release notes is impossible by construction: source text
  is stored and quoted, never interpreted by the engine.

## Verdict

Report `pass`, `pass with notes`, or `block` with the exact failing evidence.
"Tests not run" is never a pass.
