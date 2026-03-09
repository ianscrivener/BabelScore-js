# BabelScore

**Score the translation capability of any LLM. A reproducible, LLM-as-judge based translation quality metric.**

---

## What is BabelScore?

BabelScore is a multilingual translation quality metric produced by large language models acting as judges, rather than a purely algorithmic metric like BLEU or METEOR. It summarises how well a model performs on translation tasks on a 0–10 scale, and can be scoped to specific language pairs or domains (for example, *European Language BabelScore* or *Pacific Creole BabelScore v1.0*).

The key idea: a fixed set of judge models uses a shared rubric and shared prompts to score translations. This makes scores **consistent, comparable, and reproducible** — as long as the judge configuration is pinned.

BabelScore is particularly well suited to **low-resource languages** where BLEU is unreliable due to sparse reference data and high valid-translation variance.

---

## Why not BLEU?

BLEU and similar n-gram overlap metrics have well-documented problems:

- They penalise valid paraphrases that don't match the reference
- They fail on morphologically rich or low-resource languages
- They have no concept of semantic correctness
- They reward fluent-sounding wrong translations

LLM-as-judge evaluation anchored to a reference translation sidesteps all of these. The judge compares meaning, not token overlap.

---

## Versioning

BabelScore uses explicit versioning to ensure reproducibility. A version is defined by:

- The judge models used (name + version)
- The evaluation rubric and prompts
- The aggregation method (e.g. mean of judge scores)

**Example:** `BabelScore v1.0` might be defined as the mean score from Claude Sonnet 4.6, Gemini 2.5 Pro, and GPT-4o under the published v1.0 rubric. If any component changes, the version is bumped.

Model cards and reports should always cite both score and version:

> *European Language BabelScore v1.0: 8.7 / 10*

---

## Evaluation Paradigms

BabelScore supports five evaluation paradigms depending on your data and goals:

| # | Description | Data Required | Judged By |
|---|---|---|---|
| 1 | **Round-trip** — Source → Target → Source, scored by string similarity | Source sentences only | Algorithm |
| 2 | **One-way, cold judge** — Source → Target, judge evaluates without reference | Source sentences only | LLM as judge |
| 3 | **One-way with reference** — Source → Target, judge compares against gold translation | Source + reference translations | LLM as judge |
| 4 | **Bidirectional, cold judge** — Both directions tested independently, no reference | Parallel sentence pairs | LLM as judge |
| 5 | **Bidirectional with reference** — Both directions tested, judge anchored to gold reference | Parallel sentence pairs | LLM as judge |

**Paradigm 5 is the gold standard.** A true parallel corpus serves all four roles simultaneously — each sentence is both source and reference depending on direction. This also reveals asymmetry: a model may score well on English → Bislama but poorly on Bislama → English.

---

## Quickstart (CLI)

```bash
# Install UV (if not already installed)
curl -LsSf https://astral.sh/uv/install.sh | sh

# Clone and set up
git clone https://github.com/yourusername/babelscore
cd babelscore
uv sync

# Activate the virtual environment
source .venv/bin/activate
# Tip: add this alias to your ~/.zshrc for convenience:
# alias uvsrc="source .venv/bin/activate"

# Create a new project
babelscore init

# Run evaluation
babelscore run my-project

# View results
babelscore results my-project
```

### Project structure

```
~/.babelscore/
├── projects/
│   ├── my-project/
│   │   ├── config.yaml       # models, judges, language pair, paradigm
│   │   ├── data/
│   │   │   └── test_set.csv  # source sentences or parallel corpus
│   │   └── results/
│   │       └── scorecard.md  # output
└── .env                      # API keys, shared across projects
```

### config.yaml

```yaml
project: my-project
paradigm: 5
source_language: English
target_language: French

translator_models:
  - name: llama-3.1-8b
    base_url: http://localhost:11434/v1
    api_key: ollama
  - name: qwen/qwen-2.5-7b-instruct
    base_url: https://openrouter.ai/api/v1
    api_key: ${OPENROUTER_API_KEY}

judge_models:
  - name: claude-sonnet-4-6
    base_url: https://api.anthropic.com/v1
    api_key: ${ANTHROPIC_API_KEY}
  - name: gpt-4o
    base_url: https://api.openai.com/v1
    api_key: ${OPENAI_API_KEY}

output:
  format: markdown       # markdown | json | csv
  show_judge_reasoning: true
  flag_high_variance: true
```

