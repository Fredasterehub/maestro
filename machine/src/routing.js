'use strict';

// maestro machine layer — seat routing (sole writer of routing/*).
//
// Routing lives in data, not prose: a dated immutable config file
// (routing/routing-YYYY-MM-DD-N.json) holds the seat table, cross-family
// review-routing rules, hard bans, and the per-provider degraded tables.
// routing/active.json is an atomic digest pointer at the dated file —
// rollback is a repoint, never a rewrite, so the exact table any past run
// used stays readable. Reads verify the digest, refuse symlinked targets,
// and refuse malformed basenames before trusting a byte of the config.
//
// Degraded modes key off state.json.preflight: a provider whose recorded
// routing token is anything but "present" is down (unknown routes as
// absent, and is never rounded up). No recorded preflight at all means no
// degradation is applied — the output says so via preflight_recorded.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { readJson, writeJson } = require('./atomic-json.js');

const ROUTING_DIRNAME = 'routing';
const ACTIVE_BASENAME = 'active.json';
const STATE_BASENAME = 'state.json';
const SCHEMA_VERSION = 1;

// The revision this codebase considers current. init writes the current
// schema at this number; revise migrates older active configs toward it,
// one revision per step, as far as shipped MIGRATIONS entries reach.
const CURRENT_ROUTING_REVISION = 6;

const FAMILIES = ['claude', 'gpt', 'gemini'];

// Strict basename-only pattern: no path separator can match, so a pointer
// naming '../x' or an absolute path is rejected by shape alone.
const DATED_CONFIG_RE = /^routing-\d{4}-\d{2}-\d{2}-\d+\.json$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

// preflight provider key → degraded sub-table name in the dated config.
const PROVIDER_MODES = [
  ['codex', 'codex_down'],
  ['gemini', 'gemini_down'],
];

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function routingDir(treeRoot) {
  return path.join(treeRoot, ROUTING_DIRNAME);
}

function sha256Of(buf) {
  return `sha256:${crypto.createHash('sha256').update(buf).digest('hex')}`;
}

// --- default table -----------------------------------------------------------

