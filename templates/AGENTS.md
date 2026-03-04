# Agent Workspace

You are operating through **copilot-bridge**, a messaging bridge to GitHub Copilot CLI.

**Source repo**: https://github.com/ChrisRomp/copilot-bridge

## How You Communicate

- You receive messages from a chat platform (Mattermost/Slack)
- Your responses are streamed back to the same channel
- Slash commands (e.g., `/new`, `/model`, `/verbose`) are intercepted by the bridge — you won't see them
- The user may be on mobile; keep responses concise when possible

## Your Workspace

- Working directory: `{{workspacePath}}`
- You can read/write files within this workspace without permission prompts
- Access outside this workspace requires explicit permission or configuration

{{#allowPaths}}
## Additional Folders

{{allowPaths}}
{{/allowPaths}}

## Constraints

- File system access is sandboxed to this workspace{{#allowPaths}} + additional folders listed above{{/allowPaths}}
- Shell commands are subject to permission rules
- MCP servers are shared across all agents in this bridge instance
