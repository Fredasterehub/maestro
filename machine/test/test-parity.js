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

// Recursive, extension-agnostic walk — the haiku ban is "no file anywhere
// under agents/", not "no .md file at the top level of agents/".
function walkFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(p));
    else out.push(p);
  }
  return out;
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

// The family an actual worker model belongs to, derived structurally from
// the model name itself (never from a maintained lookup table that could
// drift from routing.js's own seat data). Used to check that a hosted
// seat's config.family names the worker doing the intellectual work, not
// the Claude family of whatever hosts it.
function expectedFamilyForModel(model) {
  if (typeof model !== 'string') return undefined;
  if (model.startsWith('gpt-')) return 'gpt';
  if (model.startsWith('gemini-')) return 'gemini';
  if (model.startsWith('opus-') || model.startsWith('sonnet-') || model.startsWith('fable-')) return 'claude';
  return undefined;
}

// The dormant gpt-ladder seats were checked here against a hardcoded
// transcription of the design's tables while config.seats did not name them.
// The r4->r5 migration seats all three, so the config-driven loop below now
// reaches them on the config's own terms — which is what that table was
// standing in for, and the condition its own comment set for retiring it.
// Dormant is a lane state: an unrouted seat is checked exactly like a routed
// one, because the config carries it either way.

// --- load config + agent files ------------------------------------------------

const config = buildDefaultConfig('2026-08-07'); // date is cosmetic (calibrated field) — content is what matters
{
  const { ok, errors } = validateRoutingConfig(config);
  assert.strictEqual(ok, true, `active routing config fails its own shape validation: ${errors.join('; ')}`);
}
const agents = loadAgentFiles();

// Violations accumulate here rather than aborting at the first mismatch —
// the whole point of a parity sweep is to name every failing seat in one
// run, not just the first one alphabetically or positionally reached.
const violations = [];
function check(condition, message) {
  if (!condition) violations.push(message);
}

// --- no haiku token anywhere under agents/ -----------------------------------