// Maestro's closed roster as a dated bet: which model sits in which seat.
// Every seat mirrors its agent definition's frontmatter, so a seat here is
// the dated record of that pairing, not a competing source of truth.
//
// This is the historical revision-1 baseline, kept verbatim: MIGRATIONS
// entries transform it forward, and buildDefaultConfig derives the current
// schema from it, so migrated trees and fresh trees can never diverge on
// shipped content.
function buildRevision1Config(dateStr) {
  return {
    schema_version: SCHEMA_VERSION,
    calibrated: dateStr,
    revision: 1,
    seats: {
      maestro: { model: 'opus-5', family: 'claude', effort: 'high' },
      scout: { model: 'sonnet-5', family: 'claude', effort: 'medium' },
      researcher: { model: 'sonnet-5', family: 'claude', effort: 'high' },
      planner: { model: 'opus-5', family: 'claude', effort: 'high' },
      'context-keeper': { model: 'opus-5', family: 'claude', effort: 'high' },
      'executor-sol': { model: 'gpt-5.6-sol', family: 'gpt', host: 'sonnet-5', host_effort: 'high' },
      'executor-claude': { model: 'opus-5', family: 'claude', effort: 'high' },
      'executor-gemini': { model: 'gemini-3.1-pro-preview', family: 'gemini', host: 'sonnet-5', host_effort: 'high' },
      'reviewer-claude': { model: 'sonnet-5', family: 'claude', effort: 'high' },
      'reviewer-sol': { model: 'gpt-5.6-sol', family: 'gpt', host: 'sonnet-5', host_effort: 'medium', scope: 'scoped' },
      'reviewer-gemini': { model: 'gemini-3.1-pro-preview', family: 'gemini', host: 'sonnet-5', host_effort: 'medium', scope: 'scoped' },
      convergence: { model: 'fable-5', fallback: 'opus-5', effort: 'high' },
      'plan-counterpart': { family: 'gpt', hosted: true, effort: 'high' },
      crystallizer: { model: 'sonnet-5', family: 'claude', effort: 'high' },
      'handoff-recorder': { model: 'sonnet-5', family: 'claude', effort: 'medium' },
      'fleet-medic': { model: 'sonnet-5', family: 'claude', effort: 'medium' },
    },
    review_routing: {
      claude: ['reviewer-sol', 'reviewer-gemini'],
      gpt: ['reviewer-claude', 'reviewer-gemini'],
      gemini: ['reviewer-claude', 'reviewer-sol'],
    },
    bans: {
      haiku: 'never',
      liaison_implements: 'never',
      review_floor_scale_down: 'never',
      runtime_agent_creation: 'never',
    },
    degraded: {
      codex_down: {
        notice:
          'Codex CLI is unavailable: gpt implementation/review seats run on same-family Claude substitutes (cross-family error decorrelation is reduced for this work); the plan challenge reroutes to the Gemini seat to stay cross-family.',
        seats: {
          'executor-sol': 'executor-claude',
          'reviewer-sol': 'reviewer-claude',
          // Gemini first: keeps the plan challenge cross-family (the whole
          // point of the counterpart). Claude is the last resort when both
          // non-Claude providers are down, and full rigor is unavailable
          // there — a same-family rival draft buys nothing.
          'plan-counterpart': 'reviewer-gemini',
        },
        review_routing: {
          claude: ['reviewer-gemini'],
          gpt: ['reviewer-claude', 'reviewer-gemini'],
          gemini: ['reviewer-claude'],
        },
      },
      'fable-unavailable': {
        // Not preflight-driven (Claude/Fable has no self-probe the way
        // codex/gemini do), so this table never enters PROVIDER_MODES and is
        // never composed automatically by effectiveRouting. It documents the
        // resolution instead: the convergence seat does not hand off to a
        // substitute seat, it drops to the model named in its own
        // `fallback` field — so `seats` stays empty by design.
        notice:
          'Fable 5 is unavailable, so the convergence seat runs on its own recorded fallback model (opus-5) rather than a substitute seat; the plan-counterpart pairing is unaffected.',
        seats: {},
      },
      gemini_down: {
        notice:
          'Gemini CLI is unavailable, so gemini seats run on same-family Claude substitutes; cross-family error decorrelation is reduced for this work.',
        seats: {
          'executor-gemini': 'executor-claude',
          'reviewer-gemini': 'reviewer-claude',
        },
        review_routing: {
          claude: ['reviewer-sol'],
          gpt: ['reviewer-claude'],
          gemini: ['reviewer-claude', 'reviewer-sol'],
        },
      },
    },
  };
}

// --- migrations --------------------------------------------------------------

// MIGRATIONS[n] transforms revision n+1's config into revision n+2's — a
// plain ordered array, not a migration engine. Each entry is deterministic
// (no clocks, no environment), pure (clones its input), idempotent at its
// own boundary (running it on its own output changes nothing), and its
// output must pass validateRoutingConfig before revise will write it.

// r1 -> r2: split the Sol seat by class. The single executor-sol /
// reviewer-sol profiles become per-class seats mirroring their agent-file
// frontmatter; the old names stay in the table as migration aliases
// (alias_of), which are never routable — review rows repoint to the
// expert successors so no row names an alias.
function migrateSolSplit(config) {
  const out = JSON.parse(JSON.stringify(config));
  const added = {
    'executor-sol-expert': { model: 'gpt-5.6-sol', family: 'gpt', effort: 'medium', host: 'sonnet-5', host_effort: 'medium' },
    'executor-sol-apex': { model: 'gpt-5.6-sol', family: 'gpt', effort: 'high', host: 'sonnet-5', host_effort: 'high' },
    'reviewer-sol-expert-rev': { model: 'gpt-5.6-sol', family: 'gpt', effort: 'medium', host: 'sonnet-5', host_effort: 'medium' },
    'reviewer-sol-apex-rev': { model: 'gpt-5.6-sol', family: 'gpt', effort: 'high', host: 'sonnet-5', host_effort: 'high' },
  };
  for (const [name, seat] of Object.entries(added)) {
    out.seats[name] = seat;
  }
  out.seats['executor-sol'].alias_of = 'executor-sol-expert';
  out.seats['reviewer-sol'].alias_of = 'reviewer-sol-expert-rev';

  const repoint = (list) => list.map((seat) => (seat === 'reviewer-sol' ? 'reviewer-sol-expert-rev' : seat));
  for (const family of FAMILIES) {
    out.review_routing[family] = repoint(out.review_routing[family]);
  }
  for (const table of Object.values(out.degraded)) {
    if (isPlainObject(table.review_routing)) {
      for (const family of FAMILIES) {
        if (Array.isArray(table.review_routing[family])) {
          table.review_routing[family] = repoint(table.review_routing[family]);
        }
      }
    }
  }

  out.revision = 2;
  return out;
}

