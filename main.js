/**
 * main.js — BabelScore evaluation runner
 *
 * Usage: node main.js -project <project-name>
 *
 * Pipeline:
 *   Load CSV → translate with N models → judge each translation with M judges
 *   → aggregate scores → write markdown scorecard + JSON results
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { config as loadDotenv } from 'dotenv';
import { parse as parseCsv } from 'csv-parse/sync';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadDotenv({ quiet: true, path: resolve(__dirname, '.env') });

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const projectFlag = args.indexOf('-project');

if (projectFlag === -1 || !args[projectFlag + 1]) {
  console.error('Usage: node main.js -project <project-name>');
  process.exit(1);
}

const projectName = args[projectFlag + 1];

// ---------------------------------------------------------------------------
// Load configs
// ---------------------------------------------------------------------------

const rootConfig = JSON.parse(
  readFileSync(resolve(__dirname, 'config.json'), 'utf8')
);

const projectDir = resolve(__dirname, '_PROJECTS', projectName);
let cfg;
try {
  cfg = JSON.parse(readFileSync(resolve(projectDir, 'config.json'), 'utf8'));
} catch {
  console.error(`Cannot read project config: ${resolve(projectDir, 'config.json')}`);
  process.exit(1);
}

const {
  paradigm,
  source_language: srcLang,
  target_language: tgtLang,
  translator_models: translators,
  judge_models: judges,
  output: outputCfg,
} = cfg;

const varianceThreshold = outputCfg.variance_threshold ?? 1.5;

// ---------------------------------------------------------------------------
// Language code → name map (from config)
// ---------------------------------------------------------------------------

const langNames = {};
if (cfg.source_language_code) langNames[cfg.source_language_code] = srcLang;
if (cfg.target_language_code) langNames[cfg.target_language_code] = tgtLang;
function langName(code) { return langNames[code] || code; }

// ---------------------------------------------------------------------------
// Data loaders
// ---------------------------------------------------------------------------

function loadNDJSON(filePath) {
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

function loadCSV(filePath) {
  // Parse as raw arrays so we can handle unquoted commas in data fields.
  // The file format is two logical columns (col0, col1); any extra tokens
  // produced by commas inside the second field are re-joined with commas.
  const rows = parseCsv(readFileSync(filePath, 'utf8'), {
    columns: false,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
    relax_quotes: true,
  });
  if (rows.length < 2) return [];
  const [headerRow, ...dataRows] = rows;
  const [col0 = 'col0', col1 = 'col1'] = headerRow;
  return dataRows.map((row) => ({
    [col0]: row[0] ?? '',
    [col1]: row.slice(1).join(','),
  }));
}

function loadDataFile(filePath, format) {
  const abs = resolve(projectDir, filePath);
  try {
    if (format === 'json') {
      const rows = loadNDJSON(abs);
      return rows.map((r, i) => ({
        line: i + 1,
        source: r.SourceText,
        reference: r.TargetText,
        fromLang: langName(r.SourceL),
        toLang: langName(r.TargetL),
        fromLangCode: r.SourceL,
        toLangCode: r.TargetL,
      }));
    } else {
      // csv / txt — two-column format; direction always comes from config
      const rows = loadCSV(abs);
      const [srcCol, tgtCol] = Object.keys(rows[0]);
      return rows.map((r, i) => ({
        line: i + 1,
        source: r[srcCol],
        reference: r[tgtCol],
        fromLang: srcLang,
        toLang: tgtLang,
        fromLangCode: cfg.source_language_code ?? null,
        toLangCode: cfg.target_language_code ?? null,
      }));
    }
  } catch (err) {
    console.error(`Cannot read data file ${abs}: ${err.message}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Build directions from config
// ---------------------------------------------------------------------------

function buildDirections() {
  const format = cfg.data_file_format || 'csv';
  const maxTotal = cfg.max_sentences ?? null;

  // cap(arr, n) — slice to n if n is set, otherwise return all
  function cap(arr, n) { return n != null ? arr.slice(0, n) : arr; }

  if (cfg.data_files && cfg.data_file_combined === false) {
    // Per-direction cap = floor(max_sentences / numFiles)
    const perDir = maxTotal != null ? Math.floor(maxTotal / cfg.data_files.length) : null;
    if (format === 'json') {
      // NDJSON: each file is one direction — SourceL/TargetL in the data define from/to
      return cfg.data_files.map((fp) => {
        const sentences = cap(loadDataFile(fp, format), perDir);
        const first = sentences[0];
        const label = `${first.fromLang} → ${first.toLang}`;
        return { label, fromLang: first.fromLang, toLang: first.toLang,
                 fromLangCode: first.fromLangCode ?? null, toLangCode: first.toLangCode ?? null,
                 sentences };
      });
    } else {
      // CSV: no per-row direction info — file-order convention:
      //   even-indexed files = forward (srcLang → tgtLang)
      //   odd-indexed files  = reverse (tgtLang → srcLang)
      return cfg.data_files.map((fp, idx) => {
        const isForward = idx % 2 === 0;
        const fromLang     = isForward ? srcLang : tgtLang;
        const toLang       = isForward ? tgtLang : srcLang;
        const fromLangCode = isForward ? (cfg.source_language_code ?? null) : (cfg.target_language_code ?? null);
        const toLangCode   = isForward ? (cfg.target_language_code ?? null) : (cfg.source_language_code ?? null);
        const rawSentences = cap(loadDataFile(fp, format), perDir);
        // For reverse files the CSV columns are still col0=srcLang, col1=tgtLang, so swap them
        const sentences = isForward
          ? rawSentences
          : rawSentences.map((s) => ({ line: s.line, source: s.reference, reference: s.source, fromLang, toLang, fromLangCode, toLangCode }));
        return { label: `${fromLang} → ${toLang}`, fromLang, toLang, fromLangCode, toLangCode, sentences };
      });
    }
  }

  if (cfg.data_files && cfg.data_file_combined === true) {
    if (format === 'json') {
      // NDJSON: single combined file — split by SourceL/TargetL, then cap per direction
      const all = loadDataFile(cfg.data_files[0], format);
      const byDir = {};
      for (const s of all) {
        const key = `${s.fromLang}|${s.toLang}`;
        if (!byDir[key]) byDir[key] = { fromLang: s.fromLang, toLang: s.toLang, sentences: [] };
        byDir[key].sentences.push(s);
      }
      const dirs = Object.values(byDir);
      const perDir = maxTotal != null ? Math.floor(maxTotal / dirs.length) : null;
      return dirs.map((d) => ({
        label: `${d.fromLang} → ${d.toLang}`,
        fromLang: d.fromLang,
        toLang: d.toLang,
        fromLangCode: d.sentences[0]?.fromLangCode ?? null,
        toLangCode: d.sentences[0]?.toLangCode ?? null,
        sentences: cap(d.sentences, perDir),
      }));
    } else {
      // CSV: single two-column file — direction from config.
      // For bidirectional paradigms (>=4) also build the reverse direction
      // by swapping source ↔ reference on the same sentence set.
      const numDirs = paradigm >= 4 ? 2 : 1;
      const perDir = maxTotal != null ? Math.floor(maxTotal / numDirs) : null;
      const sentences = cap(loadDataFile(cfg.data_files[0], format), perDir);
      const directions = [{
        label: `${srcLang} → ${tgtLang}`,
        fromLang: srcLang,
        toLang: tgtLang,
        fromLangCode: cfg.source_language_code ?? null,
        toLangCode: cfg.target_language_code ?? null,
        sentences,
      }];
      if (paradigm >= 4) {
        directions.push({
          label: `${tgtLang} → ${srcLang}`,
          fromLang: tgtLang,
          toLang: srcLang,
          fromLangCode: cfg.target_language_code ?? null,
          toLangCode: cfg.source_language_code ?? null,
          sentences: sentences.map((s) => ({
            line: s.line,
            source: s.reference,
            reference: s.source,
            fromLang: tgtLang,
            toLang: srcLang,
            fromLangCode: cfg.target_language_code ?? null,
            toLangCode: cfg.source_language_code ?? null,
          })),
        });
      }
      return directions;
    }
  }

  // Legacy: single data_file (CSV) (CSV)
  const numDirs = paradigm >= 4 ? 2 : 1;
  const perDir = maxTotal != null ? Math.floor(maxTotal / numDirs) : null;
  const sentences = cap(loadDataFile(cfg.data_file, format), perDir);
  const directions = [{ label: `${srcLang} → ${tgtLang}`, fromLang: srcLang, toLang: tgtLang,
                         fromLangCode: cfg.source_language_code ?? null, toLangCode: cfg.target_language_code ?? null,
                         sentences }];
  if (paradigm >= 4) {
    directions.push({
      label: `${tgtLang} → ${srcLang}`,
      fromLang: tgtLang,
      toLang: srcLang,
      sentences: sentences.map((s) => ({ line: s.line, source: s.reference, reference: s.source, fromLang: tgtLang, toLang: srcLang })),
    });
  }
  return directions;
}

const directionsToRun = buildDirections();
const totalSentences = directionsToRun.reduce((n, d) => n + d.sentences.length, 0);

// ---------------------------------------------------------------------------
// Load prompt templates
// ---------------------------------------------------------------------------

function parseTemplate(template) {
  const sysMatch = template.match(/\[system\]([\s\S]*?)(?=\[user\])/i);
  const userMatch = template.match(/\[user\]([\s\S]*$)/i);
  return {
    system: sysMatch?.[1].trim() ?? '',
    user: userMatch?.[1].trim() ?? '',
  };
}

function render(str, vars) {
  return str.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
}

function loadTemplate(name) {
  const p = resolve(__dirname, 'DATA', 'PROMPTS', 'default', `${name}_template.txt`);
  try {
    return parseTemplate(readFileSync(p, 'utf8'));
  } catch {
    console.warn(`Warning: could not load ${p}, using built-in defaults.`);
    return null;
  }
}

const translateTpl = loadTemplate('translate');
const judgeTpl = loadTemplate('judge');

// Score reviewer prompt (optional — no _template suffix)
const reviewerPromptPath = resolve(__dirname, 'DATA', 'PROMPTS', 'default', 'score_reviewer_prompt.txt');
let reviewerTpl = null;
try {
  reviewerTpl = parseTemplate(readFileSync(reviewerPromptPath, 'utf8'));
} catch {
  // no reviewer prompt file — reviewer will be skipped
}

const reviewerModel = cfg.result_reviewer_model?.[0] ?? null;

console.log(`\n╔═══════════════════════════════════════╗`);
console.log(`  BabelScore — ${cfg.description || projectName}`);
console.log(`  Paradigm ${paradigm} | ${totalSentences} sentences across ${directionsToRun.length} direction(s)`);
console.log(`  ${srcLang} ↔ ${tgtLang}`);
console.log(`╚═══════════════════════════════════════╝\n`);
console.log(`Translators : ${translators.map((m) => m.id).join(', ')}`);
console.log(`Judges      : ${judges.map((j) => j.id).join(', ')}`);
if (reviewerModel) console.log(`Reviewer    : ${reviewerModel.id}`);
console.log();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveApiKey(key) {
  if (!key) return '';
  const match = key.match(/^\$\{(.+)\}$/);
  return match ? (process.env[match[1]] || '') : key;
}

// ---------------------------------------------------------------------------
// LM Studio model lifecycle
// ---------------------------------------------------------------------------

async function lmStudioLoad(baseUrl, modelId) {
  process.stdout.write(`  → loading  [${modelId}] in LM Studio ... `);
  try {
    const res = await fetch(`${baseUrl.replace('/v1', '')}/api/v1/models/load`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelId, context_length: 1024 }),
    });
    const data = await res.json();
    if (data.status === 'loaded') {
      console.log(`loaded (${data.load_time_seconds?.toFixed(1)}s)`);
    } else {
      console.log(`unexpected response: ${JSON.stringify(data)}`);
    }
  } catch (err) {
    console.log(`failed: ${err.message}`);
  }
}

async function lmStudioUnload(baseUrl, modelId) {
  process.stdout.write(`  → unloading [${modelId}] from LM Studio ... `);
  try {
    const res = await fetch(`${baseUrl.replace('/v1', '')}/api/v1/models/unload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instance_id: modelId }),
    });
    const data = await res.json();
    console.log(data.instance_id ? 'unloaded' : JSON.stringify(data));
  } catch (err) {
    console.log(`failed: ${err.message}`);
  }
}

async function callLLM(model, messages, maxTokens = 512, responseFormat = null) {
  const apiKey = resolveApiKey(model.api_key);
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const payload = {
    model: model.model,
    messages,
    temperature: model.temperature ?? 0.1,
    max_tokens: model.max_tokens ?? maxTokens,
  };
  if (responseFormat) payload.response_format = responseFormat;
  if (model.structured_outputs) payload.structured_outputs = true;
  if (model.verbosity) payload.verbosity = model.verbosity;

  const body = JSON.stringify(payload);

  try {
    const res = await fetch(`${model.base_url}/chat/completions`, {
      method: 'POST',
      headers,
      body,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = await res.json();
    // Strip leaked EOS/control tokens some local models emit
    const raw = data.choices[0].message.content;
    if (raw == null) {
      console.error(`    ✗ [${model.id}] null content — reasoning model may need higher max_tokens`);
      return null;
    }
    const cleaned = raw.replace(/<\|im_end\|>[\s\S]*/g, '')
                       .replace(/<\|end_of_text\|>[\s\S]*/g, '')
                       .replace(/<\|eot_id\|>[\s\S]*/g, '')
                       .trim();
    return cleaned;
  } catch (err) {
    console.error(`    ✗ [${model.id}] ${err.message}`);
    return null;
  }
}

