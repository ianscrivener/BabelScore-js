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
  return parseCsv(readFileSync(filePath, 'utf8'), {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });
}

function loadDataFile(filePath, format) {
  const abs = resolve(projectDir, filePath);
  try {
    if (format === 'json') {
      const rows = loadNDJSON(abs);
      return rows.map((r) => ({
        source: r.SourceText,
        reference: r.TargetText,
        fromLang: langName(r.SourceL),
        toLang: langName(r.TargetL),
      }));
    } else {
      // csv / txt — legacy two-column format
      const rows = loadCSV(abs);
      const [srcCol, tgtCol] = Object.keys(rows[0]);
      return rows.map((r) => ({
        source: r[srcCol],
        reference: r[tgtCol],
        fromLang: srcLang,
        toLang: tgtLang,
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
    // Each file is one direction — SourceL/TargetL in the data define from/to
    // Per-direction cap = floor(max_sentences / numFiles)
    const perDir = maxTotal != null ? Math.floor(maxTotal / cfg.data_files.length) : null;
    return cfg.data_files.map((fp) => {
      const sentences = cap(loadDataFile(fp, format), perDir);
      const first = sentences[0];
      const label = `${first.fromLang} → ${first.toLang}`;
      return { label, fromLang: first.fromLang, toLang: first.toLang, sentences };
    });
  }

  if (cfg.data_files && cfg.data_file_combined === true) {
    // Single combined file — split by SourceL/TargetL, then cap per direction
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
      sentences: cap(d.sentences, perDir),
    }));
  }

  // Legacy: single data_file (CSV)
  const numDirs = paradigm >= 4 ? 2 : 1;
  const perDir = maxTotal != null ? Math.floor(maxTotal / numDirs) : null;
  const sentences = cap(loadDataFile(cfg.data_file, format), perDir);
  const directions = [{ label: `${srcLang} → ${tgtLang}`, fromLang: srcLang, toLang: tgtLang, sentences }];
  if (paradigm >= 4) {
    directions.push({
      label: `${tgtLang} → ${srcLang}`,
      fromLang: tgtLang,
      toLang: srcLang,
      sentences: sentences.map((s) => ({ source: s.reference, reference: s.source, fromLang: tgtLang, toLang: srcLang })),
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

console.log(`\n╔═══════════════════════════════════════╗`);
console.log(`  BabelScore — ${cfg.description || projectName}`);
console.log(`  Paradigm ${paradigm} | ${totalSentences} sentences across ${directionsToRun.length} direction(s)`);
console.log(`  ${srcLang} ↔ ${tgtLang}`);
console.log(`╚═══════════════════════════════════════╝\n`);
console.log(`Translators : ${translators.map((m) => m.id).join(', ')}`);
console.log(`Judges      : ${judges.map((j) => j.id).join(', ')}\n`);

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

async function callLLM(model, messages, maxTokens = 512) {
  const apiKey = resolveApiKey(model.api_key);
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const body = JSON.stringify({
    model: model.model,
    messages,
    temperature: model.temperature ?? 0.1,
    max_tokens: model.max_tokens ?? maxTokens,
  });

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

  const raw = await callLLM(judgeModel, messages, 512);
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

  console.error(`    ✗ Judge parse error [${judgeModel.id}]: ${raw.slice(0, 300)}`);
  return null;
}

// ---------------------------------------------------------------------------
// Run one evaluation direction
// ---------------------------------------------------------------------------

async function runDirection(fromLang, toLang, sentences, onProgress = null) {
  const hasReference = paradigm >= 3;
  const results = [];

  for (const [i, sentence] of sentences.entries()) {
    const progress = `[${i + 1}/${sentences.length}]`;
    console.log(`${progress} "${sentence.source.slice(0, 55)}${sentence.source.length > 55 ? '…' : ''}"`);

    const sentenceResult = {
      source: sentence.source,
      reference: sentence.reference,
      translations: {},
    };

    for (const model of translators) {
      process.stdout.write(`  → translate [${model.id}] ... `);
      const translation = await translateText(model, sentence.source, fromLang, toLang);

      if (!translation) {
        console.log('failed');
        sentenceResult.translations[model.id] = { text: null, scores: {} };
        continue;
      }
      console.log(`"${translation.slice(0, 50)}${translation.length > 50 ? '…' : ''}"`);

      const scores = {};
      for (const jm of judges) {
        process.stdout.write(`  → judge   [${jm.id}] ... `);
        const ref = hasReference ? sentence.reference : null;
        const result = await judgeTranslation(jm, fromLang, toLang, sentence.source, translation, ref);
        if (result) {
          scores[jm.id] = result;
          console.log(`${result.score}/100`);
        } else {
          console.log('failed');
        }
      }

      sentenceResult.translations[model.id] = { text: translation, scores };
    }

    results.push(sentenceResult);
    onProgress?.(results);
    console.log();
  }

  return results;
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

// ---------------------------------------------------------------------------
// Build markdown scorecard
// ---------------------------------------------------------------------------

function buildScorecard(directions) {
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

  for (const { label, stats, sentences } of directions) {
    md += `## ${label}\n\n`;

    // Summary table
    const judgeHeaders = judges.map((j) => `**${j.id}**`).join(' | ');
    md += `| Model | ${judgeHeaders} | Mean | Variance |\n`;
    md += `|-------|${judges.map(() => '---').join('|')}|------|----------|\n`;

    for (const stat of stats) {
      const judgeCols = judges.map((j) => stat.perJudge[j.id]?.mean ?? '—').join(' | ');
      const varianceDisplay = stat.variance > varianceThreshold ? `⚠ ${stat.variance}` : String(stat.variance);
      md += `| \`${stat.modelId}\` | ${judgeCols} | **${stat.overallMean ?? '—'}** | ${varianceDisplay} |\n`;
    }

    md += '\n';

    if (outputCfg.show_judge_reasoning) {
      md += `### Sentence Detail\n\n`;
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
    }

    md += sep;
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
    });

    const stats = aggregateStats(sentenceResults);
    dirEntry.stats = stats;
    directionResults.push({ label: dir.label, sentences: sentenceResults, stats });
  }

  runState.status = 'complete';
  saveProgress();

  writeFileSync(mdPath, buildScorecard(directionResults));

  // -------------------------------------------------------------------------
  // Console summary
  // -------------------------------------------------------------------------

  console.log(`\n${'═'.repeat(44)}`);
  console.log(`  Results`);
  console.log(`${'═'.repeat(44)}`);

  for (const { label, stats } of directionResults) {
    console.log(`\n${label}`);
    for (const stat of stats) {
      const flag = stat.variance > varianceThreshold ? '  ⚠ HIGH VARIANCE' : '';
      console.log(`  ${stat.modelId}: ${stat.overallMean ?? '—'}/100  (variance: ${stat.variance})${flag}`);
    }
  }

  console.log(`\n✓ ${mdPath}`);
  console.log(`✓ ${jsonPath}\n`);

} finally {
  await unloadAllLmStudio();
}