const MIGRATIONS = [migrateSolSplit];

// The current schema is the revision-1 baseline pushed through every
// shipped migration, stamped at CURRENT_ROUTING_REVISION — init derives it
// rather than hand-maintaining a second table, so a fresh tree can never
// carry a modern schema mislabeled revision 1. Until all migrations up to
// CURRENT_ROUTING_REVISION have shipped, the stamp is ahead of the shipped
// content by design: each later migration lands here automatically.
function buildDefaultConfig(dateStr) {
  let config = buildRevision1Config(dateStr);
  for (const migrate of MIGRATIONS) {
    config = migrate(config);
  }
  config.revision = CURRENT_ROUTING_REVISION;
  return config;
}

// --- read boundary -----------------------------------------------------------

function checkReviewRouting(table, label, seats, errors) {
  if (!isPlainObject(table)) {
    errors.push(`${label} must be an object`);
    return;
  }
  for (const family of FAMILIES) {
    const list = table[family];
    if (!Array.isArray(list) || list.some((s) => typeof s !== 'string' || s === '')) {
      errors.push(`${label}.${family} must be an array of seat-name strings`);
      continue;
    }
    for (const seatName of list) {
      if (!Object.prototype.hasOwnProperty.call(seats, seatName)) {
        errors.push(`${label}.${family} names unknown seat "${seatName}"`);
      } else if (isPlainObject(seats[seatName]) && 'alias_of' in seats[seatName]) {
        // Alias seats exist only so old names keep resolving across a
        // migration — routing a review to one would dodge the profile split.
        errors.push(`${label}.${family} names alias seat "${seatName}", which is never routable`);
      }
    }
  }
}

