'use strict';

// Binds every routed seat in the active routing config to its agents/*.md
// file and that file's machine-readable frontmatter, per execution-plan.md
// section 10. Frontmatter is the only source this test reads for a seat's
// profile — nothing here parses free-form description prose.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROUTING_SRC = path.join(__dirname, '..', 'src', 'routing.js');
const { buildDefaultConfig, validateRoutingConfig, FAMILIES } = require(ROUTING_SRC);

const AGENTS_DIR = path.join(__dirname, '..', '..', 'agents');

// --- frontmatter -------------------------------------------------------------

// Minimal frontmatter reader: only scalar top-level keys are extracted (the
// values this test needs — model, effort, worker_model, worker_effort,
// fallback, fallback_effort). Block-scalar values (`description: |-`) are
// free-form prose and are deliberately skipped, never parsed as data.
function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const lines = m[1].split(/\r?\n/);
  const fm = {};
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z_][A-Za-z0-9_-]*):[ \t]?(.*)$/);
    if (!kv) continue;
    const [, key, rawValue] = kv;
    const value = rawValue.trim();
    if (value === '' || value === '|-' || value === '|' || value === '>-' || value === '>') {
      // Block scalar (or an empty scalar with an indented continuation):
      // consume the indented body, never treated as machine-readable data.
      while (i + 1 < lines.length && (lines[i + 1] === '' || /^[ \t]/.test(lines[i + 1]))) i++;
      continue;
    }
    fm[key] = value;
  }
  return fm;
}

function loadAgentFiles() {
  const byName = new Map();
  for (const filename of fs.readdirSync(AGENTS_DIR)) {
    if (!filename.endsWith('.md')) continue;
    const filePath = path.join(AGENTS_DIR, filename);
    const text = fs.readFileSync(filePath, 'utf8');
    byName.set(filename.slice(0, -3), { filePath, text, frontmatter: parseFrontmatter(text) });
  }
  return byName;
}

// Claude model names in routing config carry a version suffix
// ("opus-5", "sonnet-5", "fable-5") that agent frontmatter's `model:` field
// never does — the CLI's own model field takes the short family alias
// ("opus", "sonnet", "fable"). Only Claude-hosted values (a native seat's
// own model, or any seat's host) go through this normalization; a non-Claude
// worker model (gpt-5.6-sol, gemini-3.1-pro-preview) is compared byte-exact
// against `worker_model`, since that key is free-form text, not a CLI enum.
function shortClaudeModel(fullModel) {
  return String(fullModel).split('-')[0];
}

// --- load config + agent files ------------------------------------------------

const config = buildDefaultConfig('2026-08-07'); // date is cosmetic (calibrated field) — content is what matters
{
  const { ok, errors } = validateRoutingConfig(config);
  assert.strictEqual(ok, true, `active routing config fails its own shape validation: ${errors.join('; ')}`);
}
const agents = loadAgentFiles();

// --- no haiku token anywhere under agents/ -----------------------------------

for (const [name, { text, filePath }] of agents) {
  assert.ok(!/haiku/i.test(text), `agents/${name}.md contains the banned "haiku" token (${filePath})`);
}

// --- every seat named in the active routing config has a file ---------------

for (const seatName of Object.keys(config.seats)) {
  assert.ok(agents.has(seatName), `routing config names seat "${seatName}" but agents/${seatName}.md does not exist`);
}

// --- every file the config routes has exact machine-readable frontmatter ----
//
// "Routes" means live, non-alias entries in config.seats. Alias seats
// (executor-sol, reviewer-sol) exist only to keep an old name resolvable
// across the r1->r2 migration and are checked below for unroutability, not
// for frontmatter parity — a file shipped for a seat the config does not
// route (dormant executor-luna/executor-terra/reviewer-terra, still absent
// from config.seats until Slice 5's r4->r5 migration) is likewise not a
// parity failure; only a routed seat with no matching, exact file is.

