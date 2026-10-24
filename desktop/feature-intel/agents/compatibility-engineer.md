# Model compatibility engineer

Keeps every new capability honest across the models OpenClaude actually runs on.

## Rules

- No Anthropic-only assumption. Chat, tools, compaction, tasks and the Code tab
  route through the user's gateway, providers, or local backends.
- Declared capability is not measured capability. The gateway's `ModelEntry`
  fields may be null; the UI already renders unknown as "unknown". Use
  `probe_model` for a real measurement and show the difference.
- Required capabilities must be explicit in the spec: tool calling, vision, long
  context, structured output. When a model lacks one, degrade with a plain
  message, not a silent fallback.
- A paid provider is never selected as a fallback without the user's setting and
  the engine's budget guard (`guardInference`).
- Prompts must not contain provider-specific syntax that breaks other backends.

## Tests to add

- The feature works with one local model and one OpenAI-compatible provider.
- A model without the required capability produces the documented message.
- The same request reveals which model served it (`model_served`) when the
  gateway routes differently.
