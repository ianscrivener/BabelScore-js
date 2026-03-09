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
// Load CSV
// ---------------------------------------------------------------------------

const csvPath = resolve(projectDir, cfg.data_file);
let rows;
try {
  rows = parseCsv(readFileSync(csvPath, 'utf8'), {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });
} catch (err) {
  console.error(`Cannot read CSV: ${csvPath}\n${err.message}`);
  process.exit(1);
}

// Take the first two columns regardless of their names
const [srcCol, tgtCol] = Object.keys(rows[0]);

console.log(`\n╔═══════════════════════════════════════╗`);
console.log(`  BabelScore — ${cfg.description || projectName}`);
console.log(`  Paradigm ${paradigm} | ${rows.length} sentences`);
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
    temperature: 0.1,
    max_tokens: maxTokens,
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
  const messages = [
    {
      role: 'system',
      content: 'You are a professional translator. Translate accurately and naturally.',
    },
    {
      role: 'user',
      content: `Translate the following ${fromLang} text to ${toLang}. Respond with only the translation, nothing else.\n\n${text}`,
    },
  ];
  return callLLM(model, messages, 1024);
}

async function judgeTranslation(judgeModel, fromLang, toLang, source, translation, reference) {
  const refLine = reference ? `\nReference translation: ${reference}` : '';
  const messages = [
    {
      role: 'system',
      content: 'You are an expert translation quality evaluator. Respond only with valid JSON.',
    },
    {
      role: 'user',
      content:
        `Evaluate this translation from ${fromLang} to ${toLang}.\n\n` +
        `Source (${fromLang}): ${source}\n` +
        `Translation: ${translation}${refLine}\n\n` +
        `Score the translation on accuracy and fluency from 0 to 10.\n` +
        `Respond with only valid JSON: {"score": <number 0-10>, "reasoning": "<one sentence>"}`,
    },
  ];

  const raw = await callLLM(judgeModel, messages, 256);
  if (!raw) return null;

  try {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    const parsed = JSON.parse(cleaned);
    if (typeof parsed.score !== 'number') throw new Error('Missing score field');
    return parsed;
  } catch {
    console.error(`    ✗ Judge parse error [${judgeModel.id}]: ${raw.slice(0, 120)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Run one evaluation direction
// ---------------------------------------------------------------------------

async function runDirection(fromLang, toLang, sentences) {
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
          console.log(`${result.score}/10`);
        } else {
          console.log('failed');
        }
      }

      sentenceResult.translations[model.id] = { text: translation, scores };
    }

    results.push(sentenceResult);
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
  md += `| **Sentences** | ${rows.length} |\n`;
  md += `| **Translators** | ${translators.map((m) => m.model).join(', ')} |\n`;
  md += `| **Judges** | ${judges.map((j) => j.model).join(', ')} |\n`;
  md += `| **Run** | ${now} |\n\n${sep}`;

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
              md += `  - \`${jm.id}\`: **${s.score}/10** — ${s.reasoning}\n`;
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

const lmStudioModels = [...translators, ...judges].filter(
  (m) => m.provider === 'lm_studio'
);

async function unloadAllLmStudio() {
  if (lmStudioModels.length > 0) {
    console.log('\nUnloading LM Studio models...');
    for (const m of lmStudioModels) {
      await lmStudioUnload(m.base_url, m.model);
    }
  }
}

// Unload on Ctrl+C
process.on('SIGINT', async () => {
  await unloadAllLmStudio();
  process.exit(130);
});

if (lmStudioModels.length > 0) {
  console.log('Loading LM Studio models...');
  for (const m of lmStudioModels) {
    await lmStudioLoad(m.base_url, m.model);
  }
  console.log();
}

const directionsToRun = [
  { label: `${srcLang} → ${tgtLang}`, fromLang: srcLang, toLang: tgtLang, sentenceKey: [srcCol, tgtCol] },
];

if (paradigm >= 4) {
  directionsToRun.push({
    label: `${tgtLang} → ${srcLang}`,
    fromLang: tgtLang,
    toLang: srcLang,
    sentenceKey: [tgtCol, srcCol],
  });
}

const directionResults = [];

try {
  for (const dir of directionsToRun) {
    console.log(`━━━ ${dir.label} ${'━'.repeat(Math.max(0, 38 - dir.label.length))}\n`);

    const sentences = rows.map((r) => ({
      source: r[dir.sentenceKey[0]],
      reference: r[dir.sentenceKey[1]],
    }));

    const sentenceResults = await runDirection(dir.fromLang, dir.toLang, sentences);
    const stats = aggregateStats(sentenceResults);
    directionResults.push({ label: dir.label, sentences: sentenceResults, stats });
  }

  // -------------------------------------------------------------------------
  // Save results
  // -------------------------------------------------------------------------

  const resultsDir = resolve(projectDir, outputCfg.results_dir ?? 'results');
  mkdirSync(resultsDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  const jsonPath = resolve(resultsDir, `scorecard_${timestamp}.json`);
  writeFileSync(
    jsonPath,
    JSON.stringify({ project: projectName, paradigm, srcLang, tgtLang, directionResults }, null, 2)
  );

  const mdPath = resolve(resultsDir, `scorecard_${timestamp}.md`);
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
      console.log(`  ${stat.modelId}: ${stat.overallMean ?? '—'}/10  (variance: ${stat.variance})${flag}`);
    }
  }

  console.log(`\n✓ ${mdPath}`);
  console.log(`✓ ${jsonPath}\n`);

} finally {
  await unloadAllLmStudio();
}
