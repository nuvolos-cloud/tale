# Nuvolos Fork of tale

This repository is a fork of [tale-project/tale](https://github.com/tale-project/tale),
pinned to release **v0.2.67** as its upstream base.

This document records every deliberate divergence from upstream so that the
delta can be reconstructed if git history is ever lost.

---

## Upstream base

| Field        | Value |
|--------------|-------|
| Repository   | https://github.com/tale-project/tale |
| Tag          | v0.2.67 |
| Tag commit   | `a46f3de9` |
| Fork date    | 2026-04-16 |
| Last rebased | 2026-05-04 (was previously based on v0.2.45) |

---

## Patches

### 1 — `TALE_DEFAULT_MODEL` environment variable

**Intent:** Allow operators to override the default chat model at deployment
time without editing provider JSON files. The override is applied before any
provider-level default, so it takes precedence globally for the `chat` tag.

**Current default value:** `google/gemma-4-31b-it`

**Files changed:**

#### `.env.example`
Added a documented section near the bottom of the optional block:

```
# ============================================================================
# OPTIONAL: Default Chat Model Override
# ============================================================================
# Override the default chat model used when resolving the 'chat' tag.
# Must match a model ID registered in one of the provider JSON files.
# If not set, the default is taken from the provider's "defaults.chat" field.
# Example:
#   TALE_DEFAULT_MODEL=google/gemma-4-31b-it
TALE_DEFAULT_MODEL=google/gemma-4-31b-it
```

#### `services/platform/convex/providers/file_actions.ts` — `resolveModelByTag`
Added a "zero pass" before the existing first-pass logic. The full insertion
sits between the `if (candidates.length === 0)` guard and the
`// First pass: check for explicit per-tag default` comment:

```typescript
// Zero pass: check TALE_DEFAULT_MODEL env var override (applies to 'chat' tag only)
const envDefaultModel = process.env.TALE_DEFAULT_MODEL;
if (args.tag === 'chat' && envDefaultModel) {
  for (const provider of candidates) {
    const definition = provider.config.models.find(
      (m) => m.id === envDefaultModel,
    );
    if (definition) {
      return {
        providerName: provider.name,
        baseUrl: provider.config.baseUrl,
        apiKey: provider.secrets.apiKey,
        modelId: definition.id,
        dimensions: definition.dimensions,
        supportsStructuredOutputs:
          provider.config.supportsStructuredOutputs ?? false,
      };
    }
  }
}
```

#### `services/platform/convex/agents/test_chat.test.ts`
Updated mock config and assertion to use `google/gemma-4-31b-it` as the first
`supportedModels` entry (was `moonshotai/kimi-k2.5`).

---

### 2 — Default model and model list in provider/agent config files

**Intent:** Register `google/gemma-4-31b-it` as the preferred default chat
model in example configuration files.

**Files changed:**

#### `examples/providers/openrouter.json`
- `defaults.chat` changed from `deepseek/deepseek-v4-flash` → `google/gemma-4-31b-it`
- Added model entry for `google/gemma-4-31b-it` as the first entry in `models[]`:
  ```json
  {
    "id": "google/gemma-4-31b-it",
    "displayName": "Gemma 4 31B",
    "description": "Google's Gemma 4 31B instruction-tuned model",
    "tags": ["chat"]
  }
  ```

#### `examples/agents/chat-agent.json`
- Added `openrouter:google/gemma-4-31b-it` as the first entry in `supportedModels`.
  (Upstream uses provider-qualified model refs as of v0.2.67, so the
  `openrouter:` prefix is required.)

---

### 3 — OCC / `finalizeMessage` crash fix

**Intent:** Eliminate an optimistic-concurrency-control crash triggered when
streaming completes faster than a scheduled delta write fires.

**Root cause (from commit message):** `throttleMs: 100` causes stream delta
writes to be dispatched via `ctx.scheduler.runAfter(200, ...)`. When streaming
finishes quickly, `finalizeMessage` closes the `streamDeltas` record before
the scheduled write fires. The scheduled write retries on every OCC conflict
until all retries are exhausted, then propagates an
`UnhandledPromiseRejection` into `messages.js:finalizeMessage`. Removing
`throttleMs` makes delta writes immediate (no scheduler), eliminating the
race. Real-time streaming display via `syncStreams` is unaffected.

**File changed:**

#### `services/platform/convex/lib/agent_response/generate_response.ts`

Inside `generateAgentResponse`, in the `streamText` / `saveStreamDeltas` call:

```typescript
// Before (upstream v0.2.67)
saveStreamDeltas: { throttleMs: 100, chunking: /[\p{P}\s]/u },

// After
saveStreamDeltas: { chunking: /[\p{P}\s]/u },
```

Note: upstream's punctuation/whitespace chunking regex is preserved; only
`throttleMs` is removed.

---

## Dropped during the v0.2.45 → v0.2.67 rebase

The following patch from the v0.2.45 era was deliberately not reapplied:

### `feat(models): add new models to supportedModels in chat-agent.json` (`8307f437`)

This commit swapped `openai/gpt-5.2`, `openai/gpt-5.2-chat`, `openai/gpt-5.2-pro`
in `supportedModels` for `openai/gpt-5.4`, `openai/gpt-5.4-mini`,
`openai/gpt-5.3-codex`. The `gpt-5.4` / `gpt-5.3-codex` IDs were never added to
`openrouter.json`'s `models[]` array, so they would have been unusable. The
commit also accidentally introduced a duplicate `moonshotai/kimi-k2.5` entry.
We kept upstream's `gpt-5.2` family in `supportedModels` instead. If/when the
GPT-5.4 / 5.3-codex IDs become real OpenRouter models, add them via a fresh
commit that updates *both* `chat-agent.json` and `openrouter.json`.