async function translateText(model, text, fromLang, toLang) {
  // Standard OpenAI-compatible chat/completions
  const vars = { from_lang: fromLang, to_lang: toLang, text };
  const messages = translateTpl
    ? [
        { role: 'system', content: render(translateTpl.system, vars) },
        { role: 'user',   content: render(translateTpl.user, vars) },
      ]
    : [
        { role: 'system', content: 'You are a professional translator. Translate accurately and naturally.' },
        { role: 'user',   content: `Translate the following ${fromLang} text to ${toLang}. Respond with only the translation, nothing else.\n\n${text}` },
      ];
  return callLLM(model, messages);
}

async function judgeTranslation(judgeModel, fromLang, toLang, source, translation, reference) {
  const vars = {
    from_lang: fromLang,
    to_lang: toLang,
    source,
    translation,
    reference_line: reference ? `Reference translation: ${reference}` : '',
  };
  const messages = judgeTpl
    ? [
        { role: 'system', content: render(judgeTpl.system, vars) },
        { role: 'user',   content: render(judgeTpl.user, vars) },
      ]
    : [
        { role: 'system', content: 'You are an expert translation quality evaluator. Respond only with valid JSON.' },
        { role: 'user',   content:
            `Evaluate this translation from ${fromLang} to ${toLang}.\n\n` +
            `Source (${fromLang}): ${source}\n` +
            `Translation: ${translation}${reference ? `\nReference translation: ${reference}` : ''}\n\n` +
            `Score the translation on accuracy and fluency from 0 to 100.\n` +
            `Respond with only valid JSON: {"score": <number 0-100>, "reasoning": "<one sentence>"}`,
        },
      ];

  // response_format: prefer model-level override, else json_object (forces valid JSON output).
  // Set response_format: null in judge model config to disable (e.g. for models that don't support it).
  const responseFormat = 'response_format' in judgeModel
    ? judgeModel.response_format
    : { type: 'json_object' };

  const raw = await callLLM(judgeModel, messages, 1024, responseFormat);
  if (!raw) return null;

  // Strip <think>...</think> blocks that some reasoning models emit
  const stripped = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

  // Attempt 1: direct parse after stripping markdown fences
  const fenceStripped = stripped
    .replace(/^```(?:json)?\s*/im, '')
    .replace(/```\s*$/m, '')
    .trim();
  try {
    const parsed = JSON.parse(fenceStripped);
    if (typeof parsed.score === 'number') return parsed;
  } catch { /* fall through */ }

  // Attempt 2: extract first {...} JSON object from anywhere in the response
  const match = stripped.match(/\{[\s\S]*?\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      if (typeof parsed.score === 'number') return parsed;
    } catch { /* fall through */ }
  }

  // Attempt 3: broader match for nested/multiline JSON object
  const deepMatch = stripped.match(/\{[\s\S]*\}/);
  if (deepMatch) {
    try {
      const parsed = JSON.parse(deepMatch[0]);
      if (typeof parsed.score === 'number') return parsed;
    } catch { /* fall through */ }
  }

  // Attempt 4: repair truncated JSON — model ran out of tokens mid-string.
  // Find the last complete {...} fragment that has a score field and force-close it.
  const truncMatch = stripped.match(/\{[\s\S]*/);
  if (truncMatch) {
    // Close any open string then close the object
    let fragment = truncMatch[0].replace(/,?\s*$/, '');
    // If string is unterminated, close it
    const quoteCount = (fragment.match(/(?<!\\)"/g) || []).length;
    if (quoteCount % 2 !== 0) fragment += '"';
    fragment += '}';
    try {
      const parsed = JSON.parse(fragment);
      if (typeof parsed.score === 'number') {
        // Mark reasoning as truncated so caller knows
        if (typeof parsed.reasoning === 'string') parsed.reasoning += ' [truncated]';
        return parsed;
      }
    } catch { /* fall through */ }
  }

  // Attempt 5: regex extraction of score as last resort
  const scoreMatch = stripped.match(/"score"\s*:\s*(\d+(?:\.\d+)?)/);
  if (scoreMatch) {
    const reasoningMatch = stripped.match(/"reasoning"\s*:\s*"([\s\S]*?)(?:"|$)/);
    return {
      score: parseFloat(scoreMatch[1]),
      reasoning: reasoningMatch ? reasoningMatch[1].trim() + ' [truncated]' : '[truncated]',
    };
  }

  logJudgeError(judgeModel, messages, raw);
  return null;
}

// ---------------------------------------------------------------------------
// Run one evaluation direction
// ---------------------------------------------------------------------------

// Runs `tasks` (array of async thunks) with at most `concurrency` in flight.
// Returns results in the original order.
async function pooled(tasks, concurrency) {
  const results = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, worker);
  await Promise.all(workers);
  return results;
}

async function runDirection(fromLang, toLang, sentences, onProgress = null, dir = {}) {
  const hasReference = paradigm >= 3;
  const translatorThreads = cfg.translator_threads ?? 1;
  const judgeThreads = cfg.judge_threads ?? 1;

  // Pre-allocate results array so order is preserved regardless of completion order
  const results = new Array(sentences.length).fill(null);

  const tasks = sentences.map((sentence, i) => async () => {
    const progress = `[${i + 1}/${sentences.length}]`;
    const sentenceResult = {
      line: sentence.line ?? i + 1,
      source: sentence.source,
      reference: sentence.reference,
      translations: {},
    };

    // Translate with each model (sequential per sentence — parallelism is across sentences)
    for (const model of translators) {
      const translation = await translateText(model, sentence.source, fromLang, toLang);

      if (!translation) {
        sentenceResult.translations[model.id] = { text: null, scores: {} };
        console.log(`${progress} "${sentence.source.slice(0, 55)}${sentence.source.length > 55 ? '…' : ''}"\n  → translate [${model.id}] failed`);
        continue;
      }

      // Judge translations in parallel (up to judgeThreads)
      const ref = hasReference ? sentence.reference : null;
      const judgeScores = {};
      const judgeTasks = judges.map((jm) => async () => {
        const result = await judgeTranslation(jm, fromLang, toLang, sentence.source, translation, ref);
        judgeScores[jm.id] = result ?? null;
        return result;
      });
      await pooled(judgeTasks, judgeThreads);

      // Collate judge scores
      const scores = {};
      for (const jm of judges) {
        const result = judgeScores[jm.id];
        if (result) scores[jm.id] = result;
      }

      sentenceResult.translations[model.id] = { text: translation, scores };

      // Print sentence summary (translation + all judge scores) as a single block
      const judgeLines = judges
        .map((jm) => scores[jm.id] ? `  → judge   [${jm.id}] ${scores[jm.id].score}/100` : `  → judge   [${jm.id}] failed`)
        .join('\n');
      console.log(
        `${progress} "${sentence.source.slice(0, 55)}${sentence.source.length > 55 ? '…' : ''}"\n` +
        `  → translate [${model.id}] "${translation.slice(0, 60)}${translation.length > 60 ? '…' : ''}"\n` +
        judgeLines
      );
    }

    results[i] = sentenceResult;
    // onProgress receives the ordered results so far (nulls for in-flight sentences filtered out)
    onProgress?.(results.filter(Boolean));
    return sentenceResult;
  });

  await pooled(tasks, translatorThreads);

  // Final ordered results (drop any nulls from unexpected failures)
  return results.filter(Boolean);
}

// ---------------------------------------------------------------------------
// Aggregate per-model stats across all sentences
// ---------------------------------------------------------------------------

function aggregateStats(directionResults) {
  return translators.map((model) => {
    const perJudge = {};

    for (const jm of judges) {
      const scores = directionResults
        .map((s) => s.translations[model.id]?.scores[jm.id]?.score)
        .filter((s) => typeof s === 'number');

      perJudge[jm.id] = scores.length
        ? { mean: +(scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(2), count: scores.length }
        : { mean: null, count: 0 };
    }

    const validMeans = Object.values(perJudge).map((j) => j.mean).filter((m) => m !== null);
    const overallMean = validMeans.length
      ? +(validMeans.reduce((a, b) => a + b, 0) / validMeans.length).toFixed(2)
      : null;
    const variance = validMeans.length > 1
      ? +(Math.max(...validMeans) - Math.min(...validMeans)).toFixed(2)
      : 0;

    return { modelId: model.id, perJudge, overallMean, variance };
  });
}

// Minimal scorecard for reviewer — scores per sentence, no judge reasoning
function buildReviewerInput(directions) {
  let out = `Project: ${projectName} | ${srcLang} ↔ ${tgtLang} | Paradigm ${paradigm}\n\n`;
  for (const { label, stats, sentences, metrics } of directions) {
    out += `## ${label}\n`;
    // Corpus-level scores
    for (const stat of stats) {
      out += `${stat.modelId}: LLM-judge ${stat.overallMean ?? '—'}/100`;
      if (metrics?.[stat.modelId]?.corpus) {
        const c = metrics[stat.modelId].corpus;
        out += ` | chrF++ ${c.chrf} | BLEU ${c.bleu} | TER ${c.ter}`;
      }
      out += '\n';
    }
    // Per-sentence scores (no source text, no reasoning)
    out += '\n| # |' + translators.map((m) => ` ${m.id} judge | chrF++ | BLEU | TER`).join(' |') + ' |\n';
    out += '|---|' + translators.map(() => '---|---|---|---').join('|') + '|\n';
    for (const [i, sentence] of sentences.entries()) {
      let row = `| ${i + 1} |`;
      for (const model of translators) {
        const t = sentence.translations[model.id];
        const judgeScores = judges.map((jm) => t?.scores?.[jm.id]?.score ?? '—').join('/');
        const m = t?.metrics;
        row += ` ${judgeScores} | ${m?.chrf ?? '—'} | ${m?.bleu ?? '—'} | ${m?.ter ?? '—'} |`;
      }
      out += row + '\n';
    }
    out += '\n';
  }
  return out;
}

// ---------------------------------------------------------------------------
// LLM score reviewer
// ---------------------------------------------------------------------------

async function runReviewer(directionResults) {
  if (!reviewerModel || !reviewerTpl) return null;

  const reviewerInput = buildReviewerInput(directionResults);
  const vars = {
    project: projectName,
    src_lang: srcLang,
    tgt_lang: tgtLang,
    paradigm: String(paradigm),
    scorecard: reviewerInput,
  };
  const messages = [
    { role: 'system', content: render(reviewerTpl.system, vars) },
    { role: 'user',   content: render(reviewerTpl.user,   vars) },
  ];

  process.stdout.write(`\nRunning score reviewer [${reviewerModel.id}] ... `);
  const review = await callLLM(reviewerModel, messages, reviewerModel.max_tokens ?? 2048);
  if (review) {
    console.log('done');
  } else {
    console.log('failed');
  }
  return review;
}

// ---------------------------------------------------------------------------
// Python sidecar — chrF++ / BLEU / TER
// ---------------------------------------------------------------------------

function runMetricsSidecar(directionResults) {
  const pythonBin = resolve(__dirname, 'python_sidecar', '.venv', 'bin', 'python');
  const script    = resolve(__dirname, 'python_sidecar', 'main.py');

  const payload = {
    directions: directionResults.map(({ label, sentences }) => ({
      label,
      models: Object.fromEntries(
        translators.map((model) => [
          model.id,
          {
            hypotheses: sentences.map((s) => s.translations[model.id]?.text ?? ''),
            references: sentences.map((s) => s.reference ?? ''),
          },
        ])
      ),
    })),
  };

  process.stdout.write('\nRunning reference metrics (chrF++ / BLEU / TER) ... ');
  const result = spawnSync(pythonBin, [script], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 60_000,
  });

  if (result.error || result.status !== 0) {
    console.log('failed');
    if (result.error) console.error(`  sidecar error: ${result.error.message}`);
    if (result.stderr) console.error(`  sidecar stderr: ${result.stderr.slice(0, 400)}`);
    return null;
  }

  try {
    const parsed = JSON.parse(result.stdout);
    if (parsed.error) {
      console.log(`failed — ${parsed.error}`);
      return null;
    }
    console.log('done');
    return parsed;
  } catch {
    console.log('failed (JSON parse error)');
    console.error(`  raw output: ${result.stdout.slice(0, 400)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Build markdown scorecard
// ---------------------------------------------------------------------------

function buildScorecard(directions, review = null) {
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const sep = '---\n\n';

  let md = `# BabelScore — ${srcLang} ↔ ${tgtLang}\n\n`;
  md += `| | |\n|---|---|\n`;
  md += `| **Project** | ${projectName} |\n`;
  md += `| **Description** | ${cfg.description || '—'} |\n`;
  md += `| **Paradigm** | ${paradigm} |\n`;
  md += `| **Sentences** | ${totalSentences} |\n`;
  md += `| **Translators** | ${translators.map((m) => m.model).join(', ')} |\n`;
  md += `| **Judges** | ${judges.map((j) => j.model).join(', ')} |\n`;
  md += `| **Run** | ${now} |\n\n${sep}`;

  // Summary scores: mean of all model means per direction
  md += `## Summary\n\n`;
  md += `| Translation | Score |\n`;
  md += `|---|---|\n`;
  for (const { label, stats } of directions) {
    const validMeans = stats.map((s) => s.overallMean).filter((m) => m !== null);
    const dirScore = validMeans.length
      ? (validMeans.reduce((a, b) => a + b, 0) / validMeans.length).toFixed(1)
      : '—';
    md += `| ${label} | **${dirScore}** |\n`;
  }
  md += `\n${sep}`;

  // Pass 1: direction summaries (judge tables + reference metrics)
  for (const { label, stats, metrics } of directions) {
    md += `## ${label}\n\n`;

    // LLM judge scores table
    const judgeHeaders = judges.map((j) => `**${j.id}**`).join(' | ');
    md += `| Model | ${judgeHeaders} | Mean | Variance |\n`;
    md += `|-------|${judges.map(() => '---').join('|')}|------|----------|\n`;

    for (const stat of stats) {
      const judgeCols = judges.map((j) => stat.perJudge[j.id]?.mean ?? '—').join(' | ');
      const varianceDisplay = stat.variance > varianceThreshold ? `⚠ ${stat.variance}` : String(stat.variance);
      md += `| \`${stat.modelId}\` | ${judgeCols} | **${stat.overallMean ?? '—'}** | ${varianceDisplay} |\n`;
    }

    // Reference metrics table (chrF++ / BLEU / TER)
    if (metrics) {
      md += `\n### Reference Metrics\n\n`;
      md += `| Model | chrF++ ↑ | BLEU ↑ | TER ↓ |\n`;
      md += `|-------|----------|--------|-------|\n`;
      for (const model of translators) {
        const m = metrics[model.id];
        if (m?.corpus) {
          md += `| \`${model.id}\` | ${m.corpus.chrf} | ${m.corpus.bleu} | ${m.corpus.ter} |\n`;
        }
      }
    }

    md += '\n';
  }

  // Review: after all reference metrics, before sentence details
  if (review && reviewerModel) {
    md += `${sep}## Review\n\n*Reviewer: ${reviewerModel.id}*\n\n${review}\n\n`;
  }

  // Pass 2: sentence details (all directions)
  if (outputCfg.show_judge_reasoning) {
    md += sep;
    for (const { label, sentences } of directions) {
      md += `## ${label} — Sentence Detail\n\n`;
      for (const [i, sentence] of sentences.entries()) {
        md += `**[${i + 1}]** *${sentence.source}*\n`;
        if (sentence.reference) md += `> Reference: *${sentence.reference}*\n`;
        md += '\n';

        for (const model of translators) {
          const t = sentence.translations[model.id];
          if (!t?.text) {
            md += `- **\`${model.id}\`**: *(translation failed)*\n`;
            continue;
          }
          md += `- **\`${model.id}\`**: ${t.text}\n`;
          if (t.metrics) {
            md += `  - *chrF++: ${t.metrics.chrf ?? '—'} | BLEU: ${t.metrics.bleu ?? '—'} | TER: ${t.metrics.ter ?? '—'}*\n`;
          }
          for (const jm of judges) {
            const s = t.scores[jm.id];
            if (!s) {
              md += `  - \`${jm.id}\`: *(judge failed)*\n`;
            } else {
              md += `  - \`${jm.id}\`: **${s.score}/100** — ${s.reasoning}\n`;
            }
          }
        }
        md += '\n';
      }
      md += sep;
    }
  }

  return md;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// LM Studio: load all lm_studio models before evaluation
// ---------------------------------------------------------------------------

const lmStudioAutoLoad   = [...translators, ...judges].filter((m) => m.provider === 'lm_studio' && m.auto_load   === true);
const lmStudioAutoUnload = [...translators, ...judges].filter((m) => m.provider === 'lm_studio' && m.auto_unload === true);

async function unloadAllLmStudio() {
  if (lmStudioAutoUnload.length > 0) {
    console.log('\nUnloading LM Studio models...');
    for (const m of lmStudioAutoUnload) {
      await lmStudioUnload(m.base_url, m.model);
    }
  }
}

// ---------------------------------------------------------------------------
// Incremental results state
// ---------------------------------------------------------------------------

let runState = null;
let jsonPath = null;
let judgeErrorLogPath = null;

function logJudgeError(judgeModel, messages, raw) {
  const entry = {
    ts: new Date().toISOString(),
    judge: judgeModel.id,
    model: judgeModel.model,
    request: messages,
    response: raw,
  };
  const line = JSON.stringify(entry) + '\n';
  // Always print a brief notice to stderr
  console.error(`    ✗ Judge parse error [${judgeModel.id}]: ${raw.slice(0, 200)}`);
  // Append full request+response to the error log if path is set
  if (judgeErrorLogPath) {
    try {
      writeFileSync(judgeErrorLogPath, line, { flag: 'a' });
    } catch { /* non-fatal */ }
  }
}

function saveProgress() {
  if (jsonPath && runState) {
    writeFileSync(jsonPath, JSON.stringify(runState, null, 2));
  }
}

// Unload on Ctrl+C and save partial progress
process.on('SIGINT', async () => {
  if (runState) runState.status = 'interrupted';
  saveProgress();
  await unloadAllLmStudio();
  process.exit(130);
});

if (lmStudioAutoLoad.length > 0) {
  console.log('Loading LM Studio models...');
  for (const m of lmStudioAutoLoad) {
    await lmStudioLoad(m.base_url, m.model);
  }
  console.log();
}

// Set up incremental JSON output before run starts
const resultsDir = resolve(projectDir, outputCfg.results_dir ?? 'results');
mkdirSync(resultsDir, { recursive: true });
const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
jsonPath = resolve(resultsDir, `scorecard_${timestamp}.json`);
judgeErrorLogPath = resolve(resultsDir, `judge_errors_${timestamp}.jsonl`);
const mdPath = resolve(resultsDir, `scorecard_${timestamp}.md`);

runState = {
  project: projectName,
  paradigm,
  srcLang,
  tgtLang,
  directions_count: directionsToRun.length,
  total_sentences: totalSentences,
  started_at: new Date().toISOString(),
  status: 'in_progress',
  directions: [],
};
saveProgress();

const directionResults = [];

try {
  for (const dir of directionsToRun) {
    console.log(`━━━ ${dir.label} (${dir.sentences.length} sentences) ${'━'.repeat(Math.max(0, 28 - dir.label.length))}\n`);

    const dirEntry = { label: dir.label, sentences: [], stats: null };
    runState.directions.push(dirEntry);

    const sentenceResults = await runDirection(dir.fromLang, dir.toLang, dir.sentences, (accumulated) => {
      dirEntry.sentences = accumulated;
      saveProgress();
    }, dir);

    const stats = aggregateStats(sentenceResults);
    dirEntry.stats = stats;
    directionResults.push({ label: dir.label, sentences: sentenceResults, stats });
  }

  runState.status = 'complete';
  saveProgress();

  // -------------------------------------------------------------------------
  // Python sidecar: chrF++ / BLEU / TER
  // -------------------------------------------------------------------------

  const sidecarResult = runMetricsSidecar(directionResults);

  if (sidecarResult) {
    for (const sidecarDir of sidecarResult.directions) {
      const dir = directionResults.find((d) => d.label === sidecarDir.label);
      if (!dir) continue;
      dir.metrics = sidecarDir.models;
      // Merge per-sentence metrics into sentence objects
      for (const [modelId, modelMetrics] of Object.entries(sidecarDir.models)) {
        if (!modelMetrics.sentences) continue;
        for (const [i, sentMetrics] of modelMetrics.sentences.entries()) {
          const sent = dir.sentences[i];
          if (!sent) continue;
          if (!sent.translations[modelId]) continue;
          sent.translations[modelId].metrics = sentMetrics;
        }
      }
    }
    // Persist metrics into runState
    for (const dir of directionResults) {
      const stateDir = runState.directions.find((d) => d.label === dir.label);
      if (stateDir) {
        stateDir.metrics = dir.metrics ?? null;
        stateDir.sentences = dir.sentences;
      }
    }
    saveProgress();
  }

  // -------------------------------------------------------------------------
  // LLM score reviewer (runs before buildScorecard so it can be embedded inline)
  // -------------------------------------------------------------------------

  const review = await runReviewer(directionResults);
  if (review) {
    runState.review = { model: reviewerModel.id, text: review };
    saveProgress();
  }

  const scorecardMd = buildScorecard(directionResults, review);
  writeFileSync(mdPath, scorecardMd);

  // -------------------------------------------------------------------------
  // Console summary
  // -------------------------------------------------------------------------

  console.log(`\n${'═'.repeat(44)}`);
  console.log(`  Results`);
  console.log(`${'═'.repeat(44)}`);

  for (const { label, stats, metrics } of directionResults) {
    console.log(`\n${label}`);
    for (const stat of stats) {
      const flag = stat.variance > varianceThreshold ? '  ⚠ HIGH VARIANCE' : '';
      console.log(`  ${stat.modelId}: ${stat.overallMean ?? '—'}/100 LLM-judge  (variance: ${stat.variance})${flag}`);
      if (metrics?.[stat.modelId]?.corpus) {
        const c = metrics[stat.modelId].corpus;
        console.log(`    chrF++: ${c.chrf}   BLEU: ${c.bleu}   TER: ${c.ter}`);
      }
    }
  }

  console.log(`\n✓ ${mdPath}`);
  console.log(`✓ ${jsonPath}\n`);

} finally {
  await unloadAllLmStudio();
}
