# make_report.js

> Aggregate all BabelScore scorecard JSON files into a Markdown report.

`make_report.js` scans one or more `_PROJECTS/` directories for `scorecard_*.json` files, aggregates the scores, and produces a ranked Markdown report with two tables:

1. **Summary** — one row per translator (all directions merged)
2. **Detail** — one row per translator × direction

---

## Usage

```bash
# Print report to stdout
node make_report.js

# Write report to a file
node make_report.js --output _PROJECTS/report.md

# Use custom projects directory
node make_report.js --projects-dir /path/to/_PROJECTS --output report.md

# Combine options
node make_report.js -p ./my_projects -o results/report.md
```

### CLI Flags

| Flag | Alias | Description | Default |
|------|-------|-------------|---------|
| `--projects-dir` | `-p` | Path to projects directory | `./_PROJECTS` |
| `--output` | `-o` | Output Markdown file (stdout if omitted) | — |

---

## How It Works

### 1. Discovery

The script recursively walks `projectsDir` looking for files matching:
```
scorecard_*.json
```

Any scorecard files found in nested project directories are included.

### 2. Aggregation

For each scorecard, it extracts:

- `project` — project name
- `direction` — translation direction (e.g., "Mandarin → Cantonese")
- `translatorId` — translator model ID
- `scores` — array of numeric scores from all judges
- `judgeScores` — per-judge score arrays

The data structure in the JSON is traversed as:

```javascript
sc.directions[].sentences[].translations[translatorId].scores[judgeId].score
```

### 3. Computation

For each translator × direction combination, it computes:

- **n** — total number of scored sentences
- **Avg** — overall average score (all judges combined)
- **Judge Avgs** — average score per individual judge

### 4. Output

Two Markdown tables are generated:

#### Summary Table
Groups by (project, translator) — merges all directions.

| Column | Description |
|--------|-------------|
| Project | Project name |
| Translator | Translator model ID |
| n | Total sentences scored |
| Avg | Average score (bold) |
| [Judge]... | One column per judge with their average |

#### Detail Table
One row per translator × direction.

| Column | Description |
|--------|-------------|
| Project | Project name |
| Translator | Translator model ID |
| Direction | Translation direction |
| n | Sentences in this direction |
| Avg | Average score (bold) |
| [Judge]... | One column per judge |

Both tables are sorted by **Avg** descending.

---

## Example Output

```markdown
# BabelScore Report

_Generated: 2026-03-16T19:30:00.000Z_  
_Scorecard files: 12_

## Summary — by Translator (all directions combined)

| Project | Translator | n | Avg | claude-sonnet | gpt-4o |
| --- | --- | --- | --- | --- | --- |
| ZH-YUE | byteplus-glm-5 | 141 | **94.0** | 89.9 | 93.6 |
| ZH-YUE | qwen3.5-35b | 200 | **87.8** | 84.2 | 90.9 |

## Detail — by Translator × Direction

| Project | Translator | Direction | n | Avg | claude-sonnet | gpt-4o |
| --- | --- | --- | --- | --- | --- | --- |
| ZH-YUE | byteplus-glm-5 | Cantonese → Mandarin | 60 | **94.3** | 90.0 | 93.3 |
| ZH-YUE | byteplus-glm-5 | Mandarin → Cantonese | 81 | **93.8** | 89.9 | 93.9 |

## Source Files

- `_PROJECTS/ZH-YUE/results/scorecard_2026-03-10T04-30-44.json`
- `_PROJECTS/BIS-ENG/results/scorecard_2026-03-10T06-53-07.json`
```

---

## Error Handling

| Scenario | Behavior |
|----------|----------|
| No scorecard files found | Exits with error: `No scorecard JSON files found under <path>` |
| No scored translations in files | Exits with error: `No scored translations found in any scorecard.` |
| Malformed JSON in a file | Skips that file, continues processing |

---

## Integration Tips

### Generate report as part of a workflow

```bash
# Run benchmarks first, then generate report
node main.js -project BIS-ENG && \
node make_report.js -o _PROJECTS/report.md
```

### Cron job for daily reports

```bash
# Run every day at 9am
0 9 * * * cd /path/to/BabelScore && node make_report.js -o daily-report.md
```

### Custom judge ID shortening

The `shortJudge()` function strips common prefixes for cleaner table headers:
- `openrouter-`
- `lmstudio-`
- `openai-`
- `anthropic-`

To modify, edit lines 182–189 in `make_report.js`.

---

## See Also

- [main.js](./main.md) — Running evaluations
- [Configuration reference](../README.md#configuration-reference)
- [Data formats](../README.md#data-format)