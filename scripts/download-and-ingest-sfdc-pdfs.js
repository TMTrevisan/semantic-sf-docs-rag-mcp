/**
 * scripts/download-and-ingest-sfdc-pdfs.js
 *
 * Downloads a curated set of high-value Salesforce developer PDFs from
 * resources.docs.salesforce.com and embeds them into data/rag.sqlite.
 *
 * Run: node scripts/download-and-ingest-sfdc-pdfs.js
 */

import { pipeline, env } from '@xenova/transformers';
import fs from 'fs';
import path from 'path';
import https from 'https';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

const require = createRequire(import.meta.url);
const pdf = require('pdf-parse');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = process.env.SF_DOCS_DB_PATH ?? path.join(__dirname, '../data/rag.sqlite');
const MODELS_DIR = path.join(__dirname, '../models');
const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const TMP_DIR = path.join(__dirname, '../.tmp-pdfs');
const SF_BASE = 'https://resources.docs.salesforce.com/258/latest/en-us/sfdc/pdf';
const CHUNK_SIZE = 800;
const OVERLAP = 100;
const MAX_RETRIES = 3;

// ── ANSI helpers (zero deps) ──────────────────────────────────────────────────
const ESC = '\x1b[';
const C = { reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m' };
const FG = { white: '\x1b[97m', cyan: '\x1b[96m', green: '\x1b[92m', yellow: '\x1b[93m', red: '\x1b[91m', blue: '\x1b[94m', magenta: '\x1b[95m', gray: '\x1b[90m' };
const BG = { blue: '\x1b[44m', green: '\x1b[42m', gray: '\x1b[100m' };

const cols = process.stdout.columns || 80;
const clrLine = `${ESC}2K\r`;

function color(str, ...codes) { return codes.join('') + str + C.reset; }
function bold(str) { return `${C.bold}${str}${C.reset}`; }
function dim(str) { return `${C.dim}${FG.gray}${str}${C.reset}`; }
function green(str) { return `${FG.green}${str}${C.reset}`; }
function red(str) { return `${FG.red}${str}${C.reset}`; }
function yellow(str) { return `${FG.yellow}${str}${C.reset}`; }
function cyan(str) { return `${FG.cyan}${str}${C.reset}`; }
function gray(str) { return `${FG.gray}${str}${C.reset}`; }
function magenta(str) { return `${FG.magenta}${str}${C.reset}`; }

function bar(filled, total, width = 28) {
    const n = Math.round((filled / Math.max(total, 1)) * width);
    const pct = Math.round((filled / Math.max(total, 1)) * 100);
    const done = '█'.repeat(n);
    const left = '░'.repeat(width - n);
    return `${FG.cyan}${done}${FG.gray}${left}${C.reset} ${bold(String(pct).padStart(3))}${FG.gray}%${C.reset}`;
}

function miniBar(filled, total, width = 20) {
    const n = Math.round((filled / Math.max(total, 1)) * width);
    const done = '▓'.repeat(n);
    const left = '░'.repeat(width - n);
    return `${FG.blue}${done}${FG.gray}${left}${C.reset}`;
}

function formatTime(ms) {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const r = s % 60;
    if (m < 60) return `${m}m ${r}s`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function formatBytes(b) {
    if (b < 1024) return `${b}B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}KB`;
    return `${(b / 1024 / 1024).toFixed(1)}MB`;
}

function boxLine(content, width = Math.min(cols - 2, 78)) {
    const visible = content.replace(/\x1b\[[^m]*m/g, '');
    const pad = Math.max(0, width - visible.length - 2);
    return `│ ${content}${' '.repeat(pad)} │`;
}

function drawBox(lines, title = '') {
    const width = Math.min(cols - 2, 78);
    const top = title
        ? `╭${'─'.repeat(Math.floor((width - title.length - 2) / 2))} ${bold(title)} ${'─'.repeat(Math.ceil((width - title.length - 2) / 2))}╮`
        : `╭${'─'.repeat(width)}╮`;
    const bot = `╰${'─'.repeat(width)}╯`;
    return [top, ...lines.map(l => boxLine(l, width)), bot].join('\n');
}

// ── Curated PDF list ──────────────────────────────────────────────────────────
const PDFS = [
    // Core Platform / Apex
    { file: 'salesforce_apex_developer_guide.pdf', label: 'Apex Developer Guide' },
    { file: 'salesforce_apex_reference_guide.pdf', label: 'Apex Reference Guide' },
    { file: 'dbcom_apex_language_reference.pdf', label: 'Apex Language Reference' },
    { file: 'apex_api.pdf', label: 'Apex API' },
    // LWC & Lightning
    { file: 'lwc.pdf', label: 'LWC Developer Guide' },
    { file: 'lightning.pdf', label: 'Lightning Components' },
    // REST / SOAP / Bulk APIs
    { file: 'api_rest.pdf', label: 'REST API' },
    { file: 'api_meta.pdf', label: 'Metadata API' },
    { file: 'api_tooling.pdf', label: 'Tooling API' },
    { file: 'api_bulk_v2.pdf', label: 'Bulk API v2' },
    { file: 'api_asynch.pdf', label: 'Async SOAP API' },
    { file: 'api_action.pdf', label: 'Actions API' },
    { file: 'api_streaming.pdf', label: 'Streaming API' },
    { file: 'api_console.pdf', label: 'Console API' },
    { file: 'api_ui.pdf', label: 'UI API' },
    // Object Reference
    { file: 'object_reference.pdf', label: 'Object Reference' },
    { file: 'objects.pdf', label: 'Objects Reference' },
    // Platform Events & Big Objects
    { file: 'platform_events.pdf', label: 'Platform Events' },
    { file: 'big_objects_guide.pdf', label: 'Big Objects' },
    { file: 'field_history_retention.pdf', label: 'Field History Retention' },
    // Packages / DevOps
    { file: 'pkg2_dev.pdf', label: '2GP Developer Guide' },
    { file: 'pkg1_dev.pdf', label: '1GP Developer Guide' },
    { file: 'devops_center_dev.pdf', label: 'DevOps Center' },
    // Industry Clouds
    { file: 'health_cloud_dev_guide.pdf', label: 'Health Cloud Dev' },
    { file: 'life_sciences_dev_guide.pdf', label: 'Life Sciences Dev' },
    { file: 'revenue_lifecycle_management_dev_guide.pdf', label: 'Revenue Lifecycle Mgmt' },
    { file: 'fsc_dev_guide.pdf', label: 'Financial Services Cloud' },
    { file: 'insurance_developer_guide.pdf', label: 'Insurance Dev' },
    { file: 'nonprofit_cloud.pdf', label: 'Nonprofit Cloud' },
    { file: 'edu_cloud_dev_guide.pdf', label: 'Education Cloud' },
    { file: 'automotive_cloud.pdf', label: 'Automotive Cloud' },
    { file: 'mfg_api_devguide.pdf', label: 'Manufacturing Cloud' },
    { file: 'media_developer_guide.pdf', label: 'Media Cloud' },
    { file: 'netzero_cloud_dev_guide.pdf', label: 'Net Zero Cloud' },
    { file: 'channel_revenue_management.pdf', label: 'Channel Revenue Mgmt' },
    { file: 'loyalty_api.pdf', label: 'Loyalty API' },
    { file: 'retail_api.pdf', label: 'Retail API' },
    // CPQ / Revenue
    { file: 'cpq_developer_guide.pdf', label: 'CPQ Developer Guide' },
    { file: 'cpq_plugins.pdf', label: 'CPQ Plugins' },
    { file: 'clm_developer_guide.pdf', label: 'CLM Developer Guide' },
    // Agentforce / AI
    { file: 'agentforce_it_service.pdf', label: 'Agentforce IT Service' },
    { file: 'asl_dev_guide.pdf', label: 'Agent Service Layer' },
    // Integration
    { file: 'integration_patterns_and_practices.pdf', label: 'Integration Patterns' },
    { file: 'realtime_reporting_and_integration_apis.pdf', label: 'Realtime Reporting API' },
    // Mobile
    { file: 'mobile_sdk.pdf', label: 'Mobile SDK' },
    { file: 'mobile_offline.pdf', label: 'Mobile Offline' },
    // Communities / Experience Cloud
    { file: 'communities_dev.pdf', label: 'Communities Dev' },
    { file: 'exp_cloud_lwr.pdf', label: 'Experience Cloud LWR' },
    { file: 'embedded_services_web_dev_guide.pdf', label: 'Embedded Services Web' },
    // Field Service
    { file: 'field_service_dev.pdf', label: 'Field Service Dev' },
    // Identity / Security
    { file: 'headless_identity_impl_guide.pdf', label: 'Headless Identity' },
    { file: 'restriction_rules.pdf', label: 'Restriction Rules' },
    // Analytics / CRM Analytics
    { file: 'salesforce_analytics_rest_api.pdf', label: 'Analytics REST API' },
    { file: 'bi_dev_guide_rest.pdf', label: 'CRM Analytics REST' },
    { file: 'bi_dev_guide_saql.pdf', label: 'CRM Analytics SAQL' },
    { file: 'bi_dev_guide_sql.pdf', label: 'CRM Analytics SQL' },
    // Misc
    { file: 'salesforce_app_limits_cheatsheet.pdf', label: 'App Limits Cheatsheet' },
    { file: 'canvas_framework.pdf', label: 'Canvas Framework' },
    { file: 'formula_date_time_tipsheet.pdf', label: 'Formula & DateTime Tips' },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function downloadPdf(filename, destPath, attempt = 1) {
    return new Promise((resolve, reject) => {
        const url = `${SF_BASE}/${filename}`;
        const file = fs.createWriteStream(destPath);

        const handleRes = (res) => {
            if ([301, 302, 307, 308].includes(res.statusCode)) {
                file.destroy();
                fs.existsSync(destPath) && fs.unlinkSync(destPath);
                // Follow redirect
                const newFile = fs.createWriteStream(destPath);
                https.get(res.headers.location, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (r2) => {
                    r2.pipe(newFile);
                    newFile.on('finish', () => { newFile.close(); resolve(); });
                }).on('error', reject);
                return;
            }
            if (res.statusCode === 404) {
                file.destroy();
                fs.existsSync(destPath) && fs.unlinkSync(destPath);
                return reject(Object.assign(new Error(`HTTP 404`), { is404: true }));
            }
            if (res.statusCode !== 200) {
                file.destroy();
                fs.existsSync(destPath) && fs.unlinkSync(destPath);
                return reject(new Error(`HTTP ${res.statusCode}`));
            }
            res.pipe(file);
            file.on('finish', () => { file.close(); resolve(); });
            file.on('error', reject);
        };

        https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 SF-Docs-RAG-Ingest/2.1', Accept: 'application/pdf' } }, handleRes)
            .on('error', async (e) => {
                file.destroy();
                fs.existsSync(destPath) && fs.unlinkSync(destPath);
                if (attempt < MAX_RETRIES) {
                    await sleep(1000 * attempt);
                    downloadPdf(filename, destPath, attempt + 1).then(resolve).catch(reject);
                } else {
                    reject(e);
                }
            });
    });
}

// ── Header ────────────────────────────────────────────────────────────────────

process.stdout.write('\x1b[2J\x1b[H'); // clear screen
console.log(drawBox([
    color('  Salesforce Developer Docs — Download & Ingest  ', FG.cyan, C.bold),
    '',
    `  ${dim('Database:')} ${cyan(DB_PATH)}`,
    `  ${dim('PDFs:')}     ${bold(String(PDFS.length))} curated developer guides`,
    `  ${dim('Source:')}   ${dim('resources.docs.salesforce.com/258/latest/en-us/sfdc/pdf')}`,
], 'semantic-sf-docs-rag-mcp'));
console.log();

// ── DB setup ──────────────────────────────────────────────────────────────────

if (!fs.existsSync(DB_PATH)) {
    console.error(red(`\n❌  Database not found: ${DB_PATH}`));
    process.exit(1);
}
const dbStat = fs.statSync(DB_PATH);
if (dbStat.size < 1024 * 1024) {
    console.error(red(`\n❌  Database is ${formatBytes(dbStat.size)} — likely a git LFS pointer.`));
    console.error(yellow(`   Run: git lfs pull`));
    process.exit(1);
}

const db = new Database(DB_PATH);
db.loadExtension(sqliteVec.getLoadablePath());
db.exec(`
  CREATE TABLE IF NOT EXISTS chunks (rowid INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT, text_chunk TEXT);
  CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(embedding float[384]);
  CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source);
`);

const existingSources = new Set(
    db.prepare('SELECT DISTINCT source FROM chunks').all().map(r => r.source)
);

const insertChunk = db.prepare('INSERT INTO chunks (source, text_chunk) VALUES (?, ?)');
const insertVec = db.prepare('INSERT INTO vec_chunks(rowid, embedding) VALUES (last_insert_rowid(), ?)');

// ── Model load ────────────────────────────────────────────────────────────────

const modelExists = fs.existsSync(path.join(MODELS_DIR, MODEL_ID));
process.stdout.write(`${dim('⚙')}  Loading model ${cyan(MODEL_ID)}${modelExists ? gray(' (bundled)') : yellow(' (downloading…)')}  `);
if (modelExists) { env.localModelPath = MODELS_DIR; env.allowRemoteModels = false; }
const extractor = await pipeline('feature-extraction', MODEL_ID, { quantized: true });
process.stdout.write(`${green('✓')}\n\n`);

// ── Tmp dir ───────────────────────────────────────────────────────────────────

if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

// ── Main loop ─────────────────────────────────────────────────────────────────

let success = 0, skipped = 0, failed = 0, notFound = 0;
const errors = [];
const start = Date.now();
const total = PDFS.length;

for (let i = 0; i < total; i++) {
    const { file: filename, label } = PDFS[i];
    const localUri = `file://sfdc-official/${filename}`;
    const tmpPath = path.join(TMP_DIR, filename);
    const idx = `${color(String(i + 1).padStart(2), FG.gray)}/${color(String(total), FG.gray)}`;

    // ── Already indexed ───────────────────────────────────────────────────────
    if (existingSources.has(localUri)) {
        const chunks = db.prepare('SELECT COUNT(*) as n FROM chunks WHERE source = ?').get(localUri).n;
        console.log(`${dim('⏭')}  ${idx}  ${dim(label.padEnd(38))} ${dim('already indexed')} ${gray(`(${chunks.toLocaleString()} chunks)`)}`);
        skipped++;
        continue;
    }

    // ── Downloading ───────────────────────────────────────────────────────────
    process.stdout.write(`${clrLine}${FG.cyan}⬇${C.reset}  ${idx}  ${bold(label.padEnd(38))} ${dim('downloading…')}`);

    let fileSize = 0;
    try {
        const dlStart = Date.now();
        await downloadPdf(filename, tmpPath);
        fileSize = fs.statSync(tmpPath).size;
        const dlTime = ((Date.now() - dlStart) / 1000).toFixed(1);
        const dlSpeed = formatBytes(fileSize / Math.max((Date.now() - dlStart) / 1000, 0.1)) + '/s';

        // ── Parse PDF ────────────────────────────────────────────────────────
        process.stdout.write(`${clrLine}${FG.blue}⟳${C.reset}  ${idx}  ${bold(label.padEnd(38))} ${dim('parsing… ')} ${gray(formatBytes(fileSize))}`);
        const buffer = fs.readFileSync(tmpPath);
        const data = await pdf(buffer);
        const text = data.text || '';

        if (text.length < 200) {
            process.stdout.write(`${clrLine}${FG.yellow}⚠${C.reset}  ${idx}  ${label.padEnd(38)} ${yellow('empty text — skipped')}\n`);
            fs.unlinkSync(tmpPath);
            failed++;
            errors.push({ label, reason: 'No text extracted' });
            continue;
        }

        // ── Chunk ─────────────────────────────────────────────────────────────
        const title = label;
        const chunks = [];
        for (let pos = 0; pos < text.length; pos += CHUNK_SIZE - OVERLAP) {
            chunks.push(`Source: ${title}\nURL: ${localUri}\n\n${text.slice(pos, pos + CHUNK_SIZE)}`);
        }

        // ── Embed ─────────────────────────────────────────────────────────────
        const embedStart = Date.now();
        const embeddings = [];
        const barWidth = 22;

        for (let c = 0; c < chunks.length; c++) {
            // Update progress every 5 chunks to avoid terminal spam
            if (c % 5 === 0) {
                const pct = c / chunks.length;
                const eta = c > 0 ? formatTime(((Date.now() - embedStart) / c) * (chunks.length - c)) : '…';
                const mini = miniBar(c, chunks.length, barWidth);
                process.stdout.write(`${clrLine}${FG.magenta}◆${C.reset}  ${idx}  ${bold(label.padEnd(38))} ${mini} ${gray(`${c}/${chunks.length}`)} ${dim(`eta ${eta}`)}`);
            }
            const out = await extractor(chunks[c], { pooling: 'mean', normalize: true });
            embeddings.push(new Float32Array(Array.from(out.data)));
        }

        // ── Write (sync transaction) ──────────────────────────────────────────
        process.stdout.write(`${clrLine}${FG.green}●${C.reset}  ${idx}  ${bold(label.padEnd(38))} ${dim('writing to DB…')}`);
        db.transaction(() => {
            for (let j = 0; j < chunks.length; j++) {
                insertChunk.run(localUri, chunks[j]);
                insertVec.run(embeddings[j]);
            }
        })();

        // ── Done line ─────────────────────────────────────────────────────────
        const elapsed = formatTime(Date.now() - start);
        const cps = (chunks.length / Math.max((Date.now() - embedStart) / 1000, 1)).toFixed(0);
        fs.unlinkSync(tmpPath);
        process.stdout.write(
            `${clrLine}${FG.green}✓${C.reset}  ${idx}  ${bold(label.padEnd(38))} ` +
            `${green(String(chunks.length).padStart(5) + ' chunks')}  ` +
            `${gray(formatBytes(fileSize).padStart(7))}  ` +
            `${dim(cps + ' c/s')}\n`
        );
        success++;

        // ── Overall bar ───────────────────────────────────────────────────────
        const done = success + skipped + failed + notFound;
        const overallEta = done > 0 ? formatTime(((Date.now() - start) / done) * (total - done)) : '…';
        process.stdout.write(
            `${clrLine}   ${bar(done, total)}  ` +
            `${green(String(success))} ok  ${yellow(String(skipped))} skip  ${red(String(failed + notFound))} err  ` +
            `${dim('eta ' + overallEta)}`
        );
        process.stdout.write('\n');

    } catch (e) {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        if (e.is404) {
            process.stdout.write(`${clrLine}${FG.gray}✗${C.reset}  ${idx}  ${dim(label.padEnd(38))} ${gray('not found (404)')}\n`);
            notFound++;
        } else {
            process.stdout.write(`${clrLine}${FG.red}✗${C.reset}  ${idx}  ${bold(label.padEnd(38))} ${red(e.message)}\n`);
            failed++;
            errors.push({ label, reason: e.message });
        }
    }
}

// ── Cleanup ───────────────────────────────────────────────────────────────────
if (fs.existsSync(TMP_DIR)) fs.rmSync(TMP_DIR, { recursive: true, force: true });

// ── Summary box ───────────────────────────────────────────────────────────────
const elapsed = Date.now() - start;
const dbFinal = fs.statSync(DB_PATH);
const totalChunks = db.prepare('SELECT COUNT(*) as n FROM chunks').get().n;
const totalSrcs = db.prepare('SELECT COUNT(DISTINCT source) as n FROM chunks').get().n;

console.log('\n');
console.log(drawBox([
    color('  Run Complete', FG.green, C.bold),
    '',
    `  ${dim('Duration:')}   ${bold(formatTime(elapsed))}`,
    `  ${dim('Processed:')} ${bold(String(total))} PDFs`,
    '',
    `  ${green('✓')} ${bold(String(success).padStart(3))} ${dim('ingested successfully')}`,
    `  ${FG.cyan}⏭${C.reset} ${bold(String(skipped).padStart(3))} ${dim('already indexed (skipped)')}`,
    `  ${FG.gray}✗${C.reset} ${dim(String(notFound).padStart(3) + ' not found on CDN (404)')}`,
    ...(failed > 0 ? [`  ${red('✗')} ${bold(String(failed).padStart(3))} ${dim('failed with errors')}`] : []),
    '',
    `  ${dim('DB size:')}    ${bold(formatBytes(dbFinal.size))}`,
    `  ${dim('Sources:')}   ${bold(String(totalSrcs).padStart(4))} ${dim('total indexed')}`,
    `  ${dim('Chunks:')}    ${bold(totalChunks.toLocaleString().padStart(7))} ${dim('total vectors')}`,
    '',
    ...(errors.length > 0 ? [
        `  ${yellow('Errors:')}`,
        ...errors.map(e => `    ${dim('·')} ${e.label}: ${red(e.reason)}`),
        '',
    ] : []),
    `  ${dim('Next step:')}`,
    `  ${cyan('  git add data/rag.sqlite')}`,
    `  ${cyan(`  git commit -m "feat: embed ${success} Salesforce developer PDFs"`)}`,
    `  ${cyan('  git push')}`,
], 'Summary'));
console.log();