// Minimal but non-negotiable shape checks at the read boundary: revision,
// seats, review_routing, bans, and degraded sub-tables never go unchecked.
function validateRoutingConfig(config) {
  if (!isPlainObject(config)) {
    return { ok: false, errors: ['routing config must be a JSON object'] };
  }
  const errors = [];
  if (config.schema_version !== SCHEMA_VERSION) errors.push(`schema_version must be ${SCHEMA_VERSION}`);
  if (!Number.isInteger(config.revision)) errors.push('revision must be an integer');
  if (!isPlainObject(config.seats)) errors.push('seats must be an object');
  if (!isPlainObject(config.bans)) errors.push('bans must be an object');
  const seats = isPlainObject(config.seats) ? config.seats : {};
  // alias_of is a migration pointer: it must name a real seat that is not
  // itself an alias, so alias resolution is always a single hop.
  for (const [seatName, seat] of Object.entries(seats)) {
    if (!isPlainObject(seat) || !('alias_of' in seat)) continue;
    const target = seat.alias_of;
    if (typeof target !== 'string' || target === '') {
      errors.push(`seats.${seatName}.alias_of must be a non-empty seat-name string`);
    } else if (!Object.prototype.hasOwnProperty.call(seats, target)) {
      errors.push(`seats.${seatName}.alias_of names unknown seat "${target}"`);
    } else if (isPlainObject(seats[target]) && 'alias_of' in seats[target]) {
      errors.push(`seats.${seatName}.alias_of names "${target}", which is itself an alias`);
    }
  }
  checkReviewRouting(config.review_routing, 'review_routing', seats, errors);
  // A tiers block arrives at a later revision; where one is present, its
  // candidates are routable seats by definition — an alias there is the
  // same defect as an alias in a review row.
  if (isPlainObject(config.tiers) && isPlainObject(config.tiers.classes)) {
    for (const [className, klass] of Object.entries(config.tiers.classes)) {
      if (!isPlainObject(klass) || !Array.isArray(klass.candidates)) continue;
      for (const candidate of klass.candidates) {
        if (!isPlainObject(candidate) || typeof candidate.seat !== 'string') continue;
        const seat = seats[candidate.seat];
        if (isPlainObject(seat) && 'alias_of' in seat) {
          errors.push(`tiers.classes.${className} names alias seat "${candidate.seat}", which is never routable`);
        }
      }
    }
  }
  if (!isPlainObject(config.degraded)) {
    errors.push('degraded must be an object');
  } else {
    // Every degraded sub-table gets the same shape check (notice, seats),
    // whether or not it is wired into automatic preflight-driven
    // composition — a hand-shaped degraded table is a read-boundary risk
    // like any other.
    for (const [modeName, table] of Object.entries(config.degraded)) {
      if (!isPlainObject(table)) {
        errors.push(`degraded.${modeName} must be an object`);
        continue;
      }
      if (typeof table.notice !== 'string' || table.notice.trim() === '') {
        errors.push(`degraded.${modeName}.notice must be a non-empty string`);
      }
      if (!isPlainObject(table.seats)) {
        errors.push(`degraded.${modeName}.seats must be an object`);
      } else {
        for (const [from, to] of Object.entries(table.seats)) {
          if (typeof to !== 'string' || !Object.prototype.hasOwnProperty.call(seats, to)) {
            errors.push(`degraded.${modeName}.seats maps "${from}" to unknown seat "${to}"`);
          }
        }
      }
    }
    // Only the preflight-driven modes feed composeReviewRouting, so only
    // those must additionally carry a review_routing override.
    for (const [, modeName] of PROVIDER_MODES) {
      const table = config.degraded[modeName];
      if (isPlainObject(table)) {
        checkReviewRouting(table.review_routing, `degraded.${modeName}.review_routing`, seats, errors);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

// A symlinked dated config lets bytes change out from under a digest without
// touching the file the pointer names — refused outright.
function refuseSymlink(targetPath, filename) {
  let lst;
  try {
    lst = fs.lstatSync(targetPath);
  } catch (err) {
    if (err.code === 'ENOENT') return; // the caller's own read reports the missing file
    throw err;
  }
  if (lst.isSymbolicLink()) {
    throw new Error(`routing: dated config "${filename}" is a symlink, which is not a permitted target`);
  }
}

// Loads the dated config the pointer names. Refuses — never falls back —
// on a missing pointer, malformed basename, missing/invalid digest, digest
// mismatch, symlinked target, or a config failing shape validation: each is
// a routing-directory defect, not a state to paper over.
function loadRouting(treeRoot) {
  const dir = routingDir(treeRoot);
  const pointerPath = path.join(dir, ACTIVE_BASENAME);
  const missing = Symbol('missing');
  const pointer = readJson(pointerPath, missing);
  if (pointer === missing) {
    throw new Error(`routing: no active pointer at ${pointerPath} — run routing.js init first`);
  }
  if (!isPlainObject(pointer) || pointer.schema_version !== SCHEMA_VERSION) {
    throw new Error(`routing: active pointer at ${pointerPath} must be an object with schema_version ${SCHEMA_VERSION}`);
  }
  const activeFile = pointer.active_config;
  if (typeof activeFile !== 'string' || !DATED_CONFIG_RE.test(activeFile)) {
    throw new Error(
      `routing: active pointer names "${activeFile}", which is not a valid routing-YYYY-MM-DD-N.json basename`
    );
  }
  if (typeof pointer.digest !== 'string' || !DIGEST_RE.test(pointer.digest)) {
    throw new Error(`routing: active pointer at ${pointerPath} is missing a valid "sha256:<hex>" digest`);
  }

  const configPath = path.join(dir, activeFile);
  refuseSymlink(configPath, activeFile);

  let raw;
  try {
    raw = fs.readFileSync(configPath);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`routing: active pointer targets "${activeFile}", but ${configPath} does not exist`);
    }
    throw err;
  }
  const actualDigest = sha256Of(raw);
  if (actualDigest !== pointer.digest) {
    throw new Error(
      `routing: digest mismatch for "${activeFile}" — pointer records ${pointer.digest}, disk content hashes to ${actualDigest}`
    );
  }

  let config;
  try {
    config = JSON.parse(raw.toString('utf8'));
  } catch (err) {
    throw new Error(`routing: dated config "${activeFile}" is not valid JSON: ${err.message}`);
  }
  const { ok, errors } = validateRoutingConfig(config);
  if (!ok) {
    throw new Error(`routing: dated config "${activeFile}" failed shape validation: ${errors.join('; ')}`);
  }
  return { config, activeFile };
}

// --- degraded-mode composition -----------------------------------------------

function readPreflight(treeRoot) {
  const state = readJson(path.join(treeRoot, STATE_BASENAME), null);
  if (!isPlainObject(state) || !isPlainObject(state.preflight)) {
    return { recorded: false, modes: [] };
  }
  const perProvider = isPlainObject(state.preflight.per_provider) ? state.preflight.per_provider : {};
  const modes = [];
  for (const [provider, modeName] of PROVIDER_MODES) {
    const entry = perProvider[provider];
    // Routing token discipline: only an explicit "present" keeps the
    // provider up; absent, unknown, or an unrecorded provider all route as
    // down within a recorded preflight.
    const routingToken = isPlainObject(entry) ? entry.routing : undefined;
    if (routingToken !== 'present') {
      modes.push(modeName);
    }
  }
  return { recorded: true, modes };
}

// Effective review routing under the active degraded modes: each family's
// base list survives filtered through every active mode's override, order
// preserved. With both providers down the claude row goes empty — which
// review-for refuses rather than scale the review floor down.
function composeReviewRouting(config, modes) {
  const effective = {};
  for (const family of FAMILIES) {
    let list = config.review_routing[family];
    for (const modeName of modes) {
      const override = config.degraded[modeName].review_routing[family];
      list = list.filter((seat) => override.includes(seat));
    }
    effective[family] = list;
  }
  return effective;
}

function effectiveRouting(treeRoot) {
  const { config, activeFile } = loadRouting(treeRoot);
  const { recorded, modes } = readPreflight(treeRoot);
  const substitutions = {};
  const notices = [];
  for (const modeName of modes) {
    Object.assign(substitutions, config.degraded[modeName].seats);
    notices.push(config.degraded[modeName].notice);
  }
  // Chain-resolve: with several providers down, a substitute can itself be
  // substituted (plan-counterpart -> reviewer-gemini -> reviewer-claude).
  // Consumers get a live seat, never a dead intermediate.
  for (const seatName of Object.keys(substitutions)) {
    const seen = new Set([seatName]);
    let target = substitutions[seatName];
    while (Object.prototype.hasOwnProperty.call(substitutions, target) && !seen.has(target)) {
      seen.add(target);
      target = substitutions[target];
    }
    substitutions[seatName] = target;
  }
  return {
    schema_version: SCHEMA_VERSION,
    active_config: activeFile,
    revision: config.revision,
    calibrated: config.calibrated,
    preflight_recorded: recorded,
    degraded_modes: modes,
    notices,
    seats: config.seats,
    seat_substitutions: substitutions,
    review_routing: composeReviewRouting(config, modes),
    bans: config.bans,
    base_review_routing: config.review_routing,
  };
}

// --- commands ----------------------------------------------------------------

function init(treeRoot) {
  let stat;
  try {
    stat = fs.statSync(treeRoot);
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(`routing: tree root does not exist: ${treeRoot}`);
    throw err;
  }
  if (!stat.isDirectory()) {
    throw new Error(`routing: tree root is not a directory: ${treeRoot}`);
  }

  const dir = routingDir(treeRoot);
  const pointerPath = path.join(dir, ACTIVE_BASENAME);
  if (fs.existsSync(pointerPath)) {
    throw new Error(`routing: already initialized — active pointer exists at ${pointerPath}`);
  }
  const dateStr = new Date().toISOString().slice(0, 10);
  const filename = `routing-${dateStr}-1.json`;
  const configPath = path.join(dir, filename);
  if (fs.existsSync(configPath)) {
    // Dated configs are immutable once written; init never overwrites one.
    throw new Error(`routing: dated config ${configPath} already exists and is immutable`);
  }

  writeJson(configPath, buildDefaultConfig(dateStr));
  // Digest computed from the exact bytes that landed on disk, so the
  // pointer certifies the file as-written, not the in-memory value.
  const digest = sha256Of(fs.readFileSync(configPath));
  writeJson(pointerPath, {
    schema_version: SCHEMA_VERSION,
    active_config: filename,
    digest,
  });
  return { active_config: filename, digest };
}

// First free routing-YYYY-MM-DD-N.json basename for the day: dated configs
// are immutable, so a collision increments N rather than overwriting — a
// re-upgrade after a rollback lands beside the files it wrote the first time.
function nextDatedFilename(dir, dateStr) {
  for (let n = 1; ; n++) {
    const filename = `routing-${dateStr}-${n}.json`;
    if (!fs.existsSync(path.join(dir, filename))) return filename;
  }
}

// Migrates the active revision stepwise toward CURRENT_ROUTING_REVISION —
// skipped intermediates are impossible because each step applies exactly one
// MIGRATIONS entry and writes one dated file. active.json is repointed
// exactly once, at the end, so a failure mid-sequence leaves the
// not-yet-repointed active config authoritative and reports any orphan
// files already written. Rollback is repointing active.json at an older
// dated file; a re-upgrade afterwards re-runs the remaining migrations from
// whatever revision the pointer names.
function revise(treeRoot) {
  const { config, activeFile } = loadRouting(treeRoot);
  const from = config.revision;
  if (from === CURRENT_ROUTING_REVISION) {
    return {
      noop: true,
      message: `already at revision ${CURRENT_ROUTING_REVISION} (${activeFile}) — nothing to migrate`,
    };
  }
  if (from < 1 || from > CURRENT_ROUTING_REVISION) {
    throw new Error(
      `routing: active config "${activeFile}" records revision ${from}, outside the known range ` +
        `1..${CURRENT_ROUTING_REVISION} — refusing to migrate a malformed source revision`
    );
  }

  const dir = routingDir(treeRoot);
  const dateStr = new Date().toISOString().slice(0, 10);
  const steps = [];
  let current = config;
  let revision = from;
  try {
    while (revision < CURRENT_ROUTING_REVISION && MIGRATIONS[revision - 1]) {
      const next = MIGRATIONS[revision - 1](JSON.parse(JSON.stringify(current)));
      if (next.revision !== revision + 1) {
        throw new Error(`migration from revision ${revision} labeled its output ${next.revision}, expected ${revision + 1}`);
      }
      const { ok, errors } = validateRoutingConfig(next);
      if (!ok) {
        throw new Error(`migration to revision ${revision + 1} produced an invalid config: ${errors.join('; ')}`);
      }
      const filename = nextDatedFilename(dir, dateStr);
      const configPath = path.join(dir, filename);
      writeJson(configPath, next);
      // Digest from the exact bytes on disk, same discipline as init: the
      // pointer will certify the file as-written, not the in-memory value.
      const digest = sha256Of(fs.readFileSync(configPath));
      steps.push({ file: filename, revision: revision + 1, digest });
      current = next;
      revision += 1;
    }
  } catch (err) {
    const orphans = steps.map((s) => s.file);
    throw new Error(
      `routing: revise failed at revision ${revision}: ${err.message} — active.json still points at ` +
        `"${activeFile}", which stays authoritative` +
        (orphans.length > 0 ? `; orphan dated file(s) written but never activated: ${orphans.join(', ')}` : '')
    );
  }

  if (steps.length === 0) {
    return {
      noop: true,
      message:
        `no migration is shipped from revision ${from} yet — active config ${activeFile} stays ` +
        `authoritative (current is ${CURRENT_ROUTING_REVISION})`,
    };
  }

  const last = steps[steps.length - 1];
  writeJson(path.join(dir, ACTIVE_BASENAME), {
    schema_version: SCHEMA_VERSION,
    active_config: last.file,
    digest: last.digest,
  });
  return {
    from,
    to: last.revision,
    current: last.revision === CURRENT_ROUTING_REVISION,
    steps,
    active_config: last.file,
    digest: last.digest,
  };
}

function reviewFor(treeRoot, authorFamily) {
  if (!FAMILIES.includes(authorFamily)) {
    throw new Error(`routing: author family must be one of ${FAMILIES.join(', ')} (got "${authorFamily}")`);
  }
  const effective = effectiveRouting(treeRoot);
  const list = effective.review_routing[authorFamily];
  if (list.length === 0) {
    throw new Error(
      `routing: no cross-family reviewer is available for ${authorFamily}-authored work under degraded modes ` +
        `[${effective.degraded_modes.join(', ')}] — review_floor_scale_down is banned, so this work waits`
    );
  }
  const rerouted =
    JSON.stringify(list) !== JSON.stringify(effective.base_review_routing[authorFamily]);
  return { seat: list[0], rerouted, notices: effective.notices };
}

// --- CLI --------------------------------------------------------------------

const HELP = `routing.js — maestro seat routing (sole writer of routing/*)

usage:
  routing.js init <treeRoot>
  routing.js revise <treeRoot>
  routing.js active <treeRoot>
  routing.js review-for <treeRoot> <author_family>

commands:
  init        writes the dated immutable default config
              routing/routing-YYYY-MM-DD-1.json (seat table, review-routing
              rules, bans, codex_down/gemini_down/fable-unavailable degraded
              tables) at the current schema revision, plus the digest
              pointer routing/active.json. Refuses when a pointer or the
              dated file already exists — dated configs are immutable;
              routing changes by adding a new dated file and repointing.
  revise      migrates the active config stepwise toward the current
              revision: one shipped migration and one new dated immutable
              file per step, active.json repointed exactly once at the end.
              Already-current is an explicit no-op; a malformed source
              revision is refused; a failure mid-sequence leaves active.json
              untouched (the active config stays authoritative) and reports
              any orphan dated files. Rollback is repointing active.json at
              an older dated file; revise afterwards re-runs the remaining
              migrations.
  active      loads the dated config through the digest-verified pointer
              (refusing digest mismatch, symlinked target, or malformed
              basename), applies the degraded sub-tables keyed off
              state.json.preflight provider modes (a provider routes as up
              only when its routing token is exactly "present"; no recorded
              preflight applies no degradation), and prints the effective
              routing JSON: seats, seat_substitutions, review_routing, bans,
              degraded_modes, notices.
  review-for  prints the routed reviewer seat for work authored by
              <author_family> (claude | gpt | gemini), honoring degraded
              modes. When degradation rerouted the choice, each mode's
              decorrelation-cost notice prints to stderr so the caller can
              carry it into the affected envelope's risks. An empty reviewer
              row (both providers down, claude-authored work) is refused:
              the review floor never scales down.

Exits 0 on success; every refusal prints to stderr and exits 1.
`;

const COMMAND_ARITY = { init: 0, revise: 0, active: 0, 'review-for': 1 };

function parseArgv(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    return { help: true };
  }
  const [command, treeRoot, ...rest] = argv;
  if (command === undefined) {
    return { error: 'a command is required' };
  }
  if (!Object.prototype.hasOwnProperty.call(COMMAND_ARITY, command)) {
    return { error: `unknown command "${command}"` };
  }
  if (typeof treeRoot !== 'string' || treeRoot === '') {
    return { error: `${command} requires a <treeRoot> argument` };
  }
  if (rest.length !== COMMAND_ARITY[command]) {
    return {
      error:
        rest.length > COMMAND_ARITY[command]
          ? `unexpected extra argument(s): ${rest.slice(COMMAND_ARITY[command]).join(' ')}`
          : `${command} is missing required argument(s)`,
    };
  }
  return { command, treeRoot, args: rest };
}

function main(argv) {
  const parsed = parseArgv(argv);
  if (parsed.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  if (parsed.error) {
    process.stderr.write(`routing.js: ${parsed.error}\n${HELP}`);
    process.exit(1);
  }

  try {
    const { command, treeRoot, args } = parsed;
    if (command === 'init') {
      process.stdout.write(JSON.stringify(init(treeRoot), null, 2) + '\n');
    } else if (command === 'revise') {
      const result = revise(treeRoot);
      if (result.noop) {
        process.stdout.write(`routing.js: ${result.message}\n`);
      } else {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      }
    } else if (command === 'active') {
      const effective = effectiveRouting(treeRoot);
      delete effective.base_review_routing; // internal comparison surface, not part of the printed contract
      process.stdout.write(JSON.stringify(effective, null, 2) + '\n');
    } else if (command === 'review-for') {
      const { seat, rerouted, notices } = reviewFor(treeRoot, args[0]);
      if (rerouted) {
        for (const notice of notices) {
          process.stderr.write(`routing.js: ${notice}\n`);
        }
      }
      process.stdout.write(seat + '\n');
    }
    process.exit(0);
  } catch (err) {
    process.stderr.write(`routing.js: ${err.message}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = {
  init,
  revise,
  loadRouting,
  effectiveRouting,
  reviewFor,
  validateRoutingConfig,
  buildDefaultConfig,
  CURRENT_ROUTING_REVISION,
  MIGRATIONS,
  DATED_CONFIG_RE,
  ACTIVE_BASENAME,
  ROUTING_DIRNAME,
  FAMILIES,
};
