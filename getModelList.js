/**
 * getModelList.js
 * Fetches fresh model lists from all LLM providers used in a given project.
 *
 * Usage:
 *   node getModelList.js -project <project-name>
 *
 * Reads translator_models and judge_models from the project config, identifies
 * unique providers, calls each provider's /v1/models endpoint, and writes
 * the results to DATA/LLM_CACHE/<provider>/models.json.
 * For OpenRouter, also writes a trimmed models_lite.json.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config as loadDotenv } from 'dotenv';
import prettier from 'prettier';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const projectFlag = args.indexOf('-project');

if (projectFlag === -1 || !args[projectFlag + 1]) {
  console.error('Usage: node getModelList.js -project <project-name>');
  process.exit(1);
}

const projectName = args[projectFlag + 1];

// ---------------------------------------------------------------------------
// Load .env and configs
// ---------------------------------------------------------------------------

loadDotenv({ path: resolve(__dirname, '.env') });

const rootConfig = JSON.parse(
  readFileSync(resolve(__dirname, 'config.json'), 'utf8')
);

const projectConfigPath = resolve(__dirname, '_PROJECTS', projectName, 'config.json');
let projectConfig;
try {
  projectConfig = JSON.parse(readFileSync(projectConfigPath, 'utf8'));
} catch {
  console.error(`Could not read project config: ${projectConfigPath}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveApiKey(key) {
  if (!key) return '';
  const match = key.match(/^\$\{(.+)\}$/);
  if (match) return process.env[match[1]] || '';
  return key;
}

async function prettyJson(data) {
  return prettier.format(JSON.stringify(data), { parser: 'json' });
}

// ---------------------------------------------------------------------------
// Collect unique providers from this project
// ---------------------------------------------------------------------------

const allModels = [
  ...(projectConfig.translator_models ?? []),
  ...(projectConfig.judge_models ?? []),
];

const providerKeys = [...new Set(allModels.map((m) => m.provider))];

if (providerKeys.length === 0) {
  console.error('No models found in project config.');
  process.exit(1);
}

console.log(`Project: ${projectName}`);
console.log(`Providers to refresh: ${providerKeys.join(', ')}\n`);

// ---------------------------------------------------------------------------
// Fetch and save
// ---------------------------------------------------------------------------

for (const providerKey of providerKeys) {
  const providerInfo = rootConfig.llms[providerKey];

  if (!providerInfo) {
    console.warn(`⚠  No provider entry in config.json for: "${providerKey}" — skipping.`);
    continue;
  }

  const baseUrl = providerInfo.base_url;
  const apiKey = resolveApiKey(providerInfo.api_key);

  console.log(`Fetching from ${providerInfo.name} (${baseUrl}/models) ...`);

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  let data;
  try {
    const response = await fetch(`${baseUrl}/models`, { headers });
    if (!response.ok) {
      console.error(`  ✗ HTTP ${response.status} ${response.statusText}`);
      continue;
    }
    data = await response.json();
  } catch (err) {
    console.error(`  ✗ Request failed: ${err.message}`);
    continue;
  }

  const cacheDir = resolve(__dirname, 'DATA', 'LLM_CACHE', providerKey);
  mkdirSync(cacheDir, { recursive: true });

  // Full models.json
  writeFileSync(resolve(cacheDir, 'models.json'), await prettyJson(data));
  const count = data.data?.length ?? '?';
  console.log(`  ✓ models.json saved (${count} models)`);

  // OpenRouter: also write trimmed models_lite.json
  if (providerKey === 'openrouter' && Array.isArray(data.data)) {
    const lite = {
      object: 'list',
      data: data.data.map((m) => {
        const slashIdx = m.id.indexOf('/');
        return {
          id: m.id,
          provider: slashIdx !== -1 ? m.id.slice(0, slashIdx) : m.id,
          model: slashIdx !== -1 ? m.id.slice(slashIdx + 1) : m.id,
          base_url: 'https://openrouter.ai/api/v1',
          api_key: '${OPENROUTER_API_KEY}',
          hugging_face_id: m.hugging_face_id || '',
        };
      }),
    };

    writeFileSync(resolve(cacheDir, 'models_lite.json'), await prettyJson(lite));
    console.log(`  ✓ models_lite.json saved (${lite.data.length} models)`);
  }

  console.log();
}

console.log('Done.');