for (const [seatName, seat] of Object.entries(config.seats)) {
  if ('alias_of' in seat) continue; // aliases: existence only, checked separately below

  const agent = agents.get(seatName);
  assert.ok(agent, `routed seat "${seatName}" has no agents/${seatName}.md file`);
  const fm = agent.frontmatter;
  assert.ok(fm, `agents/${seatName}.md has no parseable frontmatter block`);

  const hasHostPair = 'host' in seat && 'host_effort' in seat;
  const hasWorkerPair = 'model' in seat && 'effort' in seat;

  if (hasHostPair && hasWorkerPair) {
    // Full split-worker shape (the four Sol-split seats today): a hosted
    // gpt/gemini seat whose config carries a genuine worker-level effort
    // distinct from the host's. Both pairs are mandatory; missing either is
    // a failure — native and hosted fields are never conflated.
    assert.strictEqual(
      fm.worker_model, seat.model,
      `agents/${seatName}.md: frontmatter worker_model "${fm.worker_model}" must equal config.model "${seat.model}"`
    );
    assert.strictEqual(
      fm.worker_effort, seat.effort,
      `agents/${seatName}.md: frontmatter worker_effort "${fm.worker_effort}" must equal config.effort "${seat.effort}"`
    );
    assert.strictEqual(
      fm.model, shortClaudeModel(seat.host),
      `agents/${seatName}.md: frontmatter model "${fm.model}" must equal config.host "${seat.host}" (short form)`
    );
    assert.strictEqual(
      fm.effort, seat.host_effort,
      `agents/${seatName}.md: frontmatter effort "${fm.effort}" must equal config.host_effort "${seat.host_effort}"`
    );
  } else if (hasHostPair) {
    // Host-only legacy shape (executor-gemini, reviewer-gemini): config
    // records only the host profile, with no separate worker-level effort
    // to check a worker_model/worker_effort pair against — the two-key
    // hosted contract (execution-plan.md section 10 / design section 5)
    // targets the gpt ladder's per-class worker split specifically, which
    // has not been extended to these seats. The host pair is still checked.
    assert.strictEqual(
      fm.model, shortClaudeModel(seat.host),
      `agents/${seatName}.md: frontmatter model "${fm.model}" must equal config.host "${seat.host}" (short form)`
    );
    assert.strictEqual(
      fm.effort, seat.host_effort,
      `agents/${seatName}.md: frontmatter effort "${fm.effort}" must equal config.host_effort "${seat.host_effort}"`
    );
  } else if (seat.hosted === true) {
    // plan-counterpart: `hosted: true` names no specific host model in the
    // config at all, so only the one comparable field (effort) is checked.
    assert.strictEqual(
      fm.effort, seat.effort,
      `agents/${seatName}.md: frontmatter effort "${fm.effort}" must equal config.effort "${seat.effort}"`
    );
  } else {
    // Native Claude seat.
    assert.strictEqual(
      fm.model, shortClaudeModel(seat.model),
      `agents/${seatName}.md: frontmatter model "${fm.model}" must equal config.model "${seat.model}" (short form)`
    );
    assert.strictEqual(
      fm.effort, seat.effort,
      `agents/${seatName}.md: frontmatter effort "${fm.effort}" must equal config.effort "${seat.effort}"`
    );
  }

  // Family attribution: whichever seat has a host at all, the family it
  // names is the model doing the intellectual work, never the Claude host.
  if (hasHostPair || seat.hosted === true) {
    assert.notStrictEqual(seat.family, 'claude', `agents/${seatName}.md: hosted seat's config.family must name the worker, not the Claude host`);
  }

  // Fallback profile: checked whenever both sides state one — a seat whose
  // frontmatter has not yet been reprofiled to carry a fallback key (e.g.
  // convergence, ahead of its Slice 4 reprofile) is not required to declare
  // one, but if it does, it must agree with the config.
  if ('fallback' in seat && 'fallback' in fm) {
    assert.strictEqual(fm.fallback, seat.fallback, `agents/${seatName}.md: frontmatter fallback "${fm.fallback}" must equal config.fallback "${seat.fallback}"`);
  }
  if ('fallback_effort' in seat && 'fallback_effort' in fm) {
    assert.strictEqual(
      fm.fallback_effort, seat.fallback_effort,
      `agents/${seatName}.md: frontmatter fallback_effort "${fm.fallback_effort}" must equal config.fallback_effort "${seat.fallback_effort}"`
    );
  }
}

// --- alias seats are unroutable ----------------------------------------------

for (const [seatName, seat] of Object.entries(config.seats)) {
  if (!('alias_of' in seat)) continue;
  assert.ok(agents.has(seatName), `alias seat "${seatName}" has no agents/${seatName}.md file`);
  for (const family of FAMILIES) {
    assert.ok(
      !config.review_routing[family].includes(seatName),
      `alias seat "${seatName}" must not appear in review_routing.${family}`
    );
  }
  if (config.tiers && config.tiers.classes) {
    for (const [className, klass] of Object.entries(config.tiers.classes)) {
      const names = (klass.candidates || []).map((c) => c.seat);
      assert.ok(!names.includes(seatName), `alias seat "${seatName}" must not appear in tiers.classes.${className}.candidates`);
    }
  }
}

// --- Sol expert and Sol apex are distinct profiles ---------------------------

assert.notDeepStrictEqual(
  config.seats['executor-sol-expert'], config.seats['executor-sol-apex'],
  'executor-sol-expert and executor-sol-apex must be distinct profiles'
);
assert.notDeepStrictEqual(
  config.seats['reviewer-sol-expert-rev'], config.seats['reviewer-sol-apex-rev'],
  'reviewer-sol-expert-rev and reviewer-sol-apex-rev must be distinct profiles'
);

console.log('test-parity: OK');
