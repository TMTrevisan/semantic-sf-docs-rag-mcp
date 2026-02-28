/**
 * scripts/download-and-ingest-sfdc-pdfs.js
 *
 * Downloads a curated set of high-value Salesforce developer PDFs from
 * resources.docs.salesforce.com and embeds them into data/rag.sqlite.
 *
 * Run: node scripts/download-and-ingest-sfdc-pdfs.js
 * Expected runtime: 30-90 minutes depending on PDF sizes and system speed.
 */

import { pipeline } from '@xenova/transformers';
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
const MODEL_PATH = path.join(__dirname, '../models/Xenova/all-MiniLM-L6-v2');
const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const TMP_DIR = path.join(__dirname, '../.tmp-pdfs');
const SF_BASE_URL = 'https://resources.docs.salesforce.com/258/latest/en-us/sfdc/pdf';
const CHUNK_SIZE = 800;
const OVERLAP = 100;

// ── Curated list of high-value Salesforce developer PDFs ─────────────────────
// Skips outdated BuddyMedia, Radian6, legacy Marketing Cloud docs
const PDFS = [
    // Core Platform / Apex
    'salesforce_apex_developer_guide.pdf',
    'salesforce_apex_reference_guide.pdf',
    'dbcom_apex_language_reference.pdf',
    'apex_api.pdf',
    'apex_workbook.pdf',

    // LWC & Lightning
    'lwc.pdf',
    'lightning.pdf',

    // REST / SOAP / Bulk APIs
    'api_rest.pdf',
    'api_meta.pdf',
    'api_tooling.pdf',
    'api_bulk_v2.pdf',
    'api_asynch.pdf',
    'api_action.pdf',
    'api_streaming.pdf',
    'api_console.pdf',
    'api_ui.pdf',
    'api_apex_rest.pdf',

    // Object Reference
    'object_reference.pdf',
    'objects.pdf',

    // Platform Events & Big Objects
    'platform_events.pdf',
    'big_objects_guide.pdf',
    'field_history_retention.pdf',

    // Packages / DevOps
    'pkg2_dev.pdf',
    'pkg1_dev.pdf',
    'devops_center_dev.pdf',
    'isv_pkg.pdf',

    // Industry Clouds (high value)
    'health_cloud_dev_guide.pdf',
    'life_sciences_dev_guide.pdf',
    'revenue_lifecycle_management_dev_guide.pdf',
    'fsc_dev_guide.pdf',           // Financial Services Cloud
    'insurance_developer_guide.pdf',
    'nonprofit_cloud.pdf',
    'edu_cloud_dev_guide.pdf',
    'automotive_cloud.pdf',
    'mfg_api_devguide.pdf',
    'media_developer_guide.pdf',
    'netzero_cloud_dev_guide.pdf',
    'order_management_developer_guide.pdf',
    'channel_revenue_management.pdf',
    'loyalty_api.pdf',
    'retail_api.pdf',

    // CPQ / Revenue
    'cpq_developer_guide.pdf',
    'cpq_plugins.pdf',
    'clm_developer_guide.pdf',

    // Agentforce / AI
    'agentforce_it_service.pdf',
    'asl_dev_guide.pdf',

    // Integration
    'integration_patterns_and_practices.pdf',
    'integration_workbook.pdf',
    'realtime_reporting_and_integration_apis.pdf',
    'data_pipelines.pdf',

    // Mobile
    'mobile_sdk.pdf',
    'mobile_offline.pdf',

    // Communities / Experience Cloud
    'communities_dev.pdf',
    'exp_cloud_lwr.pdf',
    'embedded_services_web_dev_guide.pdf',

    // Field Service
    'field_service_dev.pdf',

    // Identity / Security
    'headless_identity_impl_guide.pdf',
    'restriction_rules.pdf',
    'record_locking_cheatsheet.pdf',
    'limits_limitations.pdf',

    // Analytics / CRM Analytics
    'salesforce_analytics_rest_api.pdf',
    'bi_admin_guide_data_integration_guide.pdf',
    'bi_dev_guide_rest.pdf',
    'bi_dev_guide_saql.pdf',
    'bi_dev_guide_sql.pdf',

    // Misc dev reference
    'salesforce_app_limits_cheatsheet.pdf',
    'forcecom_workbook.pdf',
    'canvas_framework.pdf',
    'Lightning_Components_Cheatsheet.pdf',
    'formula_date_time_tipsheet.pdf',
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function downloadPdf(filename, destPath) {
    return new Promise((resolve, reject) => {
        const url = `${SF_BASE_URL}/${filename}`;
        const file = fs.createWriteStream(destPath);
        https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 SF-Docs-RAG-Ingest/2.0' } }, (res) => {
            if (res.statusCode === 302 || res.statusCode === 301) {
                file.close();
                https.get(res.headers.location, (res2) => {
                    res2.pipe(file);
                    file.on('finish', resolve);
                }).on('error', reject);
                return;
            }
            if (res.statusCode !== 200) {
                file.close();
                return reject(new Error(`HTTP ${res.statusCode}`));
            }
            res.pipe(file);
            file.on('finish', () => { file.close(); resolve(); });
        }).on('error', (e) => { file.close(); reject(e); });
    });
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log(`\n🚀 Salesforce Developer Docs — Download & Ingest`);
console.log(`Database: ${DB_PATH}`);
console.log(`PDFs to process: ${PDFS.length}\n`);

