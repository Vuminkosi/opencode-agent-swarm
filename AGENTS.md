<!-- pane-agent-context:start -->
## Pane

This repository is used with [Pane](https://runpane.com). Drive it with the CLI or the `pane` MCP server.

1 feature = 1 worktree = 1 branch = 1 Pane; reviews, audits, fixes and QA for it are tabs in that Pane. Open later agents with `runpane panels create --pane <id>` (MCP: `panels_create` or `agents_start` with `pane`), not a new Pane.

When you need the person (a choice, an approval, a short answer), call the `notify` MCP tool (or `runpane notify`) instead of asking in the terminal. If it returns `waiting`, call it again with `resume`; if it returns `unavailable`, ask in the terminal. A worker in a Pane Session (`PANE_SESSION_DIR` set, `PANE_ORCHESTRATION_SESSION_ID` unset) doesn't call `notify`: it reports blocked to its orchestrator with `runpane report --state blocked --question "<question>"`. Its orchestrator relays that card with `runpane notify --relays <item> ...`, the answer goes straight to the worker's tab, and the orchestrator records it with `runpane inbox ack <item> --decision <D-n>`. For an API key, token or password, call `secrets_request` (or `runpane secrets request`), never `ask`; if that returns `unavailable`, ask the person to save it in Pane under Settings > Secrets.

CLI: `npm i -g runpane` (or `npx --yes runpane@latest`), then `runpane doctor --json`. Full command reference: `runpane agent-context --json`.

MCP: packaged Pane registers a stdio server named `pane` with Claude Code, Codex, and Cursor. Check the connection with `claude mcp list`, `codex mcp list`, or `agent mcp list`. Cursor may ask you to enable `pane` with `agent mcp enable pane`. If tools are missing, add it in the agent's MCP settings: Claude Code `claude mcp add --scope user pane -- npx --yes runpane@latest mcp`; Codex (`~/.codex/config.toml`) table `[mcp_servers.pane]` with `command = "npx"` and `args = ["--yes", "runpane@latest", "mcp"]`; Cursor (`~/.cursor/mcp.json`) uses `mcpServers.pane` with the same `npx` command and args; any other stdio client uses them too.
<!-- pane-agent-context:end -->
