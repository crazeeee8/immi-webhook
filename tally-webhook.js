#!/usr/bin/env node
/**
 * Tally webhook handler — IMMI vault generator
 *
 * Receives Tally form submissions, generates the personalized vault,
 * zips it, and queues it for delivery.
 *
 * Start:  node tally-webhook.js
 * Port:   3000 (or PORT env var)
 * Expose: npx ngrok http 3000
 *         → paste the ngrok https URL into Tally → Integrations → Webhook
 */

'use strict';
const express        = require('express');
const fs             = require('fs');
const path           = require('path');
const https          = require('https');
const { generate }   = require('./generate');

const app      = express();
const PORT     = process.env.PORT || 3000;
const QUEUE    = path.join(__dirname, 'delivery-queue.jsonl');
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT  = '6540751763';

function tgNotify(text) {
  if (!TG_TOKEN) return;
  const body = JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML' });
  const req = https.request({
    hostname: 'api.telegram.org',
    path: `/bot${TG_TOKEN}/sendMessage`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  });
  req.on('error', () => {});
  req.write(body);
  req.end();
}

app.use(express.json());

// ── Field label → answers key ─────────────────────────────────────────────
// Keys must match the labels you set in the Tally form (case-insensitive).
const LABEL_MAP = {
  'your first name':                                         'first_name',
  'your email':                                              'email',
  'describe your role':                                      'q1_role',
  'what are your top 3 goals right now':                     'q2_goals',
  'which ai tools do you use regularly':                     'q3_ai_tools',
  'what context do you always have to re-explain to ai':     'q4_reexplain',
  'what are your 3 core working principles':                 'q5_principles',
  'what are you actively working on':                        'q6_projects',
  'who do you work with':                                    'q7_people',
  'what decisions are you navigating right now':             'q8_decisions',
  'what should ai never assume about you':                   'q9_never_assume',
  'do you have any habits or rhythms that shape how you work': 'q10_routines',
};

function parsePayload(body) {
  const fields = body?.data?.fields;
  if (!Array.isArray(fields)) throw new Error('no fields array in payload');

  const answers = {};
  for (const field of fields) {
    const key = (field.label || '').toLowerCase().trim().replace(/[?:]/g, '');
    const answerKey = LABEL_MAP[key];
    if (!answerKey) continue;

    // CHECKBOXES / MULTI_SELECT → resolve option IDs to text
    if (Array.isArray(field.value) && Array.isArray(field.options)) {
      const optMap = Object.fromEntries(field.options.map(o => [o.id, o.text]));
      answers[answerKey] = field.value.map(id => optMap[id] || id);
    } else {
      answers[answerKey] = field.value ?? '';
    }
  }

  if (!answers.first_name) throw new Error('first_name field not found — check LABEL_MAP');
  return answers;
}

// ── Webhook endpoint ──────────────────────────────────────────────────────
app.post('/webhook/tally', (req, res) => {
  res.status(200).json({ ok: true }); // Tally retries on slow responses

  const responseId = req.body?.data?.responseId || `local-${Date.now()}`;

  setImmediate(async () => {
    try {
      const answers = parsePayload(req.body);
      const zipPath = await generate(answers, { zip: true, outBase: __dirname });

      const entry = {
        ts:         new Date().toISOString(),
        responseId,
        name:       answers.first_name,
        email:      answers.email || '(no email)',
        zipPath,
        status:     'PENDING',
      };
      fs.appendFileSync(QUEUE, JSON.stringify(entry) + '\n');

      tgNotify(`🟢 <b>New Immi vault request</b>\nName: ${answers.first_name}\nEmail: ${answers.email}\nVault: ${zipPath}\n\nAction: send zip, mark SENT in delivery-queue.jsonl`);
      console.log(`\n✓ ${answers.first_name} (${answers.email})`);
      console.log(`  Vault: ${zipPath}`);
      console.log(`  Action: send zip to customer, then mark SENT in delivery-queue.jsonl\n`);

    } catch (err) {
      console.error(`\n✗ Failed [${responseId}]:`, err.message);
      tgNotify(`🔴 <b>Immi vault generation failed</b>\nID: ${responseId}\nError: ${err.message}`);
      fs.appendFileSync(QUEUE, JSON.stringify({
        ts: new Date().toISOString(), responseId, status: 'ERROR', error: err.message,
      }) + '\n');
    }
  });
});

app.get('/', (_req, res) => res.json({ status: 'ok', service: 'immi-vault-generator' }));

app.listen(PORT, () => {
  console.log(`\nImmi webhook server — port ${PORT}`);
  console.log(`Webhook URL:    http://localhost:${PORT}/webhook/tally`);
  console.log(`Delivery queue: ${QUEUE}\n`);
});
