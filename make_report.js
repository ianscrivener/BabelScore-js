#!/usr/bin/env node
// make_report.js — aggregate all scorecard JSON files into a Markdown report
// Usage: node make_report.js [--projects-dir <path>] [--output <file>]

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };
const projectsDir = path.resolve(getArg('--projects-dir') ?? path.join(__dirname, '_PROJECTS'));
const outputFile  = getArg('--output') ?? null;  // null = stdout

// ── Collect all scorecard JSON files ─────────────────────────────────────────
function findScorecards(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...findScorecards(full));
    else if (entry.isFile() && entry.name.startsWith('scorecard_') && entry.name.endsWith('.json'))
      results.push(full);
  }
  return results;
}

const files = findScorecards(projectsDir).sort();
if (files.length === 0) {
  console.error(`No scorecard JSON files found under ${projectsDir}`);
  process.exit(1);
}

// ── Aggregate ─────────────────────────────────────────────────────────────────
// Key: `${project}||${translatorId}||${direction}`
// Value: { project, translatorId, direction, scores: number[], judgeScores: {judgeId: number[]} }
const rows = new Map();

for (const file of files) {
  let sc;
  try { sc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }

  const project = sc.project ?? path.basename(path.dirname(path.dirname(file)));
  if (!sc.directions) continue;

  for (const dir of sc.directions) {
    const direction = dir.label ?? 'unknown';
    if (!dir.sentences) continue;

    for (const sentence of dir.sentences) {
      if (!sentence.translations) continue;

      for (const [translatorId, tData] of Object.entries(sentence.translations)) {
        if (!tData?.scores) continue;

        const key = `${project}||${translatorId}||${direction}`;
        if (!rows.has(key)) {
          rows.set(key, { project, translatorId, direction, scores: [], judgeScores: {} });
        }
        const row = rows.get(key);

        for (const [judgeId, jData] of Object.entries(tData.scores)) {
          if (typeof jData?.score !== 'number') continue;
          row.scores.push(jData.score);
          (row.judgeScores[judgeId] ??= []).push(jData.score);
        }
      }
    }
  }
}

if (rows.size === 0) {
  console.error('No scored translations found in any scorecard.');
  process.exit(1);
}

// ── Compute averages ──────────────────────────────────────────────────────────
const avg = (arr) => arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length) : null;
const fmt = (n) => n == null ? '—' : n.toFixed(1);

const aggregated = [...rows.values()].map(r => ({
  ...r,
  avgScore: avg(r.scores),
  n: r.scores.length,
  judgeAvgs: Object.fromEntries(
    Object.entries(r.judgeScores).map(([j, s]) => [j, avg(s)])
  ),
}));

// Sort by avgScore descending
aggregated.sort((a, b) => (b.avgScore ?? -1) - (a.avgScore ?? -1));

// ── Collect all judge IDs (for column headers) ───────────────────────────────
const allJudges = [...new Set(aggregated.flatMap(r => Object.keys(r.judgeAvgs)))].sort();

// ── Build summary table (one row per translator across all directions) ────────
// Group by (project, translatorId) — merge directions
const summaryMap = new Map();
for (const r of aggregated) {
  const key = `${r.project}||${r.translatorId}`;
  if (!summaryMap.has(key)) {
    summaryMap.set(key, { project: r.project, translatorId: r.translatorId, scores: [], judgeScores: {} });
  }
  const s = summaryMap.get(key);
  s.scores.push(...r.scores);
  for (const [j, arr] of Object.entries(r.judgeScores)) {
    (s.judgeScores[j] ??= []).push(...arr);
  }
}
const summary = [...summaryMap.values()].map(s => ({
  ...s,
  avgScore: avg(s.scores),
  n: s.scores.length,
  judgeAvgs: Object.fromEntries(Object.entries(s.judgeScores).map(([j, a]) => [j, avg(a)])),
})).sort((a, b) => (b.avgScore ?? -1) - (a.avgScore ?? -1));

// ── Render ────────────────────────────────────────────────────────────────────
const lines = [];

lines.push('# BabelScore Report');
lines.push('');
lines.push(`_Generated: ${new Date().toISOString()}_  `);
lines.push(`_Scorecard files: ${files.length}_`);
lines.push('');

// ── Summary table ─────────────────────────────────────────────────────────────
lines.push('## Summary — by Translator (all directions combined)');
lines.push('');
const summaryHeader = ['Project', 'Translator', 'n', 'Avg', ...allJudges.map(j => shortJudge(j))];
lines.push('| ' + summaryHeader.join(' | ') + ' |');
lines.push('| ' + summaryHeader.map(() => '---').join(' | ') + ' |');
for (const r of summary) {
  const cells = [
    r.project,
    r.translatorId,
    String(r.n),
    `**${fmt(r.avgScore)}**`,
    ...allJudges.map(j => fmt(r.judgeAvgs[j] ?? null)),
  ];
  lines.push('| ' + cells.join(' | ') + ' |');
}
lines.push('');

// ── Detail tables — one section per direction ─────────────────────────────────
// Collect unique directions in order of first appearance
const allDirections = [...new Set(aggregated.map(r => r.direction))];
const detailHeader = ['Project', 'Translator', 'n', 'Avg', ...allJudges.map(j => shortJudge(j))];

for (const direction of allDirections) {
  lines.push(`## Detail — by Translator · ${direction}`);
  lines.push('');
  lines.push('| ' + detailHeader.join(' | ') + ' |');
  lines.push('| ' + detailHeader.map(() => '---').join(' | ') + ' |');
  for (const r of aggregated.filter(r => r.direction === direction)) {
    const cells = [
      r.project,
      r.translatorId,
      String(r.n),
      `**${fmt(r.avgScore)}**`,
      ...allJudges.map(j => fmt(r.judgeAvgs[j] ?? null)),
    ];
    lines.push('| ' + cells.join(' | ') + ' |');
  }
  lines.push('');
}

// ── File list ─────────────────────────────────────────────────────────────────
lines.push('## Source Files');
lines.push('');
for (const f of files) {
  lines.push(`- \`${path.relative(__dirname, f)}\``);
}
lines.push('');

const md = lines.join('\n');

if (outputFile) {
  fs.writeFileSync(outputFile, md, 'utf8');
  console.error(`Report written to ${outputFile}`);
} else {
  process.stdout.write(md);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function shortJudge(id) {
  // Shorten common judge IDs for column headers
  return id
    .replace('openrouter-', '')
    .replace('lmstudio-', '')
    .replace('openai-', '')
    .replace('anthropic-', '');
}
