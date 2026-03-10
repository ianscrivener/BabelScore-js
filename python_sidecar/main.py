"""
BabelScore Python sidecar — reference-based metrics

Input  (stdin) : JSON { directions: [ { label, models: { modelId: { hypotheses, references } } } ] }
Output (stdout): JSON { directions: [ { label, models: { modelId: { corpus: {chrf, bleu, ter}, sentences: [{chrf, bleu, ter}] } } } ] }

Metrics:
  chrF++  — character n-gram F-score with word bigrams (word_order=2); higher is better
  BLEU    — modified n-gram precision with brevity penalty; higher is better
  TER     — translation edit rate; lower is better
"""

import sys
import json
from sacrebleu.metrics import BLEU, CHRF, TER

_bleu = BLEU(effective_order=True)
_chrf = CHRF(word_order=2)          # chrF++ (word_order=2 adds word bigrams)
_ter  = TER()


def _safe(text: str) -> str:
    """Replace empty/null strings with a single space to avoid metric crashes."""
    return text.strip() if text and text.strip() else " "


def score_model(hypotheses: list[str], references: list[str]) -> dict:
    hyps = [_safe(h) for h in hypotheses]
    refs = [_safe(r) for r in references]

    corpus = {
        "chrf": round(_chrf.corpus_score(hyps, [refs]).score, 2),
        "bleu": round(_bleu.corpus_score(hyps, [refs]).score, 2),
        "ter":  round(_ter.corpus_score(hyps, [refs]).score, 2),
    }

    sentences = []
    for h, r in zip(hyps, refs):
        try:
            ter_s = round(_ter.sentence_score(h, [r]).score, 2)
        except Exception:
            ter_s = None
        sentences.append({
            "chrf": round(_chrf.sentence_score(h, [r]).score, 2),
            "bleu": round(_bleu.sentence_score(h, [r]).score, 2),
            "ter":  ter_s,
        })

    return {"corpus": corpus, "sentences": sentences}


def main():
    try:
        data = json.load(sys.stdin)
    except Exception as e:
        json.dump({"error": f"stdin parse error: {e}"}, sys.stdout)
        sys.exit(1)

    output = {"directions": []}
    for direction in data.get("directions", []):
        dir_out = {"label": direction["label"], "models": {}}
        for model_id, model_data in direction.get("models", {}).items():
            try:
                dir_out["models"][model_id] = score_model(
                    model_data["hypotheses"],
                    model_data["references"],
                )
            except Exception as e:
                dir_out["models"][model_id] = {"error": str(e)}
        output["directions"].append(dir_out)

    json.dump(output, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
