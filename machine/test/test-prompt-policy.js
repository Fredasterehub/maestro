'use strict';

// Guards how agents/*.md describe the seat's own role, not the hierarchy of
// models a seat imagines itself sitting in. A prompt earns its place by
// stating what the seat does and when to spawn it; the moment it starts
// ranking itself against other seats — cheapest, strongest, frontier-rank,
// "more powerful than", price or prestige narrative — or fuses planning to
// class ("apex always requires planning", "hard fence means plan-first"),
// it has smuggled in comparative status the router already owns in data
// (routing.js), and a later seat prompt will copy the habit. This test scans
// every seat file present at this commit so every seat landing in a later
// slice arrives under the same policy. Per execution-plan.md section 16.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const AGENTS_DIR = path.join(__dirname, '..', '..', 'agents');

// Recursive, extension-agnostic walk — "no haiku ... anywhere" (§16) means
// anywhere under agents/, not only its top-level .md files.
function walkFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(p));
    else out.push(p);
  }
  return out;
}

// Each entry: [label, pattern]. Patterns are deliberately specific phrases
// or compounds, not bare words already in legitimate use elsewhere in these
// prompts (e.g. "rung" alone names the escalation/dispute ladder, not a
// model-ranking scheme — "rung-relative" as a compound is the banned form).
// The comparative and fusion patterns are intentionally wider than a single
// literal phrase: a one-word paraphrase of a banned phrase states exactly
// the idea the ban exists to prevent, and a blocklist that only catches the
// original wording invites the paraphrase instead of the phrase.
const BANNED = [
  ['ranking: cheapest', /\bcheapest\b/i],
  ['ranking: strongest', /\bstrongest\b/i],
  ['ranking: weakest', /\bweakest\b/i],
  ['ranking: most capable', /\bmost capable\b/i],
  ['ranking: rung-relative rank', /\brung-relative\b/i],
  ['ranking: frontier-rank', /\bfrontier[- ]rank/i],
  ['ranking: comparative ("cheaper/stronger/weaker/more capable than")', /\b(cheaper|stronger|weaker|more capable)\s+than\b/i],
  ['ranking: "more powerful than"', /more powerful than/i],
  ['ranking: "higher tier than"', /\bhigher tier than\b/i],
  ['ranking: "costs less"', /\bcosts less\b/i],
  ['ranking: price narrative', /\b(price tag|budget model|cut-rate)\b/i],
  ['ranking: prestige narrative', /\b(prestige|flagship|top-tier|premium)\b/i],
  ['plan-fusion: apex requires planning', /\bapex\s+\w*\s*requires?\s+planning\b/i],
  ['plan-fusion: hard fence means/is plan-first', /hard fence\s+(means|is)\s+plan-first/i],
  ['haiku token', /haiku/i],
];

let violations = 0;
for (const filePath of walkFiles(AGENTS_DIR)) {
  const text = fs.readFileSync(filePath, 'utf8');
  for (const [label, pattern] of BANNED) {
    const match = text.match(pattern);
    if (match) {
      violations += 1;
      console.error(`test-prompt-policy: ${path.relative(AGENTS_DIR, filePath)} trips ${label} — "${match[0]}"`);
    }
  }
}

assert.strictEqual(violations, 0, `${violations} prompt-policy violation(s) found across agents/*.md — see stderr above`);

console.log('test-prompt-policy: OK');
