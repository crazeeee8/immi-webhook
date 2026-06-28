#!/usr/bin/env node
/**
 * IMMI Vault Generator
 * Input:  answers object (or answers.json path via CLI)
 * Output: immi-vault-[name]/ directory + optional zip
 *
 * CLI:    node generate.js --input sample-input.json [--zip]
 * Module: const { generate } = require('./generate');
 *         await generate(answers, { zip: true }) → zipPath
 */

'use strict';
const fs   = require('fs');
const path = require('path');

// ── helpers ──────────────────────────────────────────────────────────────────

function bullet(text) {
  if (!text) return '';
  return text.split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => l.startsWith('-') || l.match(/^\d+\./) ? l : `- ${l}`)
    .join('\n');
}

function parsePeople(text) {
  if (!text) return '';
  if (Array.isArray(text)) return text.map(p => `- ${p}`).join('\n');
  const people = [];
  let depth = 0, current = '';
  for (const ch of text) {
    if (ch === '(') { depth++; current += ch; }
    else if (ch === ')') { depth--; current += ch; }
    else if (ch === ',' && depth === 0) {
      if (current.trim()) people.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) people.push(current.trim());
  return people.map(p => `- ${p}`).join('\n');
}

function zipDir(srcDir, zipPath) {
  return new Promise((resolve, reject) => {
    const archiver = require('archiver');
    const output   = fs.createWriteStream(zipPath);
    const archive  = archiver('zip', { zlib: { level: 9 } });
    output.on('close', () => resolve(zipPath));
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(srcDir, path.basename(srcDir));
    archive.finalize();
  });
}

// ── core generator ────────────────────────────────────────────────────────────

async function generate(a, { zip = false, outBase = __dirname, silent = false } = {}) {
  const log    = silent ? () => {} : console.log.bind(console);
  const name   = (a.first_name || 'user').toLowerCase().replace(/\s+/g, '-');
  const outDir = path.join(outBase, `immi-vault-${name}`);
  const tools  = Array.isArray(a.q3_ai_tools) ? a.q3_ai_tools.join(', ') : (a.q3_ai_tools || '');
  const today  = new Date().toISOString().slice(0, 10);
  const routinesText = a.q10_routines || a.q10_protocols || '';

  function write(relPath, content) {
    const full = path.join(outDir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content.trimStart(), 'utf8');
    log(`  ✓ ${relPath}`);
  }

  log(`\nGenerating Immi vault for ${a.first_name}...\n`);

  write('README.md', `
# Your Immi Vault — ${a.first_name}
Generated: ${today}

## How to use in 60 seconds

1. **Open Obsidian** → File → Open Vault → select this folder
2. **Open** \`immi/context-notes/work.md\`
3. **Copy** the entire contents (Cmd/Ctrl+A → Cmd/Ctrl+C)
4. **Paste** at the start of your next Claude or ChatGPT conversation
5. Notice the difference — the AI knows who you are from the first message

## Your context notes

| Scene | File | Use when |
|-------|------|---------|
| Work | \`immi/context-notes/work.md\` | Any work conversation with AI |
| Decision | \`immi/context-notes/decision.md\` | Thinking through a decision |

## Maintenance files

Update these as your situation changes — context notes regenerate from them.

- \`immi/identity.md\` — who you are, your principles, your constraints
- \`immi/goals.md\` — your current goals
- \`immi/professional/role.md\` — your active projects, your team
- \`immi/decisions/active.md\` — decisions you're navigating now
- \`immi/routines/active.md\` — your working rhythms and habits

## Next step

The Immi plugin automates all of this:
- Regenerates context notes from your vault with one click
- Browser extension injects context into any AI tab automatically
- Notifies you when your context is getting stale

→ Join the waitlist: https://crazeeee8.github.io/immi/
`);

  write('immi/identity.md', `
---
type: identity
updated: ${today}
---

# Identity

## Who I am
${a.q1_role}

## AI tools I use
${tools}

## How I work
${bullet(a.q5_principles)}

## What AI should never assume about me
${bullet(a.q9_never_assume)}
`);

  write('immi/goals.md', `
---
type: goals
updated: ${today}
---

# Current Goals

${bullet(a.q2_goals)}
`);

  write('immi/professional/role.md', `
---
type: professional
updated: ${today}
---

# Professional Context

## Active projects
${bullet(a.q6_projects)}

## Team and stakeholders
${parsePeople(a.q7_people)}
`);

  write('immi/decisions/active.md', `
---
type: decisions
updated: ${today}
---

# Active Decisions

${bullet(a.q8_decisions)}
`);

  if (routinesText.trim()) {
    write('immi/routines/active.md', `
---
type: routines
updated: ${today}
---

# Habits & Rhythms

These are your working routines — how you structure your time and protect your best thinking.
AI can reference these to give advice that fits how you actually operate.

${bullet(routinesText)}
`);
  }

  const routinesBlock = routinesText.trim()
    ? `\n## How I operate\n${bullet(routinesText)}\n` : '';

  write('immi/context-notes/work.md', `
---
type: context-note
scene: work
updated: ${today}
---

# Work Context — ${a.first_name}

${a.q1_role}
AI tools I use: ${tools}

## Active projects
${bullet(a.q6_projects)}

## Team and stakeholders
${parsePeople(a.q7_people)}

## Goals right now
${bullet(a.q2_goals)}

## How I work
${bullet(a.q5_principles)}

## What not to assume
${bullet(a.q9_never_assume)}

---
*Paste this at the start of any work conversation. Update \`immi/professional/role.md\` when your projects or team change.*
`);

  write('immi/context-notes/decision.md', `
---
type: context-note
scene: decision
updated: ${today}
---

# Decision Context — ${a.first_name}

## My operating principles
${bullet(a.q5_principles)}
${routinesBlock}
## What I'm trying to achieve
${bullet(a.q2_goals)}

## Decisions I'm navigating now
${bullet(a.q8_decisions)}

## What not to assume
${bullet(a.q9_never_assume)}

---
*Paste this before asking AI to help you think through a decision or strategy.*
`);

  log(`\nVault generated → ${outDir}/`);

  if (zip) {
    const zipPath = `${outDir}.zip`;
    await zipDir(outDir, zipPath);
    log(`Zip → ${zipPath}`);
    return zipPath;
  }

  return outDir;
}

// ── CLI entry point ───────────────────────────────────────────────────────────

if (require.main === module) {
  const args     = process.argv.slice(2);
  const inputArg = args[args.indexOf('--input') + 1] || 'answers.json';
  const doZip    = args.includes('--zip');
  const a        = JSON.parse(fs.readFileSync(inputArg, 'utf8'));

  generate(a, { zip: doZip }).then(() => {
    if (!doZip) {
      console.log('\nContext notes (paste into AI):');
      console.log('  immi/context-notes/work.md      ← work conversations');
      console.log('  immi/context-notes/decision.md  ← decisions & strategy');
    }
  }).catch(e => { console.error(e.message); process.exit(1); });
}

module.exports = { generate };
