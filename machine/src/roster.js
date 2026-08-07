'use strict';

// maestro machine layer — fleet roster (sole writer of roster.json and
// roster-archive.jsonl).
//
// The roster is what a restarted liaison rebuilds its fleet picture from:
// every live worker seat is registered here at spawn, heartbeats refresh
// last_seen, supervision sweeps reconcile the file against the harness's
// live task list, and finished/dead entries retire into an append-only
// archive stream. All mutations run through atomic-json's locked
// read-modify-write, so concurrent CLI invocations never clobber each other.

const fs = require('node:fs');
const path = require('node:path');

const { readJson, updateJson } = require('./atomic-json.js');
const { appendRecord } = require('./jsonl.js');

const ROSTER_BASENAME = 'roster.json';
const ARCHIVE_BASENAME = 'roster-archive.jsonl';
const SCHEMA_VERSION = 1;

const FAMILIES = new Set(['claude', 'gpt', 'gemini']);
const STATUSES = new Set(['alive', 'zombie', 'dead', 'finished']);
const RETIRABLE_STATUSES = new Set(['finished', 'dead']);

const REGISTER_REQUIRED_KEYS = ['seat', 'task_id', 'family'];
// route_seq references the author-phase route record the worker was spawned
// under (route-before-spawn, §6) — a ledger seq, so an integer where every
// other optional key is a string handle.
const REGISTER_OPTIONAL_KEYS = ['transcript_handle', 'codex_session', 'gemini_handle', 'mission_id', 'route_seq'];
const REGISTER_ALL_KEYS = [...REGISTER_REQUIRED_KEYS, ...REGISTER_OPTIONAL_KEYS];

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function rosterPath(treeRoot) {
  return path.join(treeRoot, ROSTER_BASENAME);
}

function archivePath(treeRoot) {
  return path.join(treeRoot, ARCHIVE_BASENAME);
}

function emptyRoster() {
  return { schema_version: SCHEMA_VERSION, entries: [] };
}

// The tree root must already exist as a directory: silently creating a
// roster at a typo'd path would fork the fleet's state.
function requireTreeRoot(treeRoot) {
  let stat;
  try {
    stat = fs.statSync(treeRoot);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`tree root does not exist: ${treeRoot}`);
    }
    throw err;
  }
  if (!stat.isDirectory()) {
    throw new Error(`tree root is not a directory: ${treeRoot}`);
  }
}

function normalizeRoster(current) {
  if (!isPlainObject(current) || !Array.isArray(current.entries)) {
    return emptyRoster();
  }
  return current;
}

function validateRegistration(input) {
  if (!isPlainObject(input)) {
    return { ok: false, errors: ['registration must be a plain JSON object'] };
  }
  const errors = [];
  for (const key of Object.keys(input)) {
    if (!REGISTER_ALL_KEYS.includes(key)) {
      errors.push(`registration has unexpected extra key "${key}"`);
    }
  }
  for (const key of REGISTER_REQUIRED_KEYS) {
    if (!isNonEmptyString(input[key])) {
      errors.push(`registration field "${key}" must be a non-empty string`);
    }
  }
  if (isNonEmptyString(input.family) && !FAMILIES.has(input.family)) {
    errors.push(`registration field "family" must be one of ${[...FAMILIES].join(', ')} (got "${input.family}")`);
  }
  for (const key of REGISTER_OPTIONAL_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
    if (key === 'route_seq') {
      if (!Number.isSafeInteger(input.route_seq) || input.route_seq < 0) {
        errors.push('registration field "route_seq" must be a nonnegative integer naming the author route ledger seq');
      }
    } else if (!isNonEmptyString(input[key])) {
      errors.push(`registration field "${key}" must be a non-empty string when provided`);
    }
  }
  return { ok: errors.length === 0, errors };
}

