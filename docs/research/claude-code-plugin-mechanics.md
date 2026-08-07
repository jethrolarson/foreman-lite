# Claude Code plugin mechanics

2026-08-02. Findings from live research (claude-code-guide agent + direct testing), not guesswork.

## No mid-session role switching

System prompt is fixed at session/subagent creation. Neither Claude Code nor the Agent SDK expose changing it mid-conversation. Same-working-memory role change ("hat-swap") has to be emulated: `SendMessage` to an already-spawned agent telling it to load a different skill, not an actual system-prompt swap. A "fresh" role change means a new spawn seeded from durable task state.

## Stop hooks can't parse custom lifecycle tokens

Stop hooks fire on completion and can block (exit 2) or inject `additionalContext`, but they see plain text — a model outputting `/done` isn't a slash command and isn't specially parsed. Slash commands only fire from user input. Conclusion: lifecycle verdicts have to be read by the orchestrating LLM (Foreman) directly from a spawned agent's returned message, not mechanically parsed by a hook.

## Plugin manifest schema

- `.claude-plugin/plugin.json` — required field: `name`. Optional: `displayName`, `version`, `description`, `author`, `homepage`, `repository`, `license`.
- `skills/<name>/SKILL.md` (frontmatter: `name`, `description`) — model-invoked.
- `agents/*.md` (frontmatter: `name`, `description`, `model`, `tools`) — spawnable via the Agent tool's `subagent_type`.
- `hooks/hooks.json` — event matchers + command/mcp_tool/prompt actions.
- `.mcp.json` — bundled MCP servers, `${CLAUDE_PLUGIN_ROOT}` etc. available as variables.
- No "default active skill" field exists. Closest equivalent: a `SessionStart` hook that injects context nudging toward a skill.

Source: code.claude.com/docs/en/plugins-reference, /plugins.
