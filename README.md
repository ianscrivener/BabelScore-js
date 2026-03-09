# BabelScore

> *Score the translation capability of any LLM. A reproducible, LLM-as-judge based translation quality metric.*

BabelScore is a language-agnostic translation benchmarking harness. It feeds source sentences through one or more **translator** models, then has one or more **judge** models score each translation, and produces an aggregated scorecard in Markdown and JSON.

Any OpenAI-compatible endpoint can act as translator or judge — local models via LM Studio or Ollama, or cloud APIs via OpenRouter, OpenAI, Anthropic, etc.

---

## Requirements

- **Node.js** v18 or later (v22 recommended)
- An LLM endpoint for translation (LM Studio, Ollama, OpenRouter, etc.)
- An LLM endpoint for judging (same options)

---

## Installation

```bash
git clone <repo>
cd BabelScore_js
npm install
```

Copy the environment file and fill in any API keys you need:

```bash
cp .env.example .env
```

Edit `.env` and add keys for the providers you intend to use, for example:

```
OPENROUTER_API_KEY=sk-or-v1-...
```

Local providers (LM Studio, Ollama) do not require an API key.

---

## Project structure

```
BabelScore_js/
├── main.js               # Core evaluation runner
├── getModelList.js        # Utility: refresh cached model lists
├── config.json            # Global provider registry
├── .env                   # API keys (never commit this)
├── DATA/
│   ├── LLM_CACHE/         # Cached model lists per provider
│   └── PROMPTS/default/   # Prompt templates
└── _PROJECTS/
    └── <project-name>/
        ├── config.json    # Project configuration
        ├── data/          # Test sentence files
        └── results/       # Scorecard output (JSON + Markdown)
```

---

## Creating a project

1. Create a folder under `_PROJECTS/<your-project>/`.
2. Add a `config.json` (see [Configuration reference](#configuration-reference) below).
3. Add your test data files under `_PROJECTS/<your-project>/data/`.

You can copy `_PROJECTS/_example/` as a starting point.

---

## Running an evaluation

```bash
node main.js -project <project-name>
```

Example:

```bash
node main.js -project _example
```

Results are written to `_PROJECTS/<project-name>/results/` as both a Markdown scorecard and a JSON data file, timestamped. Progress is saved incrementally after each sentence so a partial run is never lost.

Press **Ctrl+C** at any time to abort — results so far are saved with `status: "interrupted"`.

---

## Refreshing model caches

To populate or update the cached list of available models for the providers used by a project:

```bash
node getModelList.js -project <project-name>
```

This queries each provider's `/v1/models` endpoint and writes the results to `DATA/LLM_CACHE/<provider>/models.json`. For OpenRouter it also writes a trimmed `models_lite.json`.

---

## Data format

### NDJSON (recommended)

One JSON object per line. Fields:

| Field | Description |
|---|---|
| `#` | Sentence ID (integer) |
| `SourceL` | Source language code (e.g. `eng`, `yue`, `zh`) |
| `TargetL` | Target language code |
| `SourceText` | Source sentence |
| `TargetText` | Reference translation |

Example (`eng_yue_test.json`):

```json
{"#":64,"SourceL":"eng","TargetL":"yue","SourceText":"My Mandarin is so bad...","TargetText":"我普通話太差..."}
{"#":65,"SourceL":"eng","TargetL":"yue","SourceText":"Since the clothes no longer fit...","TargetText":"啲衫既然已經唔啱着..."}
```

### CSV (legacy)

Two-column CSV with a header row. First column = source, second = reference. Direction is inferred from config `source_language` / `target_language`.

---

## Configuration reference

`_PROJECTS/<project>/config.json`:

```jsonc
{
  "project": "my-project",
  "description": "English ↔ Cantonese benchmark",
  "paradigm": 5,

  // Language metadata
  "source_language": "English",
  "source_language_code": "en",
  "target_language": "Cantonese",
  "target_language_code": "yue",

  // Data files — one file per direction (NDJSON)
  "data_file_format": "json",   // "json" | "csv"
  "data_file_combined": false,  // false = one file per direction
  "data_files": [
    "data/eng_yue_test.json",
    "data/yue_eng_test.json"
  ],
  "max_sentences": 10,          // optional — total sentences across all directions
                                // each direction gets floor(max_sentences / numDirections)

  // Single CSV (legacy)
  // "data_file": "data/sentences.csv",

  "translator_models": [
    {
      "id": "lmstudio-qwen3.5",          // unique label for output
      "provider": "lm_studio",
      "model": "qwen/qwen3.5-35b-a3b",   // model identifier
      "base_url": "http://localhost:1234/v1",
      "api_key": "",
      "auto_load": false,   // true = load model via LM Studio API before run
      "auto_unload": false, // true = unload after run
      "max_tokens": 1024,
      "temperature": 0.0
    }
  ],

  "judge_models": [
    {
      "id": "openrouter-claude-sonnet",
      "provider": "openrouter",
      "model": "anthropic/claude-sonnet-4-5",
      "base_url": "https://openrouter.ai/api/v1",
      "api_key": "${OPENROUTER_API_KEY}"
      // response_format defaults to {"type":"json_object"} — forces valid JSON output.
      // Override with {"type":"json_schema",...} for strict schema enforcement,
      // or set to null to disable (e.g. for models that don't support it).
    }
  ],

  "output": {
    "format": "markdown",
    "results_dir": "results",
    "show_judge_reasoning": true,
    "flag_high_variance": true,
    "variance_threshold": 15   // flag scores with variance above this
  }
}
```

### Evaluation paradigms

| Paradigm | Description |
|---|---|
| 1 | Round-trip back-translation, no judge |
| 2 | One direction, LLM judge, no reference |
| 3 | One direction, LLM judge, with reference |
| 4 | Bidirectional, LLM judge, no reference |
| **5** | **Bidirectional, LLM judge, with reference** ← recommended |

### LM Studio auto-load

Set `"auto_load": true` on a translator model to have BabelScore automatically load it via the LM Studio management API before the run starts, and `"auto_unload": true` to unload it afterwards. Requires LM Studio to be running with the server enabled.

---

## Prompt templates

Prompts live in `DATA/PROMPTS/default/`. They use `[system]` / `[user]` section headers and `{{variable}}` substitution:

- `translate_template.txt` — variables: `{{from_lang}}`, `{{to_lang}}`, `{{text}}`
- `judge_template.txt` — variables: `{{from_lang}}`, `{{to_lang}}`, `{{source}}`, `{{translation}}`, `{{reference_line}}`

Edit these files to change the evaluation rubric or translation instructions without touching the code.

---

## Output

Each run produces two files in `_PROJECTS/<project>/results/`:

- `scorecard_<timestamp>.md` — human-readable Markdown scorecard with a summary table and per-sentence breakdown
- `scorecard_<timestamp>.json` — full machine-readable results including all translations, scores, and judge reasoning

Scores are on a **0–100** scale.