function register(treeRoot, input) {
  requireTreeRoot(treeRoot);
  const { ok, errors } = validateRegistration(input);
  if (!ok) {
    throw new Error(`invalid registration: ${errors.join('; ')}`);
  }

  const now = new Date().toISOString();
  const entry = {
    seat: input.seat,
    task_id: input.task_id,
    family: input.family,
  };
  for (const key of REGISTER_OPTIONAL_KEYS) {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      entry[key] = input[key];
    }
  }
  entry.spawned_ts = now;
  entry.last_seen = now;
  entry.status = 'alive';

  updateJson(
    rosterPath(treeRoot),
    (current) => {
      const roster = normalizeRoster(current);
      // Uniqueness is decided under the lock, against the same read the
      // write lands on — never against a stale pre-lock snapshot.
      const sameTask = roster.entries.find((e) => e.task_id === entry.task_id);
      if (sameTask) {
        throw new Error(`task_id "${entry.task_id}" is already registered (seat "${sameTask.seat}", status ${sameTask.status})`);
      }
      const liveSeat = roster.entries.find((e) => e.seat === entry.seat && e.status === 'alive');
      if (liveSeat) {
        throw new Error(
          `seat "${entry.seat}" already has a live entry (task_id "${liveSeat.task_id}") — never double a name`
        );
      }
      return { ...roster, entries: [...roster.entries, entry] };
    },
    emptyRoster()
  );
  return entry;
}

function heartbeat(treeRoot, taskId) {
  requireTreeRoot(treeRoot);
  let updated;
  updateJson(
    rosterPath(treeRoot),
    (current) => {
      const roster = normalizeRoster(current);
      const entry = roster.entries.find((e) => e.task_id === taskId);
      if (!entry) {
        throw new Error(`no roster entry for task_id "${taskId}"`);
      }
      // A heartbeat is a liveness claim; a seat already classified otherwise
      // must be re-classified through `mark`, not quietly resurrected.
      if (entry.status !== 'alive') {
        throw new Error(`task_id "${taskId}" is ${entry.status}, not alive — use mark to re-classify it`);
      }
      updated = { ...entry, last_seen: new Date().toISOString() };
      return {
        ...roster,
        entries: roster.entries.map((e) => (e.task_id === taskId ? updated : e)),
      };
    },
    emptyRoster()
  );
  return updated;
}

function mark(treeRoot, taskId, status) {
  requireTreeRoot(treeRoot);
  if (!STATUSES.has(status)) {
    throw new Error(`status must be one of ${[...STATUSES].join(', ')} (got "${status}")`);
  }
  let updated;
  updateJson(
    rosterPath(treeRoot),
    (current) => {
      const roster = normalizeRoster(current);
      const entry = roster.entries.find((e) => e.task_id === taskId);
      if (!entry) {
        throw new Error(`no roster entry for task_id "${taskId}"`);
      }
      updated = { ...entry, status, last_seen: new Date().toISOString() };
      return {
        ...roster,
        entries: roster.entries.map((e) => (e.task_id === taskId ? updated : e)),
      };
    },
    emptyRoster()
  );
  return updated;
}

function reconcile(treeRoot, liveTaskIds) {
  requireTreeRoot(treeRoot);
  if (!Array.isArray(liveTaskIds) || liveTaskIds.some((id) => !isNonEmptyString(id))) {
    throw new Error('reconcile requires a JSON array of non-empty task-id strings on stdin');
  }
  const live = new Set(liveTaskIds);
  let result;
  updateJson(
    rosterPath(treeRoot),
    (current) => {
      const roster = normalizeRoster(current);
      let markedDead = 0;
      const entries = roster.entries.map((entry) => {
        // Only 'alive' entries are demoted: zombie/dead/finished are already
        // explicit classifications this sweep must not overwrite.
        if (entry.status === 'alive' && !live.has(entry.task_id)) {
          markedDead += 1;
          return { ...entry, status: 'dead' };
        }
        return entry;
      });
      const counts = { alive: 0, zombie: 0, dead: 0, finished: 0 };
      for (const entry of entries) counts[entry.status] += 1;
      result = {
        roster: { ...roster, entries },
        summary:
          `reconcile: ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} — ` +
          `${counts.alive} alive, ${counts.zombie} zombie, ${counts.dead} dead ` +
          `(${markedDead} newly marked), ${counts.finished} finished`,
      };
      return result.roster;
    },
    emptyRoster()
  );
  return result;
}

function retire(treeRoot, taskId) {
  requireTreeRoot(treeRoot);
  let retired;
  updateJson(
    rosterPath(treeRoot),
    (current) => {
      const roster = normalizeRoster(current);
      const entry = roster.entries.find((e) => e.task_id === taskId);
      if (!entry) {
        throw new Error(`no roster entry for task_id "${taskId}"`);
      }
      if (!RETIRABLE_STATUSES.has(entry.status)) {
        throw new Error(
          `only finished or dead entries retire; task_id "${taskId}" is ${entry.status}`
        );
      }
      // Archive-then-remove inside the same locked transaction: if the
      // archive append fails, this throw aborts the update and the entry
      // stays on the roster — an entry is never lost between the two files.
      appendRecord(archivePath(treeRoot), {
        kind: 'roster_retire',
        payload: { ...entry, retired_ts: new Date().toISOString() },
        correlation_id: isNonEmptyString(entry.mission_id) ? entry.mission_id : null,
      });
      retired = entry;
      return { ...roster, entries: roster.entries.filter((e) => e.task_id !== taskId) };
    },
    emptyRoster()
  );
  return retired;
}

