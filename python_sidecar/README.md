# BabelScore Python Sidecar

Computes reference-based translation metrics (chrF++, BLEU, TER) using [sacrebleu](https://github.com/mjpost/sacrebleu). Called synchronously by `main.js` after all LLM calls complete.

## Setup

```bash
cd python_sidecar
python3 -m venv .venv
source .venv/bin/activate
pip install sacrebleu
```

## Interface

Reads JSON from stdin, writes JSON to stdout.

**Input:**
```json
{
  "directions": [
    {
      "label": "Bislama → English",
      "models": {
        "model-id": {
          "hypotheses": ["translation 1", "translation 2"],
          "references": ["reference 1", "reference 2"]
        }
      }
    }
  ]
}
```

**Output:**
```json
{
  "directions": [
    {
      "label": "Bislama → English",
      "models": {
        "model-id": {
          "corpus": { "chrf": 54.3, "bleu": 28.1, "ter": 61.4 },
          "sentences": [
            { "chrf": 61.2, "bleu": 35.0, "ter": 55.0 }
          ]
        }
      }
    }
  ]
}
```

## Metrics

| Metric | Direction | Notes |
|--------|-----------|-------|
| **chrF++** | ↑ higher | Character n-gram F-score with word bigrams (`word_order=2`) |
| **BLEU** | ↑ higher | Modified n-gram precision with brevity penalty |
| **TER** | ↓ lower | Translation Edit Rate |
