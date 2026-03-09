# BabelScore — Brainstorm Summary

*Session date: March 8, 2026*

---

## Table of Contents

| # | Topic | Summary |
|---|---|---|
| 1 | Starting point | HKCanto-Eval experience — BLEU unreliable for low-resource languages, LLM-as-judge is better |
| 2 | Research | Surveyed existing tools — lechmazur/translation (closed benchmark), Optum/nmt (BLEU-only, 4 years old). Gap confirmed. |
| 3 | Concept | Brainstormed a language-agnostic translation benchmark harness: N translators → M judges → scorecard |
| 4 | Evaluation paradigms | Defined 5 paradigms from round-trip/no-judge through to bidirectional+reference+judge (Paradigm 5) |
| 5 | Paradigm table | Formalised into table: description, directionality, data required, judged by |
| 6 | Init wizard | Designed 2-question wizard: what are you testing (1a/1b/1c) × what data do you have (2a/2b/2c) |
| 7 | API standard | Mandated OpenAI-compatible API format — covers OpenRouter, Ollama, direct APIs uniformly |
| 8 | Architecture | Python CLI, per-project YAML config, `~/.babelscore` directory structure |
| 9 | CLI design | `babelscore init / run / results / list` — channelling Claude Code simplicity |
| 10 | Naming | Settled on **BabelScore** as metric name, `babelscore` as CLI command |
| 11 | Tagline | *"Score the translation capability of any LLM. A reproducible, LLM-as-judge based translation quality metric."* |
| 12 | README | Drafted full README covering metric definition, versioning, paradigms, quickstart, data format |
| 13 | Three interfaces | CLI wizard, YAML+CLI headless, Streamlit UI |
| 14 | Tech stack | Textual (TUI), Streamlit (HF Spaces), asyncio+httpx (parallel calls), smolagents (optional) |
| 15 | HF Spaces role | Concluded HF Space is best as showcase/leaderboard, not primary interface — real users run locally |

---

## Section Notes

### 1. Starting Point
The project emerged from hands-on experience with HKCanto-Eval, benchmarking LLMs on English↔Cantonese translation. BLEU and similar metrics proved deeply unreliable for low-resource and creole languages due to high valid-translation variance and tokenisation issues. LLM-as-judge was identified as the more valid approach, consistent with findings from Bislama benchmarking work.

### 2. Research
A thorough web search found no existing tool that combines bring-your-own test sentences, arbitrary translator models, arbitrary judge models, and a clean scorecard output. The closest candidates were lechmazur/translation (a closed static benchmark, not a reusable harness) and Optum/nmt (a pluggable MT evaluation framework, but BLEU-only and four years out of date). The gap is real and worth filling.

### 3. Concept
The core pipeline is straightforward: source sentences feed into N translator models, producing translations that are then evaluated by M judge models, yielding an aggregated scorecard. The tool is designed to be language-agnostic, model-agnostic, and judge-agnostic — any OpenAI-compatible endpoint can participate in any role. The primary use cases are model development iteration and rigorous benchmarking of translation capability.

### 4. Evaluation Paradigms
Five distinct evaluation paradigms were identified, ranging in rigour and data requirements. Paradigm 1 uses automated round-trip back-translation with no judge. Paradigms 2–5 progressively add LLM judges, reference translations, and bidirectional testing, culminating in Paradigm 5 as the gold standard.

### 5. Paradigm Table
The five paradigms were formalised into a reference table with four columns: paradigm number, two-sentence description, data required, and judged-by. The key insight from the table is that a true parallel corpus serves all four roles simultaneously — each sentence is both source and reference depending on direction — making Paradigm 5 highly data-efficient relative to its rigour.

### 6. Init Wizard
The setup wizard asks two questions: what are you testing (single model/multiple models on one pair/multiple models on multiple pairs) and what data do you have (parallel corpus/source sentences only/no data). The paradigm is derived automatically from these answers rather than asked directly, since most users won't think in paradigm terms. The 2c branch (no data) routes to a data wizard offering to find existing corpora or generate synthetic data.

### 7. API Standard
All translator and judge models must expose an OpenAI-compatible chat completions endpoint. This single decision covers the vast majority of use cases — OpenRouter, Ollama, Together, Groq, direct OpenAI, direct Anthropic (via compatible wrappers) — with one HTTP client and no provider-specific SDK dependencies. It also means local models (Ollama) and cloud models are configured identically.

### 8. Architecture
Projects are stored in `~/.babelscore/projects/[project-name]/` with a `config.yaml`, a `data/` directory, and a `results/` directory. API keys are stored globally in `~/.babelscore/.env` and never committed. The YAML config is the canonical project state regardless of how it was created — wizard, manual edit, or UI.

### 9. CLI Design
The CLI surface follows the `babelscore [verb] [project]` pattern: `init`, `run`, `results`, `list`, `config`, and `ui`. The design is consciously modelled on Claude Code's CLI — familiar, minimal, and opinionated. The `init` command drives the wizard; all other commands operate on named projects.

### 10. Naming
Several creative options were considered including Gauntlet, Gloss, Crucible, and Translucent. BabelScore was chosen for its immediate cultural legibility — the Tower of Babel is universally understood as a symbol of language complexity — combined with the precision of "Score" signalling a measurable metric. The CLI command `babelscore` was chosen as the natural imperative form.

### 11. Tagline
The final tagline — *"Score the translation capability of any LLM. A reproducible, LLM-as-judge based translation quality metric."* — was arrived at collaboratively. The first sentence is the action; the second is the differentiator. Together they answer "what does it do" and "why is it different" in under twenty words.

### 12. README
A full README was drafted covering: the BabelScore metric definition, the versioning system (judge models + rubric + aggregation pinned per version), the five evaluation paradigms, CLI and Streamlit quickstarts, config.yaml reference, test data CSV formats, a sample scorecard, the no-data wizard branch, roadmap, and contribution guidelines. The README doubles as the HuggingFace Space description.

### 13. Three Interfaces
BabelScore supports three ways to run an evaluation: the CLI wizard (interactive, guided, no config knowledge needed), YAML + CLI headless (power user and CI/CD mode, edit config directly), and the Streamlit UI (browser-based, HuggingFace Spaces compatible). All three share the same core pipeline and the same YAML config format. The interface choice doesn't affect the output.

### 14. Tech Stack
The recommended stack is Textual for the CLI wizard TUI, Streamlit for the HuggingFace Spaces UI, and asyncio + httpx for parallel API calls to translator and judge models. smolagents (HuggingFace's lightweight agent framework) was identified as an optional execution backend that aligns well with the HF ecosystem. For v1 the parallelism can be handled directly with asyncio without any agent framework overhead.

### 15. HuggingFace Spaces Role
The target user — a fine-tuner or researcher iterating on translation models — is almost certainly a local CLI user who wants scriptability, reproducibility, and CI integration. The HuggingFace Space is better positioned as a showcase and community leaderboard for published BabelScores rather than a primary execution environment. The API key friction in a hosted browser UI is a significant barrier for the intended audience.

---

*Next step: scaffold the repository and begin implementation.*
