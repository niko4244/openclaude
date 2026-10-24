# Investigation: Scheduled tasks in Cowork

Feature: `feat_scheduled-tasks-in-cowork`
Product: cowork
Status: announced
Generated: 2026-10-24T14:25:33.706Z
REA: not available (ENOENT)

## 1. Question

What observable behaviour does "Scheduled tasks in Cowork" provide, and what is the smallest
architecture in OpenClaude that reproduces that behaviour without Anthropic's
services?

## 2. Official evidence first

- https://docs.anthropic.com/en/release-notes/claude-apps

Check the official documentation and changelog for this feature. Record the
release date, the platforms, and whether it is generally available, staged, or
announced only. A community post is a discovery signal, never proof of release.

## 3. Availability check

- [ ] Confirm the feature is actually present in an authorized copy (installed build, official docs, or a recording).
- [ ] Record the exact version and platform examined.
- [ ] If it is not available, stop: status becomes `blocked` with the reason, not `done`.

## 4. Controlled investigation

REA is not installed. This investigation is **blocked** until the operator either installs it (`npx rea-agents@latest setup`, run manually) or authorizes a documentation-only analysis.

A documentation-only pass may still proceed with public specifications and official documentation.

Boundaries (non-negotiable):

- No copying proprietary source, assets, or text.
- No bypassing access controls, licence checks, encryption, or credentials.
- No undocumented private APIs where the applicable terms forbid it.
- No captures, binaries, tokens, or user data leave the machine or enter the repository.

## 5. Evidence labels

- **Observation** — seen directly in a capture, screen recording, official doc, or the app's own files.
- **Inference** — a conclusion drawn from observations; label it as such and say what would falsify it.
- **Open question** — not established. Never present it as fact.

## 6. Functional specification

Write the behaviour contract from the evidence:

- Inputs and states.
- What the user sees at each step.
- Persistence and recovery expectations.
- Failure modes and what the app must not do.
- Which parts need Anthropic infrastructure, and therefore cannot be replicated.

## 7. Acceptance tests

Each test must be runnable without Anthropic services:

1. …
2. …

## 8. Independent implementation

- Where it belongs in OpenClaude (Rust core, React UI, or CLI).
- Which existing services it reuses.
- Which model capabilities it needs (tools, vision, long context) and the
  capability check when they are absent.
- How it behaves with local and OpenAI-compatible models.

## 9. Outcome

- Status: (pending | ready | blocked | not-replicable)
- Blockers:
- Evidence links:
