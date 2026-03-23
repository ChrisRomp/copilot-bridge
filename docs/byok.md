# Bring Your Own Key (BYOK)

Connect your own model providers (Ollama, Azure OpenAI, Anthropic, etc.) alongside GitHub Copilot models.

## Quick Start

1. Add a provider to `config.json`:

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "models": [
        { "id": "qwen3:8b", "name": "Qwen 3 8B" }
      ]
    }
  }
}
```

2. Reload config: `/reload config`
3. Switch to the model: `/model ollama:qwen3:8b`

## Provider Configuration

Each provider is a named entry under the `"providers"` key in `config.json`:

```json
{
  "providers": {
    "<name>": {
      "type": "openai",
      "baseUrl": "https://...",
      "apiKeyEnv": "MY_API_KEY",
      "models": [
        { "id": "model-id", "name": "Display Name", "contextWindow": 32768 }
      ]
    }
  }
}
```

### Required Fields

| Field | Description |
|-------|-------------|
| `baseUrl` | Provider's API base URL (e.g., `http://localhost:11434/v1`) |
| `models` | Array of model entries, each with at least an `id` |

### Optional Fields

| Field | Description |
|-------|-------------|
| `type` | Provider type: `openai` (default), `azure`, `anthropic` |
| `apiKey` | Inline API key (discouraged — use `apiKeyEnv` instead) |
| `apiKeyEnv` | Environment variable name containing the API key |
| `bearerToken` | Inline bearer token |
| `bearerTokenEnv` | Environment variable name containing the bearer token |
| `wireApi` | Wire protocol: `completions` or `responses` |
| `azure` | Azure-specific config: `{ "apiVersion": "2024-10-21" }` |

### Model Entry Fields

| Field | Description |
|-------|-------------|
| `id` | Model identifier as the provider expects it (e.g., `qwen3:8b`) |
| `name` | Optional display name |
| `contextWindow` | Context window size in tokens (used for `/context` display) |

### Provider Names

Provider names must be non-empty and cannot contain `:` or whitespace. They're used as prefixes in model IDs (e.g., `ollama:qwen3:8b`), so keep them short and descriptive.

## Provider Examples

### Ollama (Local)

```json
{
  "ollama": {
    "baseUrl": "http://localhost:11434/v1",
    "models": [
      { "id": "qwen3:8b", "name": "Qwen 3 8B", "contextWindow": 32768 },
      { "id": "qwen3:14b", "name": "Qwen 3 14B" }
    ]
  }
}
```

No authentication needed for local Ollama instances.

### Azure OpenAI

```json
{
  "work-azure": {
    "type": "azure",
    "baseUrl": "https://myco.openai.azure.com",
    "apiKeyEnv": "AZURE_OPENAI_KEY",
    "wireApi": "responses",
    "azure": { "apiVersion": "2024-10-21" },
    "models": [
      { "id": "gpt-5.2-codex", "name": "GPT-5.2 Codex" }
    ]
  }
}
```

### Anthropic (Direct)

```json
{
  "anthropic": {
    "type": "anthropic",
    "baseUrl": "https://api.anthropic.com/v1",
    "apiKeyEnv": "ANTHROPIC_API_KEY",
    "models": [
      { "id": "claude-sonnet-4-20250514", "name": "Claude Sonnet 4" }
    ]
  }
}
```

## Chat Commands

| Command | Description |
|---------|-------------|
| `/model` | List all models grouped by provider |
| `/model <provider>` | List models for a specific provider |
| `/model <provider>:<model>` | Switch to a specific provider model |
| `/model <bare-model>` | Switch model (Copilot first, then BYOK) |
| `/provider` | List configured providers with details |
| `/provider test <name>` | Test provider connectivity and model availability |
| `/status` | Shows current model with provider prefix |

## Model Resolution

When you type a bare model name (e.g., `/model qwen3:8b`), the bridge resolves it in order:

1. **Exact match** against all models (Copilot + BYOK)
2. **Copilot models first** — fuzzy match against Copilot models
3. **BYOK providers** — check each provider in config order for a bare ID match
4. **Global fuzzy match** — fuzzy match across all models

When you include a provider prefix (e.g., `/model ollama:qwen3:8b`), the search is scoped to that provider's models only.

## Model Switching

Switching between models on the **same provider** uses an in-place model swap (no session restart).

Switching between **different providers** (e.g., Copilot → Ollama, or Ollama → Azure) creates a fresh session because the underlying endpoint and authentication are different. Conversation history from the previous session is not carried over.

## Model Fallback

BYOK models are excluded from automatic fallback chains. If a Copilot model fails, the bridge will only try other Copilot models as fallbacks — not BYOK models.

To include a BYOK model in the fallback chain, add it explicitly to `fallbackModels` in your channel or default config:

```json
{
  "defaults": {
    "fallbackModels": ["claude-sonnet-4.6", "ollama:qwen3:8b"]
  }
}
```

## Hot Reload

Provider changes are applied immediately via `/reload config`:
- **Added providers** — available for new sessions
- **Removed providers** — existing sessions keep working until recreated
- **Updated providers** — new sessions use the updated config

No bridge restart is needed for provider changes.

## Troubleshooting

### Provider unreachable

```
❌ Provider "ollama" is unreachable at http://localhost:11434/v1
```

Check that the provider service is running and the `baseUrl` is correct. Use `/provider test <name>` to diagnose.

### Authentication failure

```
❌ Provider "azure" rejected authentication
```

Verify your API key environment variable is set and the value is correct. Check with `/provider` to see the configured auth method.

### Model not found

```
❌ Model "nonexistent" not found on provider "ollama"
```

Check the model ID matches what the provider expects. For Ollama, model IDs include the tag (e.g., `qwen3:8b`, not just `qwen3`). Use `/provider test <name>` to see available remote models.

### Context window showing wrong value

The SDK reports its own token limit (typically 90k–200k), not the model's actual context window. Set `contextWindow` on the model entry in config to override:

```json
{ "id": "qwen3:8b", "name": "Qwen 3 8B", "contextWindow": 32768 }
```
