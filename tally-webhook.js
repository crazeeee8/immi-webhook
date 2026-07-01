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
const TG_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
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

// Send zip file directly to Telegram so it's accessible from Railway's ephemeral FS
function tgSendZip(zipPath, caption) {
  if (!TG_TOKEN) return;
  return new Promise((resolve) => {
    const fileData = fs.readFileSync(zipPath);
    const filename = path.basename(zipPath);
    const boundary = `----FormBoundary${Date.now()}`;
    const captionPart = `--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n`;
    const chatPart   = `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${TG_CHAT}\r\n`;
    const filePart   = `--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${filename}"\r\nContent-Type: application/zip\r\n\r\n`;
    const closing    = `\r\n--${boundary}--\r\n`;
    const body = Buffer.concat([
      Buffer.from(captionPart + chatPart + filePart),
      fileData,
      Buffer.from(closing),
    ]);
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TG_TOKEN}/sendDocument`,
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
    });
    req.on('error', resolve);
    req.on('response', resolve);
    req.write(body);
    req.end();
  });
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

      // Send zip to Telegram first — Railway FS is ephemeral
      await tgSendZip(zipPath, `NEW IMMI VAULT\nName: ${answers.first_name}\nEmail: ${answers.email || '(no email)'}\n\nVault attached above. Email to customer using template below.`);

      // Send customer email draft
      tgNotify(`EMAIL DRAFT — ${answers.first_name} (${answers.email || 'no email'})\n\n` +
`Hi ${answers.first_name},\n\n` +
`Your Immi context file is ready — see the ZIP above.\n\n` +
`HOW TO USE IT NOW\n` +
`Open the ZIP → find immi/context-notes/work.md (or health/decisions) → paste it at the start of any Claude or ChatGPT conversation. Your AI immediately knows who you are. No Obsidian required yet.\n\n` +
`This is the manual version of what the Immi plugin will do automatically with one click. You just experienced the core of what we're building.\n\n` +
`WANT THE PLUGIN WHEN IT LAUNCHES?\n` +
`Pro subscribers get early access + first-month discount.\n` +
`→ Save your spot: https://crazeeee8.github.io/immi/\n\n` +
`WANT THE FULL SETUP?\n` +
`The $250 session covers: vault + AI memory migration + Claude Code + Remote Kuato (Claude on Telegram that knows you). Reply to this email if interested.\n\n` +
`— GLOCK\n\n` +
`────\nReply SENT when emailed.`);

      const entry = {
        ts:         new Date().toISOString(),
        responseId,
        name:       answers.first_name,
        email:      answers.email || '(no email)',
        status:     'PENDING',
      };
      fs.appendFileSync(QUEUE, JSON.stringify(entry) + '\n');

      console.log(`\n✓ ${answers.first_name} (${answers.email})`);
      console.log(`  Zip sent to Telegram — email to customer\n`);

    } catch (err) {
      console.error(`\n✗ Failed [${responseId}]:`, err.message);
      tgNotify(`🔴 <b>Immi vault generation failed</b>\nID: ${responseId}\nError: ${err.message}`);
      fs.appendFileSync(QUEUE, JSON.stringify({
        ts: new Date().toISOString(), responseId, status: 'ERROR', error: err.message,
      }) + '\n');
    }
  });
});

// ── Pro waitlist webhook ──────────────────────────────────────────────────
// Wire the Tally waitlist form (RGgLGj) to POST /webhook/waitlist in Tally settings.
app.post('/webhook/waitlist', (req, res) => {
  res.status(200).json({ ok: true });
  setImmediate(() => {
    try {
      const fields = req.body?.data?.fields || [];
      const emailField = fields.find(f => /email/i.test(f.label || ''));
      const email = (Array.isArray(emailField?.value) ? emailField.value[0] : emailField?.value) || '(no email)';
      const responseId = req.body?.data?.responseId || `waitlist-${Date.now()}`;

      const entry = { ts: new Date().toISOString(), responseId, email, type: 'WAITLIST' };
      fs.appendFileSync(QUEUE, JSON.stringify(entry) + '\n');

      const count = fs.readFileSync(QUEUE, 'utf8').split('\n')
        .filter(Boolean)
        .filter(l => { try { return JSON.parse(l).type === 'WAITLIST'; } catch { return false; } })
        .length;

      tgNotify(`🟣 Pro waitlist signup #${count}\nEmail: ${email}`);
      console.log(`\n✓ Waitlist signup #${count}: ${email}\n`);
    } catch (err) {
      console.error('Waitlist webhook error:', err.message);
    }
  });
});

app.get('/', (_req, res) => res.json({ status: 'ok', service: 'immi-vault-generator' }));

app.listen(PORT, () => {
  console.log(`\nImmi webhook server — port ${PORT}`);
  console.log(`Webhook URL:    http://localhost:${PORT}/webhook/tally`);
  console.log(`Delivery queue: ${QUEUE}\n`);
});
