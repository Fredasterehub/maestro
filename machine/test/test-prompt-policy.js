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

// Each entry: [label, pattern]. Patterns are deliberately specific phrases
// or compounds, not bare words already in legitimate use elsewhere in these
// prompts (e.g. "rung" alone names the escalation/dispute ladder, not a
// model-ranking scheme — "rung-relative" as a compound is the banned form).
const BANNED = [
  ['ranking: cheapest', /\bcheapest\b/i],
  ['ranking: strongest', /\bstrongest\b/i],
  ['ranking: rung-relative rank', /\brung-relative\b/i],
  ['ranking: frontier-rank', /\bfrontier[- ]rank/i],
  ['ranking: "more powerful than"', /more powerful than/i],
  ['ranking: price narrative', /\b(price tag|budget model|cut-rate)\b/i],
  ['ranking: prestige narrative', /\b(prestige|flagship|top-tier|premium)\b/i],
  ['plan-fusion: apex always requires planning', /apex always requires planning/i],
  ['plan-fusion: hard fence means plan-first', /hard fence means plan-first/i],
  ['haiku token', /haiku/i],
];

let violations = 0;
for (const filename of fs.readdirSync(AGENTS_DIR)) {
  if (!filename.endsWith('.md')) continue;
  const filePath = path.join(AGENTS_DIR, filename);
  const text = fs.readFileSync(filePath, 'utf8');
  for (const [label, pattern] of BANNED) {
    const match = text.match(pattern);
    if (match) {
      violations += 1;
      console.error(`test-prompt-policy: ${filename} trips ${label} — "${match[0]}"`);
    }
  }
}

assert.strictEqual(violations, 0, `${violations} prompt-policy violation(s) found across agents/*.md — see stderr above`);

console.log('test-prompt-policy: OK');
