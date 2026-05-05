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

### 4 — Plain-text provider secrets (no SOPS)

**Intent:** Nuvolos manages secrets externally. The deployment seeds
`*.secrets.json` as plain JSON from `OPENROUTER_API_KEY` via `tale-init.sh`
on every container boot, and SOPS is not available at runtime. Upstream's
provider-secret read and write paths assume SOPS encryption; this patch
replaces them with a plain-JSON read/merge/write that also falls back to
the `OPENROUTER_API_KEY` / `OPENAI_API_KEY` env vars.

This patch supersedes the `patch_sops.py` runtime monkey-patch previously
maintained in `nv-apps/tale_s6/<tag>/`.

**Files changed:**

#### `services/platform/convex/providers/file_actions.ts`

1. Removed import of `deriveAgePublicKey` (no longer used after the
   `saveProviderSecret` rewrite). Added `readFile` to the `node:fs/promises`
   import.

2. Added three private helpers near the top of the file:
   - `readPlainTextProviderSecrets(path)` — reads a plain JSON secrets
     file, returns `null` on ENOENT or invalid JSON.
   - `envProviderApiKey()` — returns `OPENROUTER_API_KEY` or
     `OPENAI_API_KEY`, or `null`.
   - `readProviderSecrets(path)` — tries `decryptSecretsFile` first
     (upstream behavior), falls back to `readPlainTextProviderSecrets`.
     Used by every read site below so SOPS-unavailable errors don't
     spam the logs.

3. Inside `loadAllProviders`, replaced the `catch` arm of the
   SOPS decryption block with a progressive fallback:
   plain-text JSON → env var → original "skip with warning" behavior.
   The original ENOENT classification (`anyMissingSecret`) is preserved
   for the no-source-found case. (This site keeps its own inline
   fallback rather than using `readProviderSecrets` because it also
   needs the env-var fallback and the original error for ENOENT
   classification.)

4. Refactored four other read sites to use `readProviderSecrets`,
   replacing their direct `decryptSecretsFile` calls and removing
   per-site `try/catch` warnings:
   - `readProvider` — masked per-model key display
   - `listProviders` — per-provider modelKeys detection
   - `probeProviderModels` — now throws a clearer "no usable secrets"
     error if both SOPS and plain-text fail (was a raw SOPS error)
   - `hasProviderSecret` — sentinel `'••••••••••'` is now only returned
     when the file exists but neither SOPS nor plain-text can read it

5. Added `OPENROUTER_API_KEY` and `OPENAI_API_KEY` to `ENV_VARS_TO_SYNC` in
   `services/platform/docker-entrypoint.sh` so the Convex deployment
   itself sees them. Convex actions read `process.env` from the Convex
   service's own env, which is populated only by `bunx convex env set`
   from this list — vars set on the platform container are otherwise
   invisible to actions. Without this, `envProviderApiKey()` would always
   return `null` inside Convex even when the host env has the key.

6. Rewrote the `saveProviderSecret` action body to skip SOPS entirely:
   read existing as plain JSON via `readPlainTextProviderSecrets`, merge
   `args.apiKey` / `args.modelKeys`, write the merged result back as
   plain JSON via `atomicWrite`. The `SOPS_AGE_KEY` pre-check, the
   `sops -e` exec, and the temp-dir plumbing are all removed. (This
   site uses the plain-text-only helper rather than `readProviderSecrets`
   because the function is committed to a plain-text write — mixing a
   SOPS read with a plain-text write would be inconsistent.)

**Out of scope (deliberately not patched):**

- `lib/sops.ts` — left as-is. Its top-level throw is caught by every
  call site through `readProviderSecrets` or the inline fallback in
  `loadAllProviders`.
- `lib/secret_box.ts` — only relevant to the governance/moderation
  feature, which Nuvolos does not currently expose. The HKDF-on-
  `SOPS_AGE_KEY` derivation will throw if that surface is ever hit;
  patch in a follow-up if/when that becomes a concern.

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