for (const filePath of walkFiles(AGENTS_DIR)) {
  const text = fs.readFileSync(filePath, 'utf8');
  assert.ok(!/haiku/i.test(text), `${path.relative(AGENTS_DIR, filePath)} contains the banned "haiku" token (${filePath})`);
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
// for frontmatter parity. A file shipped for a seat the config carries no
// entry for at all is not itself a parity failure; only a config seat with
// no matching, exact file is.

for (const [seatName, seat] of Object.entries(config.seats)) {
  if ('alias_of' in seat) continue; // aliases: existence only, checked separately below

  // No existence guard here: the assert above already aborts the run on any
  // config seat without a file, so an absent entry is unreachable.
  const fm = agents.get(seatName).frontmatter;
  if (!fm) {
    violations.push(`${seatName}: agents/${seatName}.md has no parseable frontmatter block`);
    continue;
  }

  // The map above is keyed by filename, but the agent runtime resolves a
  // seat by the frontmatter `name` field: a file that exists under one
  // identity and registers under another satisfies "every routed seat has a
  // file" in the letter only, and fails at dispatch time rather than here.
  check(
    fm.name === seatName,
    `${seatName}: frontmatter name "${fm.name}" must equal the seat name its filename agents/${seatName}.md declares`
  );

  const hasHostPair = 'host' in seat && 'host_effort' in seat;
  const hasWorkerEffort = 'effort' in seat;

  if (hasHostPair) {
    // Hosted gpt/gemini seat. worker_model <-> config.model is checked
    // unconditionally: config always names the actual worker model for a
    // hosted seat, so there is always something to compare against — a
    // hosted seat missing worker_model in frontmatter is a real gap, not a
    // reason to skip the check (execution-plan.md §10; brief: "a hosted
    // seat missing either pair is a failure").
    check(
      fm.worker_model === seat.model,
      `${seatName}: frontmatter worker_model "${fm.worker_model}" must equal config.model "${seat.model}"`
    );
    // worker_effort <-> config.effort is checked only when config actually
    // records a worker-level effort distinct from the host's — today that is
    // every hosted seat except plan-counterpart (§10's under-specified
    // exception, handled in its own arm below). A hosted seat whose config
    // carries no top-level `effort` would have nothing to compare
    // frontmatter's worker_effort against; enforcing it there would assert
    // against nothing.
    if (hasWorkerEffort) {
      check(
        fm.worker_effort === seat.effort,
        `${seatName}: frontmatter worker_effort "${fm.worker_effort}" must equal config.effort "${seat.effort}"`
      );
    } else if ('worker_effort' in fm) {
      // Symmetric with the fallback arms below: config recording no worker
      // effort is a reason to skip the comparison, never a licence for the
      // prompt to carry an arbitrary one unchallenged.
      check(false, `${seatName}: frontmatter declares worker_effort "${fm.worker_effort}" with no counterpart in config`);
    }
    check(
      fm.model === shortClaudeModel(seat.host),
      `${seatName}: frontmatter model "${fm.model}" must equal config.host "${seat.host}" (short form)`
    );
    check(
      fm.effort === seat.host_effort,
      `${seatName}: frontmatter effort "${fm.effort}" must equal config.host_effort "${seat.host_effort}"`
    );
  } else if (seat.hosted === true) {
    // plan-counterpart: `hosted: true` names no host model and no worker
    // model in config at all (routing.js's config entry is
    // { family: 'gpt', hosted: true, effort: 'high' } — under-specified
    // relative to the host/host_effort shape every other hosted seat
    // carries). The only field with a genuine counterpart on both sides is
    // `effort`, and even that comparison is provisional: frontmatter's
    // `effort` here describes the Sonnet host, while config's `effort` is
    // undifferentiated (neither clearly host- nor worker-scoped) — it only
    // reads correct today because both happen to be `high`. Reported, not
    // silently trusted: if design §5's host-tiering-by-worker ever reaches
    // this seat, config needs host/host_effort fields before this check can
    // mean anything stronger (out of this slice's scope — machine/src/ is
    // not touched here).
    check(
      fm.effort === seat.effort,
      `${seatName}: frontmatter effort "${fm.effort}" must equal config.effort "${seat.effort}" (provisional — see comment above)`
    );
  } else {
    // Native Claude seat.
    check(
      fm.model === shortClaudeModel(seat.model),
      `${seatName}: frontmatter model "${fm.model}" must equal config.model "${seat.model}" (short form)`
    );
    check(
      fm.effort === seat.effort,
      `${seatName}: frontmatter effort "${fm.effort}" must equal config.effort "${seat.effort}"`
    );
  }

  // Family attribution: the config's family must name the model actually
  // doing the intellectual work — for a hosted seat the worker rather than
  // the Claude host, for a native seat its own model. Checked for every
  // routed seat that declares a family, not only the hosted ones: `family`
  // is the key review_routing reads to pick a cross-family reviewer, so a
  // mislabeled native seat breaks the same law a mislabeled hosted seat
  // does. A seat declaring no family at all (convergence) is outside this
  // check's reach — requiring the key is a routing.js change, not a test
  // change, and belongs to the slice that owns that file.
  if ('family' in seat) {
    if ('model' in seat) {
      const expectedFamily = expectedFamilyForModel(seat.model);
      // A model name matching no known prefix is a loud failure, never a
      // silently skipped check: the prefix list is a maintained lookup like
      // any other, and failing open here would reopen the mislabeling hole
      // with no signal that the strong check had stopped running.
      check(
        expectedFamily !== undefined,
        `${seatName}: config.model "${seat.model}" matches no family prefix expectedFamilyForModel knows, so config.family "${seat.family}" cannot be verified — teach the helper the new prefix rather than leaving the family unchecked`
      );
      if (expectedFamily !== undefined) {
        check(
          seat.family === expectedFamily,
          `${seatName}: config.family "${seat.family}" must name the model "${seat.model}"'s family ("${expectedFamily}")`
        );
      }
    } else {
      // plan-counterpart: config names no model at all, so there is nothing
      // to derive from. The weakest defensible floor — a hosted seat's
      // family is at least not the Claude host's — until config carries a
      // worker model here (machine/src/, out of this slice's scope).
      check(
        seat.family !== 'claude',
        `${seatName}: config names no model to derive a family from; a hosted seat's config.family must name the worker, not the Claude host`
      );
    }
  }

  // Fallback profile: a config-declared fallback must be stated in
  // frontmatter — the direction that actually matters, since a fallback
  // silently absent from a seat's own prompt is invisible drift, while a
  // frontmatter fallback with no config counterpart (checked in the `else`
  // arm) is at least loud in the other direction.
  if ('fallback' in seat) {
    check(
      fm.fallback === seat.fallback,
      `${seatName}: config.fallback "${seat.fallback}" must be stated in frontmatter as fallback (got "${fm.fallback}")`
    );
  } else if ('fallback' in fm) {
    check(false, `${seatName}: frontmatter declares fallback "${fm.fallback}" with no counterpart in config`);
  }
  if ('fallback_effort' in seat) {
    check(
      fm.fallback_effort === seat.fallback_effort,
      `${seatName}: config.fallback_effort "${seat.fallback_effort}" must be stated in frontmatter as fallback_effort (got "${fm.fallback_effort}")`
    );
  } else if ('fallback_effort' in fm) {
    check(false, `${seatName}: frontmatter declares fallback_effort "${fm.fallback_effort}" with no counterpart in config`);
  }
}

// --- alias seats are unroutable ----------------------------------------------

for (const [seatName, seat] of Object.entries(config.seats)) {
  if (!('alias_of' in seat)) continue;
  check(agents.has(seatName), `alias seat "${seatName}" has no agents/${seatName}.md file`);
  for (const family of FAMILIES) {
    // One ladder per class from revision 4 on, one flat row per family before
    // it: an alias is unroutable from every row of either shape.
    const rows = config.review_routing[family];
    for (const [klass, row] of Array.isArray(rows) ? [[null, rows]] : Object.entries(rows)) {
      check(
        !row.includes(seatName),
        `alias seat "${seatName}" must not appear in review_routing.${family}${klass === null ? '' : `.${klass}`}`
      );
    }
  }
  if (config.tiers && config.tiers.classes) {
    for (const [className, klass] of Object.entries(config.tiers.classes)) {
      const names = (klass.candidates || []).map((c) => c.seat);
      check(!names.includes(seatName), `alias seat "${seatName}" must not appear in tiers.classes.${className}.candidates`);
    }
  }
}

// --- Sol expert and Sol apex are distinct profiles ---------------------------
//
// Compared on (model, effort) specifically — the profile §10/§18 mean —
// rather than the whole seat object, so a cosmetic field difference (e.g.
// `scope`) can never stand in for a genuine profile split, and collapsing
// the two seats' actual effort while leaving an unrelated field different
// is caught rather than waved through.
function profileTuple(seat) {
  return `${seat.model}|${seat.effort}`;
}

check(
  profileTuple(config.seats['executor-sol-expert']) !== profileTuple(config.seats['executor-sol-apex']),
  'executor-sol-expert and executor-sol-apex must be distinct (model, effort) profiles'
);
check(
  profileTuple(config.seats['reviewer-sol-expert-rev']) !== profileTuple(config.seats['reviewer-sol-apex-rev']),
  'reviewer-sol-expert-rev and reviewer-sol-apex-rev must be distinct (model, effort) profiles'
);

// --- frontmatter scalars stay parseable YAML ---------------------------------
//
// A plain (unquoted) single-line scalar carrying ": " is a YAML mapping, not
// prose: the whole frontmatter block then fails to parse, and every consumer
// that reads these files as YAML — the harness that loads the seat, not this
// deliberately forgiving reader — sees no seat at all. Long prose values
// belong in a block scalar, which needs no escaping and cannot reintroduce
// the defect.
for (const filePath of walkFiles(AGENTS_DIR)) {
  if (!filePath.endsWith('.md')) continue;
  const m = fs.readFileSync(filePath, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) continue;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):[ \t](.*)$/);
    if (!kv) continue;
    const value = kv[2].trim();
    if (value === '' || value.startsWith('|') || value.startsWith('>')) continue;
    if (/^["'].*["']$/.test(value)) continue;
    check(
      !value.includes(': '),
      `${path.basename(filePath)}: frontmatter key "${kv[1]}" is a plain scalar containing ": " — quote it or make it a block scalar`
    );
  }
}

// One terminal assertion over every section above, so a mismatch in seat
// parity can no longer suppress the alias and distinctness results in the
// same run — which is what the accumulator was introduced to promise.
assert.strictEqual(violations.length, 0, `parity violations (${violations.length}):\n${violations.join('\n')}`);

console.log('test-parity: OK');
