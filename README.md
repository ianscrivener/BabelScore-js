# BabelScore

> *Score the translation capability of any LLM. A reproducible, LLM-as-judge based translation quality metric.*

BabelScore is a language-agnostic translation benchmarking harness. It feeds source sentences through one or more **translator** models, then has one or more **judge** models score each translation, and produces an aggregated scorecard in Markdown and JSON.

Any OpenAI-compatible endpoint can act as translator or judge — local models via LM Studio or Ollama, or cloud APIs via OpenRouter, OpenAI, Anthropic, etc.

---

## Requirements

- **Node.js** v18 or later (v22 recommended)
- **Python** 3.9 or later (for the reference-metrics sidecar — chrF++, BLEU, TER)
- An LLM endpoint for translation (LM Studio, Ollama, OpenRouter, etc.)
- An LLM endpoint for judging (same options)

---

## Installation

```bash
git clone <repo>
cd BabelScore_js
npm install
```

Set up the Python sidecar (used for chrF++, BLEU, TER reference metrics):

```bash
cd python_sidecar
python3 -m venv .venv
source .venv/bin/activate
pip install sacrebleu
cd ..
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
├── make_report.js         # Cross-project report generator
├── getModelList.js        # Utility: refresh cached model lists
├── config.json            # Global provider registry
├── .env                   # API keys (never commit this)
├── python_sidecar/
│   ├── main.py            # Reference-metrics sidecar (chrF++, BLEU, TER)
│   └── .venv/             # Python virtual environment (sacrebleu)
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

## Generating a cross-project report

Aggregate all scorecard JSON files across every project into a single Markdown report:

```bash
# Print to stdout
node make_report.js

# Write to a file
node make_report.js --output _PROJECTS/report.md

# Custom projects directory
node make_report.js --projects-dir /path/to/_PROJECTS --output report.md
```

The report contains two tables, both sorted by average score descending:

- **Summary** — one row per translator (all directions merged)
- **Detail** — one row per translator × direction

Columns: `Project`, `Translator`, `n` (scored data points), `Avg`, then one column per judge.

---

## Refreshing model caches

To populate or update the cached list of available models for the providers used by a project:

```bash
node getModelList.js -project <project-name>
```

This queries each provider's `/v1/models` endpoint and writes the results to `DATA/LLM_CACHE/<provider>/models.json`. For OpenRouter it also writes a trimmed `models_lite.json`.

---

## Data format

### NDJSON

One JSON object per line. Each file covers one translation direction. Fields:

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

Set `"data_file_format": "json"` and `"data_file_combined": false` (default), listing one file per direction in `data_files`.

### CSV

Two-column CSV with a header row. First column = source language, second = target language. Direction and language codes are taken from the config `source_language` / `target_language` fields.

Set `"data_file_format": "csv"` and `"data_file_combined": true`, with a single filename in `data_file`:

```json
"data_file_format": "csv",
"data_file_combined": true,
"data_file": "data/sentences.csv"
```

For **bidirectional** evaluation (paradigm ≥ 4), BabelScore automatically builds both directions from the single CSV — the reverse direction swaps source and reference columns.

CSV fields with embedded commas must be quoted. Values with inconsistent quoting are handled gracefully.

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
  },

  // Optional: LLM reviewer — appends a concise written review to the scorecard
  "result_reviewer_model": [
    {
      "id": "openrouter-claude-sonnet",
      "provider": "openrouter",
      "model": "anthropic/claude-sonnet-4-5",
      "base_url": "https://openrouter.ai/api/v1",
      "api_key": "${OPENROUTER_API_KEY}"
    }
  ]
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

### BytePlus (Volcano Engine ARK)

Byteplus cloud models use the same OpenAI-compatible `/v1/chat/completions` endpoint. Set `base_url` to your ARK regional endpoint:

```json
{
  "id": "byteplus-seed-2-0-lite",
  "provider": "byteplus",
  "model": "seed-2-0-lite-260228",
  "base_url": "https://ark.ap-southeast.bytepluses.com/api/v3",
  "api_key": "${ARK_API_KEY}",
  "max_tokens": 1024,
  "temperature": 0.0
}
```

> **Note:** `seed-translation-250915` (the dedicated translation model) does not support Chinese/Cantonese pairs. Use a general chat model such as `seed-2-0-lite-260228` for those language pairs.

---

## Prompt templates

Prompts live in `DATA/PROMPTS/default/`. They use `[system]` / `[user]` section headers and `{{variable}}` substitution:

- `translate_template.txt` — variables: `{{from_lang}}`, `{{to_lang}}`, `{{text}}`
- `judge_template.txt` — variables: `{{from_lang}}`, `{{to_lang}}`, `{{source}}`, `{{translation}}`, `{{reference_line}}`

Edit these files to change the evaluation rubric or translation instructions without touching the code.

- `score_reviewer_prompt.txt` — variables: `{{project}}`, `{{src_lang}}`, `{{tgt_lang}}`, `{{paradigm}}`, `{{scorecard}}`
  Used by the optional LLM reviewer (see `result_reviewer_model` in config). The reviewer receives a compact scorecard (corpus scores + per-sentence score grid) and writes a 2–3 sentence summary of translation quality, direction asymmetry, and language-pair capability.

---

## Output

Each run produces two files in `_PROJECTS/<project>/results/`:

- `scorecard_<timestamp>.md` — human-readable Markdown scorecard
- `scorecard_<timestamp>.json` — full machine-readable results including all translations, scores, and judge reasoning

Scores are on a **0–100** scale.

### Scorecard layout

The Markdown scorecard is structured as follows:

1. **Header** — project metadata (paradigm, sentence count, models used, run timestamp)
2. **Summary** — one row per direction with the aggregated score
3. **Per-direction sections** — LLM judge score table + **Reference Metrics** table (chrF++↑, BLEU↑, TER↓)
4. **Review** *(optional)* — a 2–3 sentence written review generated by `result_reviewer_model`, placed after all Reference Metrics sections
5. **Sentence Detail** *(optional, controlled by `show_judge_reasoning`)* — per-sentence source, reference, translation, per-sentence chrF++/BLEU/TER, and judge scores with reasoning

### Reference metrics (chrF++, BLEU, TER)

After all LLM calls complete, BabelScore runs a Python sidecar (`python_sidecar/main.py`) using **sacrebleu** to compute corpus-level and per-sentence reference metrics:

| Metric | Description |
|---|---|
| **chrF++** (↑) | Character n-gram F-score with word order penalty — robust for morphologically rich languages |
| **BLEU** (↑) | Bilingual Evaluation Understudy — the classic MT metric |
| **TER** (↓) | Translation Edit Rate — lower is better |

These appear in the **Reference Metrics** table for each direction, and inline under each translation in the Sentence Detail section.

If the Python sidecar is unavailable or errors, the LLM judge scores are still written normally.

Judge parse failures are logged to `judge_errors_<timestamp>.jsonl` in the same directory (only written if errors occur).

To roll up results across all projects into one report, see [Generating a cross-project report](#generating-a-cross-project-report).