### API keys

BabelScore accepts API keys in order of precedence:

1. Environment variable (e.g. `OPENROUTER_API_KEY`)
2. Global `~/.babelscore/.env`
3. Prompted securely during `babelscore init`

All keys stay local. Nothing is sent anywhere except directly to your configured model endpoints.

---

## Quickstart (HuggingFace Spaces / Streamlit)

BabelScore is also available as a Streamlit app on HuggingFace Spaces for users who prefer a browser interface.

> 🤗 [Open in HuggingFace Spaces](#) *(link coming soon)*

API keys are entered per-session and never stored.

---

## Test Data Format

### Parallel corpus (Paradigms 3, 4, 5)

```csv
source_en,source_target
"The child is eating.","Pikinini i stap kakae."
"She just returned from town.","Hem i jas kambak long taon."
"We will go tomorrow.","Bae yumi go tumora."
```

### Source sentences only (Paradigms 1, 2)

```csv
source
"The committee has not yet reached a decision."
"She had already left before he arrived."
"If it rains tomorrow, we will stay home."
```

For best results, include sentences that expose common failure modes: complex tense, negation, conditionals, idioms, and culturally-specific vocabulary.

---

## Scorecard Output

```
BabelScore v1.0 — English → Bislama
Judges: claude-sonnet-4-6, gpt-4o
Sentences: 25 | Paradigm: 5 (Bidirectional with reference)

Model                     | Judge 1 | Judge 2 | Mean  | Variance
--------------------------|---------|---------|-------|----------
llama-3.1-8b              |   6.2   |   5.9   |  6.05 | low
qwen/qwen-2.5-7b-instruct |   8.1   |   7.8   |  7.95 | low
mistral-7b                |   5.1   |   6.8   |  5.95 | ⚠ HIGH

⚠ High variance on mistral-7b suggests judge disagreement — review flagged sentences.

Reverse direction (Bislama → English):
Model                     | Judge 1 | Judge 2 | Mean  | Variance
--------------------------|---------|---------|-------|----------
llama-3.1-8b              |   7.4   |   7.1   |  7.25 | low
qwen/qwen-2.5-7b-instruct |   8.4   |   8.2   |  8.30 | low
mistral-7b                |   6.2   |   6.0   |  6.10 | low
```

---

## No Data? We Can Help

If you don't have a test set, `babelscore init` will offer to:

- **Find an existing corpus** — BabelScore will suggest relevant public datasets (FLORES-200, OPUS, Tatoeba) for your language pair
- **Generate synthetic data** — For low-resource languages, BabelScore can use an LLM to generate a parallel corpus from a domain description, which you review before use

---

## Roadmap

- [ ] CLI v1 with Paradigms 1–5
- [ ] Streamlit app + HuggingFace Spaces deployment
- [ ] BabelScore v1.0 judge configuration published
- [ ] Public leaderboard for community-submitted scores
- [ ] Support for domain-scoped rubrics (medical, legal, cultural)
- [ ] Native support for low-resource language context hints in judge prompts

---

## Contributing

BabelScore is open source and welcomes contributions, especially:

- New language pair test sets
- Improved judge rubrics
- Domain-specific prompt templates
- Translations of the tool itself

Please open an issue before submitting a large PR.

---

## Citation

If you use BabelScore in research, please cite:

```
@software{babelscore2026,
  title  = {BabelScore: A Reproducible LLM-as-Judge Translation Quality Metric},
  year   = {2026},
  url    = {https://github.com/yourusername/babelscore}
}
```

---

## License

MIT

---

*BabelScore is not affiliated with the historical Rosetta Stone, the Tower of Babel, or any existing translation service. It is, however, deeply sympathetic to anyone who has ever been lost in translation.*