// Create tmp dir
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

// Open DB
const db = new Database(DB_PATH);
db.loadExtension(sqliteVec.getLoadablePath());
db.exec(`
  CREATE TABLE IF NOT EXISTS chunks (rowid INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT, text_chunk TEXT);
  CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(embedding float[384]);
`);

// Check which sources are already indexed
const existingSources = new Set(
    db.prepare(`SELECT DISTINCT source FROM chunks`).all().map(r => r.source)
);

// Load model
const modelSource = fs.existsSync(MODEL_PATH) ? MODEL_PATH : MODEL_ID;
console.log(`Loading embedding model from: ${modelSource}\n`);
const extractor = await pipeline('feature-extraction', modelSource, { quantized: true });

const insertChunk = db.prepare(`INSERT INTO chunks (source, text_chunk) VALUES (?, ?)`);
const insertVec = db.prepare(`INSERT INTO vec_chunks(rowid, embedding) VALUES (last_insert_rowid(), ?)`);

let success = 0, skipped = 0, failed = 0;
const start = Date.now();

for (let i = 0; i < PDFS.length; i++) {
    const filename = PDFS[i];
    const localUri = `file://sfdc-official/${filename}`;
    const tmpPath = path.join(TMP_DIR, filename);

    if (existingSources.has(localUri)) {
        console.log(`[${i + 1}/${PDFS.length}] ⏭  Already indexed: ${filename}`);
        skipped++;
        continue;
    }

    process.stdout.write(`[${i + 1}/${PDFS.length}] ⬇  Downloading: ${filename}...`);
    try {
        await downloadPdf(filename, tmpPath);
        const stat = fs.statSync(tmpPath);
        process.stdout.write(` (${(stat.size / 1024 / 1024).toFixed(1)}MB)\n`);

        const buffer = fs.readFileSync(tmpPath);
        const data = await pdf(buffer);
        const text = data.text || '';

        if (text.length < 100) {
            console.log(`   ⚠  Very little text extracted — skipping.`);
            fs.unlinkSync(tmpPath);
            failed++;
            continue;
        }

        const title = filename.replace(/\.pdf$/i, '').replace(/_/g, ' ');
        const chunks = [];
        for (let pos = 0; pos < text.length; pos += CHUNK_SIZE - OVERLAP) {
            chunks.push(`Source: ${title}\nURL: ${localUri}\n\n${text.slice(pos, pos + CHUNK_SIZE)}`);
        }

        process.stdout.write(`   📊 Embedding ${chunks.length} chunks...`);
        for (const chunk of chunks) {
            const out = await extractor(chunk, { pooling: 'mean', normalize: true });
            const embedding = new Float32Array(Array.from(out.data));
            insertChunk.run(localUri, chunk);
            insertVec.run(embedding);
        }
        process.stdout.write(` ✅\n`);

        // Clean up tmp file immediately to save disk space
        fs.unlinkSync(tmpPath);
        success++;
    } catch (e) {
        process.stdout.write(` ❌ ${e.message}\n`);
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        failed++;
    }
}

// Clean up tmp dir
if (fs.existsSync(TMP_DIR)) fs.rmdirSync(TMP_DIR, { recursive: true });

const elapsed = ((Date.now() - start) / 1000 / 60).toFixed(1);
const total = db.prepare('SELECT COUNT(*) as n FROM chunks').get();
const totalSources = db.prepare('SELECT COUNT(DISTINCT source) as n FROM chunks').get();

console.log(`\n${'─'.repeat(50)}`);
console.log(`✅ Done in ${elapsed} minutes`);
console.log(`   Success: ${success}  |  Skipped: ${skipped}  |  Failed: ${failed}`);
console.log(`   Database: ${totalSources.n} sources · ${total.n.toLocaleString()} total chunks`);
console.log(`   Path: ${DB_PATH}`);
console.log(`\nCommit the updated database to your private repo:`);
console.log(`  git add data/rag.sqlite && git commit -m "feat: embed ${success} Salesforce developer PDFs" && git push`);
