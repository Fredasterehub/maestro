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
function buildDefaultConfig(dateStr) {
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
  checkReviewRouting(config.review_routing, 'review_routing', seats, errors);
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
  routing.js active <treeRoot>
  routing.js review-for <treeRoot> <author_family>

commands:
  init        writes the dated immutable default config
              routing/routing-YYYY-MM-DD-1.json (seat table, review-routing
              rules, bans, codex_down/gemini_down/fable-unavailable degraded
              tables) and the digest pointer routing/active.json. Refuses
              when a pointer or the dated file already exists — dated
              configs are immutable; routing changes by adding a new dated
              file and repointing.
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

const COMMAND_ARITY = { init: 0, active: 0, 'review-for': 1 };

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
  loadRouting,
  effectiveRouting,
  reviewFor,
  validateRoutingConfig,
  buildDefaultConfig,
  DATED_CONFIG_RE,
  ACTIVE_BASENAME,
  ROUTING_DIRNAME,
  FAMILIES,
};
