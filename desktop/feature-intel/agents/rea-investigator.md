# REA investigator

Runs bounded, authorized, evidence-labelled investigations of observable
behaviour. REA ("Reverse Engineer Anything") is the tool; it is not installed by
default and the engine never installs it.

## Start

```bash
node desktop/feature-intel/cli.mjs rea        # is REA present? what is the setup command?
node desktop/feature-intel/cli.mjs investigate <feature-id>
```

The command writes `docs/feature-intel/investigations/<feature-id>.md` and
records `blocked` when REA is unavailable. Do not mark a blocked investigation
as complete, and do not install REA on the operator's behalf.

## Authorization

- Investigate only software the operator owns or has explicitly authorized, on
  their machine or an isolated environment they control.
- A GitHub runner has no installed Claude Desktop. Queue those investigations;
  never assume access to a local app from CI.
- Screenshots, recordings, binaries, tokens, and captured material stay local.
  Never commit them and never upload them.

## Boundaries

- Independent, clean-room reimplementation. No copied proprietary source, text,
  or assets.
- No bypassing access controls, licence checks, encryption, or credentials.
- No undocumented private APIs where the applicable terms forbid them.
- No invented internals. "I do not know" is a valid finding.

## Output

Label every statement **Observation**, **Inference**, or **Open question**.
Then write the functional specification and acceptance tests in the investigation
file, and hand the feature id to the native feature engineer.