// --- CLI --------------------------------------------------------------------

const HELP = `roster.js — maestro fleet roster (sole writer of roster.json and roster-archive.jsonl)

usage:
  roster.js register <treeRoot>              registration JSON piped via stdin
  roster.js heartbeat <treeRoot> <task_id>
  roster.js mark <treeRoot> <task_id> <status>
  roster.js reconcile <treeRoot>             JSON array of live task ids via stdin
  roster.js retire <treeRoot> <task_id>

commands:
  register    stdin: { seat, task_id, family, transcript_handle?,
              codex_session?, gemini_handle?, mission_id?, route_seq? };
              family in {claude, gpt, gemini}; route_seq is the ledger seq of
              the author-phase route the worker was spawned under (an
              integer). Adds { ..., spawned_ts, last_seen, status: "alive" }.
              A task_id already on the roster, or a seat that still has a
              live entry, is refused — never double a name.
  heartbeat   refreshes last_seen on an alive entry; a non-alive entry is
              refused (re-classify through mark instead).
  mark        sets status to one of alive | zombie | dead | finished and
              refreshes last_seen.
  reconcile   stdin: JSON array of task ids the harness reports live. Every
              alive entry not in the list becomes dead; other statuses are
              untouched. Prints the reconciled roster then a summary line.
  retire      removes a finished or dead entry from roster.json and appends
              it (plus retired_ts) to roster-archive.jsonl; any other status
              is refused.

Prints the affected entry (or roster) as JSON on success; exits 0. Any
refusal or invalid input prints to stderr and exits 1.
`;

const COMMAND_ARITY = {
  register: 0,
  heartbeat: 1,
  mark: 2,
  reconcile: 0,
  retire: 1,
};

// Fail-closed argv parsing: every token must be accounted for — a surplus
// positional or an unknown command is a refusal, never silently ignored.
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
  const arity = COMMAND_ARITY[command];
  if (rest.length !== arity) {
    return {
      error:
        rest.length > arity
          ? `unexpected extra argument(s): ${rest.slice(arity).join(' ')}`
          : `${command} requires ${arity + 2} argument(s)`,
    };
  }
  return { command, treeRoot, args: rest };
}

function readStdinJson(label) {
  const text = fs.readFileSync(0, 'utf8');
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`stdin did not carry valid JSON for ${label}: ${err.message}`);
  }
}

function main(argv) {
  const parsed = parseArgv(argv);
  if (parsed.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  if (parsed.error) {
    process.stderr.write(`roster.js: ${parsed.error}\n${HELP}`);
    process.exit(1);
  }

  try {
    const { command, treeRoot, args } = parsed;
    if (command === 'register') {
      const entry = register(treeRoot, readStdinJson('registration'));
      process.stdout.write(JSON.stringify(entry, null, 2) + '\n');
    } else if (command === 'heartbeat') {
      const entry = heartbeat(treeRoot, args[0]);
      process.stdout.write(JSON.stringify(entry, null, 2) + '\n');
    } else if (command === 'mark') {
      const entry = mark(treeRoot, args[0], args[1]);
      process.stdout.write(JSON.stringify(entry, null, 2) + '\n');
    } else if (command === 'reconcile') {
      const { roster, summary } = reconcile(treeRoot, readStdinJson('reconcile'));
      process.stdout.write(JSON.stringify(roster, null, 2) + '\n');
      process.stdout.write(summary + '\n');
    } else if (command === 'retire') {
      const entry = retire(treeRoot, args[0]);
      process.stdout.write(JSON.stringify(entry, null, 2) + '\n');
    }
    process.exit(0);
  } catch (err) {
    process.stderr.write(`roster.js: ${err.message}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = {
  register,
  heartbeat,
  mark,
  reconcile,
  retire,
  validateRegistration,
  REGISTER_OPTIONAL_KEYS,
  ROSTER_BASENAME,
  ARCHIVE_BASENAME,
  FAMILIES,
  STATUSES,
};
