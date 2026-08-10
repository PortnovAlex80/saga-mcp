# CLAUDE.md — Claude Code / LM Studio notes for saga-mcp

## Saga4 Factory launch

For the canonical real-worker Factory procedure, read
[`docs/FACTORY-START-QUICKSTART.md`](docs/FACTORY-START-QUICKSTART.md) first.
The detailed Russian operational runbook is
[`ЗАВОД-ЗАПУСК.md`](ЗАВОД-ЗАПУСК.md). `scripts/factory.mjs` creates the durable
Factory launch; `SAGA_PRODUCT_LIFECYCLE_COMPOSITION` supplies lifecycle
infrastructure providers and does not replace the real LLM worker. Always
observe the tracker against the exact Factory DB used by the launch. Set
`SAGA_FACTORY_CONCURRENCY` before both `start` and `resume`; GLM-4.7 is capped
at two concurrent workers by the canonical model profile. Use
`--requeue-paused` only for an exhausted submission-preflight Workplace and
`--recover-failed-gate` only for a verified post-seal provider-version
mismatch; the full invariants are in the quickstart.
For a terminal downstream failure with a certified upstream prefix, use the
quickstart's `factory.mjs continue ... --check` procedure. Never reopen terminal
rows or restore an older whole-factory checkpoint merely to retry one workshop.

## LM Studio: Qwen 3.6 chat template patch

### Problem

Claude Code CLI sends `system` messages mid-conversation (not as the first message).
The default Jinja chat template for Qwen 3.6 models in LM Studio raises an exception:

```
Jinja Exception: System message must be at the beginning.
```

This breaks `claude -p` calls through LM Studio's Anthropic `/v1/messages` endpoint.

Reference: [lmstudio-ai/lmstudio-bug-tracker#1999](https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/1999)

### Files to patch

The Jinja template lives in **two** places per model:

1. **Hub template (canonical, used by API endpoint)**:
   `~/.lmstudio/hub/models/{publisher}/{model-name}/model.yaml`

2. **User override (per-model defaults)**:
   `~/.lmstudio/.internal/user-concrete-model-default-config/{publisher}/{model-name}.json`

For Qwen models on this machine:

| Model | Hub template path | User override path |
|---|---|---|
| `qwen/qwen3.6-27b` | `~/.lmstudio/hub/models/qwen/qwen3.6-27b/model.yaml` | `~/.lmstudio/.internal/user-concrete-model-default-config/qwen/qwen3.6-27b.json` |
| `qwen/qwen3.6-35b-a3b` | `~/.lmstudio/hub/models/qwen/qwen3.6-35b-a3b/model.yaml` | `~/.lmstudio/.internal/user-concrete-model-default-config/qwen/qwen3.6-35b-a3b.json` |

### What to change

Find this block in the Jinja template (inside the `{%- for message in messages %}` loop):

```jinja
{%- if message.role == "system" %}
    {%- if not loop.first %}
        {{- raise_exception('System message must be at the beginning.') }}
    {%- endif %}
```

Replace with:

```jinja
{%- if message.role == "system" %}
    {%- if not loop.first %}
        {%- if content %}
            {{- '<|im_start|>system\n' + content + '<|im_end|>\n' }}
        {%- endif %}
    {%- endif %}
```

### After patching

**Reload the model** in LM Studio (unload → load) or via CLI:

```bash
lms unload "qwen/qwen3.6-27b"
lms load "qwen/qwen3.6-27b" -c 120000 --gpu max -y
```

### Verify

```bash
claude -p --model "qwen/qwen3.6-27b" --output-format text --no-session-persistence "Say hello"
```

### LM Studio config paths (reference)

| Path | Purpose |
|---|---|
| `~/.lmstudio/settings.json` | Global settings (downloads folder, server port, developer mode) |
| `~/.lmstudio/.internal/http-server-config.json` | Server config (port 1234, auto-start) |
| `~/.lmstudio/.internal/backend-preferences-v1.json` | Backend (llama.cpp version, GPU offload) |
| `~/.lmstudio/hub/models/{publisher}/{name}/model.yaml` | Hub model definition + chat template |
| `~/.lmstudio/.internal/user-concrete-model-default-config/{publisher}/{name}.json` | User per-model overrides (load config + template override) |

### Models tested with Claude Code + LM Studio

| Model | Works out of box? | Patch needed? |
|---|---|---|
| `zai-org/glm-4.7-flash` | Yes | No |
| `qwen/qwen3.6-27b` | No (Jinja exception) | Yes |
| `qwen/qwen3.6-35b-a3b` | No (same template) | Yes |

### Context length is load-time only

Cannot override context length per-request. Must reload model with `-c` flag:

```bash
lms load "qwen/qwen3.6-27b" -c 120000 -y    # 120K context
lms load "qwen/qwen3.6-27b" -c 256000 -y    # full 256K
```

`max_tokens` (response length) is per-request and set by Claude Code automatically.

### Patching models without inline template (GGUF-embedded)

Some models (e.g. `qwen/qwen3.5-9b`) don't have an inline Jinja template in `model.yaml` — the template is embedded inside the GGUF file. To patch these:

1. **Extract the original template from GGUF:**
   ```bash
   python -c "
   import gguf, json, numpy as np
   reader = gguf.GGUFReader('D:/LM_models/lmstudio-community/Qwen3.5-9B-GGUF/Qwen3.5-9B-Q4_K_M.gguf')
   field = reader.fields['tokenizer.chat_template']
   template = bytes(np.array(field.parts[4])).decode('utf-8')
   patched = template.replace(
       \"{{- raise_exception('System message must be at the beginning.') }}\",
       \"{%- if content %}\n    {{- '<|im_start|>system\n' + content + '<|im_end|>\n' }}\n{%- endif %}\"
   )
   print(json.dumps(patched))
   "
   ```

2. **Write into user override JSON** (`~/.lmstudio/.internal/user-concrete-model-default-config/qwen/qwen3.5-9b.json`):
   - Add `structuredPrediction: none` in operation fields
   - Add `promptTemplate` with the extracted+patched template in load fields

3. **Reload the model.**

### Additional fix: structuredPrediction

Some models (e.g. `qwen/qwen3-4b-thinking-2507`) fail with `failed to parse grammar`. This happens because Claude Code sends structured output grammar that the model's inference backend can't parse. Adding `structuredPrediction: none` in both `model.yaml` and user override JSON may help, but in some cases the grammar is sent via API request body and cannot be overridden — such models are **incompatible with Claude Code through LM Studio**.

### Tested models — compatibility matrix

| Model | Works with Claude Code? | Patch needed? | Notes |
|---|---|---|---|
| `zai-org/glm-4.7-flash` | ✅ Yes | No | Works out of the box |
| `google/gemma-4-12b-qat` | ✅ Yes | No | Works out of the box |
| `qwen/qwen3.6-27b` | ✅ Yes | Yes (Jinja `raise_exception`) | Patch hub model.yaml OR user override JSON |
| `qwen/qwen3.6-35b-a3b` | ✅ Yes | Yes (same template as 3.6-27b) | Patch hub model.yaml |
| `qwen/qwen3.5-9b` | ✅ Yes | Yes (Jinja, GGUF-embedded template) | Extract from GGUF → patch → write to user override JSON |
| `qwen/qwen3-4b-thinking-2507` | ❌ No | N/A | `failed to parse grammar` — Claude Code sends incompatible structured output grammar. Not fixable via template/config patch. |
