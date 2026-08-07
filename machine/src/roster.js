'use strict';

// maestro machine layer — fleet roster (sole writer of roster.json and
// roster-archive.jsonl, and of the ledger kinds "dispatch" and
// "profile-outcome").
//
// The roster is what a restarted liaison rebuilds its fleet picture from:
// every live worker seat is registered here at spawn, heartbeats refresh
// last_seen, supervision sweeps reconcile the file against the harness's
// live task list, and finished/dead entries retire into an append-only
// archive stream. All mutations run through atomic-json's locked
// read-modify-write, so concurrent CLI invocations never clobber each other.
//
// TWO RECORDS MAKE A MISSION AUDITABLE (§16): what was dispatched, and what
// actually ran. `register` appends the first, `recordOutcome` the second, and
// the rule both obey is the one five slices of this mission arrived at the
// hard way — EVERY FIELD IS SOURCED FROM A RECORD THE MACHINE ALREADY WROTE,
// never from what the caller says about it. A family, an artifact identity and
// a review verdict each turned out to be defeatable by one lawful call while
// they were merely asserted; telemetry is the same problem with the audit as
// its victim, and unlike a wrong verdict it fails silently forever. So the
// route record the registration references is the source, the registration's
// own words about class, attempt, seat, family or mission are CHECKED against
// it and refused on contradiction, and a registration that names no route
// gets no dispatch record at all — with nothing to source from, every field
// would be the caller's own word.
//
// WRITE ORDER: the dispatch record is appended AFTER the locked roster write
// succeeds, never before (§16.1). The two files cannot be written in one
// transaction, so one of them is first, and the choice decides what a crash in
// the gap leaves behind. Roster-first loses one telemetry datum and corrupts
// nothing: the seat is registered, supervision can see it, reconcile can
// retire it. Ledger-first would leave a dispatch record for a seat no roster
// entry backs — a mission that reads as dispatched with nothing to supervise,
// which is corruption of exactly the picture recovery rebuilds.
//
// Every refusal this module can decide is decided before either write: the
// registration's shape, the route it references, the contradictions against
// that route, and whether the resulting record fits the ledger's line ceiling.
// What remains inside the gap is not a refusal but a failure — a lock timeout,
// a full disk, a killed process. Each of those loses this one record, none of
// them reaches roster.json, and none of them could have been decided earlier.
//
// EVIDENCE_LEVEL IS `unknown`, and honestly so: no writer anywhere in
// machine/src reports what a worker's runtime actually was, so the outcome
// record says it does not know rather than inferring a level from the
// requested profile. The vocabulary is closed and exported so the writer that
// eventually supplies receipts plugs into it without a schema change.

const fs = require('node:fs');
const path = require('node:path');

const { readJson, updateJson } = require('./atomic-json.js');
const {
  appendRecord,
  readRecords,
  LINE_CEILING,
  SCHEMA_VERSION: LEDGER_SCHEMA_VERSION,
} = require('./jsonl.js');
const { ROUTE_KIND, SUPERSEDED_KIND, CLASS_ORDER } = require('./route.js');

const ROSTER_BASENAME = 'roster.json';
const ARCHIVE_BASENAME = 'roster-archive.jsonl';
const LEDGER_BASENAME = 'ledger.jsonl';
const DISPATCH_KIND = 'dispatch';
const OUTCOME_KIND = 'profile-outcome';
const SCHEMA_VERSION = 1;

const FAMILIES = new Set(['claude', 'gpt', 'gemini']);
const STATUSES = new Set(['alive', 'zombie', 'dead', 'finished']);
const RETIRABLE_STATUSES = new Set(['finished', 'dead']);

// §16.2's closed and honest vocabulary. `unknown` is not a placeholder for a
// value someone forgot to pass: it is the true answer while no runtime receipt
// writer exists, and it is the only level this module can currently produce.
const EVIDENCE_LEVELS = ['runtime-reported', 'host-observed', 'requested-only', 'unknown'];
const EVIDENCE_LEVEL_WITHOUT_RECEIPTS = 'unknown';

// §5's attribution rule names its target outright: when the host materially
// authors the code, "family attribution changes to Claude". The hosted
// topology is a Claude host in front of a non-Claude worker, so the host's
// family is a constant of the design, not a lookup.
const HOST_FAMILY = 'claude';

const REGISTER_REQUIRED_KEYS = ['seat', 'task_id', 'family'];
// route_seq references the route record the worker was spawned under
// (route-before-spawn, §6) — a ledger seq, so an integer where every other
// optional handle is a string. class, attempt and resumed are the dispatch
// identity (§16.1); each is also carried by the route record, so each is
// checked against it rather than believed.
const REGISTER_OPTIONAL_KEYS = [
  'transcript_handle',
  'codex_session',
  'gemini_handle',
  'mission_id',
  'route_seq',
  'class',
  'attempt',
  'resumed',
];
const REGISTER_ALL_KEYS = [...REGISTER_REQUIRED_KEYS, ...REGISTER_OPTIONAL_KEYS];

const OUTCOME_KEYS = ['dispatch_seq', 'fallback_used', 'fallback_reason', 'host_materially_authored'];
const REASON_CEILING = 200;

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
    const check = OPTIONAL_KEY_CHECKS[key];
    if (check) {
      const problem = check(input[key]);
      if (problem !== null) errors.push(`registration field "${key}" ${problem}`);
    } else if (!isNonEmptyString(input[key])) {
      errors.push(`registration field "${key}" must be a non-empty string when provided`);
    }
  }
  return { ok: errors.length === 0, errors };
}

// The three keys that are not string handles. Everything they describe is also
// on the route record, so these checks are shape only — the truth check is
// checkAgainstRoute below.
const OPTIONAL_KEY_CHECKS = {
  route_seq: (value) =>
    Number.isSafeInteger(value) && value >= 0
      ? null
      : 'must be a nonnegative integer naming the route ledger seq',
  class: (value) =>
    CLASS_ORDER.includes(value) ? null : `must be one of ${CLASS_ORDER.join(', ')} (got ${JSON.stringify(value)})`,
  attempt: (value) => (Number.isSafeInteger(value) && value >= 1 ? null : 'must be an integer >= 1'),
  resumed: (value) => (typeof value === 'boolean' ? null : 'must be a boolean'),
};

// --- the ledger side: sourcing a dispatch from the route it references -------

function ledgerPath(treeRoot) {
  return path.join(treeRoot, LEDGER_BASENAME);
}

// A stream that cannot be read end to end yields no source at all — the same
// rule route.js and mission.js apply before deriving anything from it.
function readLedger(treeRoot) {
  const file = ledgerPath(treeRoot);
  const { records, errors } = readRecords(file);
  if (errors.length > 0) {
    const detail = errors.map((e) => `line ${e.line}: ${e.reason}`).join('; ');
    throw new Error(`${file} has malformed record(s) — refusing to source a dispatch from it: ${detail}`);
  }
  return records;
}

function recordAtSeq(records, seq, kind, label) {
  const matches = records.filter((r) => isPlainObject(r) && r.seq === seq);
  if (matches.length === 0) {
    throw new Error(`no ledger record at seq ${seq} — a ${label} that names no record names nothing`);
  }
  if (matches.length > 1) {
    throw new Error(`ledger seq ${seq} is ambiguous (${matches.length} records carry it)`);
  }
  const record = matches[0];
  if (record.kind !== kind) {
    throw new Error(`ledger seq ${seq} is a "${record.kind}" record, not a ${kind} record (${label})`);
  }
  return record;
}

// The dispatch payload, phase by phase. An author route carries the whole
// topology itself; a review route carries the reviewer half and names the
// author route the rest belongs to, so the class, attempt and degraded modes
// of a review dispatch come from there rather than from anybody's memory.
function dispatchFactsOf(records, route) {
  if (route.phase === 'author') {
    return {
      mission_id: route.mission_id,
      seat: route.resolved_seat,
      family: route.author_family,
      class: route.task_class,
      attempt: route.attempt,
      resumed: route.resumed,
      requested_seat: route.requested_seat,
      resolved_seat: route.resolved_seat,
      worker_model: route.worker_model,
      worker_effort: route.worker_effort,
      host_model: route.host_model,
      host_effort: route.host_effort,
      routing_config: route.routing_config,
      routing_digest: route.routing_digest,
      routing_revision: route.routing_revision,
      degraded_modes: route.degraded_modes,
    };
  }
  const author = recordAtSeq(records, route.author_route_seq, ROUTE_KIND, 'review route author_route_seq');
  const reserved = isPlainObject(author.reserved_review) ? author.reserved_review : {};
  return {
    mission_id: route.mission_id,
    seat: route.reviewer_seat,
    family: route.reviewer_family,
    // The class and attempt of the work under review are properties of the
    // attempt itself, so they describe this dispatch as truly as the author's.
    class: author.task_class,
    attempt: author.attempt,
    // A resume is not such a property: it is a fact about one worker's own
    // run, and no record establishes a reviewer's. Review routes never stamp
    // `resumed` and have no resume transition to reach one by (route.js only
    // supersedes a review route through same-class-provider-reroute), so this
    // ships the honest unknown. Borrowing the author's value would state one
    // subject's fact under another subject's name — the silent-forever defect
    // this whole record exists to prevent, and null is the same answer the
    // unsourced-field rule gives everywhere else here.
    resumed: null,
    // Requested against resolved, on the reviewer's own dimension: the
    // capacity the author route reserved, against the seat that reviews.
    requested_seat: isNonEmptyString(reserved.seat) ? reserved.seat : null,
    resolved_seat: route.reviewer_seat,
    worker_model: route.reviewer_model,
    worker_effort: route.reviewer_effort,
    host_model: route.reviewer_host_model,
    host_effort: route.reviewer_host_effort,
    routing_config: route.routing_config,
    routing_digest: route.routing_digest,
    // A review route records no revision of its own. The author route's
    // revision numbers the AUTHOR's config, so it travels here only when both
    // routes name the same config; after a mid-mission migration it would
    // otherwise pair a new filename with an old revision number and describe
    // neither.
    routing_revision: route.routing_config === author.routing_config ? author.routing_revision : null,
    degraded_modes: author.degraded_modes,
  };
}

// Anything the registration says that the route record also carries is a
// claim, not a source. It may agree, in which case it adds nothing and is
// dropped from the record; it may disagree, in which case one of the two is
// wrong and the durable one wins.
function checkAgainstRoute(input, facts, routeSeq) {
  for (const key of ['seat', 'family', 'mission_id', 'class', 'attempt', 'resumed']) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
    // A null fact means no record establishes that subject for this phase, so
    // there is nothing for the registration to contradict. Its word stays on
    // the roster entry, where the fleet picture keeps unverified bookkeeping,
    // and the ledger record still ships the unknown — refusing here instead
    // would make a truthful worker choose between mislabelling itself and
    // giving up its dispatch record.
    if (facts[key] === null) continue;
    if (input[key] === facts[key]) continue;
    throw new Error(
      `registration ${key} ${JSON.stringify(input[key])} contradicts the route record at seq ${routeSeq}, which records ${JSON.stringify(facts[key])} — the record decides, and a registration that disagrees with it is refused rather than recorded`
    );
  }
}

// The ledger refuses a line over its byte ceiling, and that refusal is
// knowable before anything is written — so it happens there, not in the gap
// between the two writes. Measured against the widest header the record could
// ever carry (a seq is at most MAX_SAFE_INTEGER wide, a ts is fixed width), so
// the estimate can over-count but never under-count.
function checkAppendable(payload, kind, correlationId, label) {
  const widest = {
    schema_version: LEDGER_SCHEMA_VERSION,
    seq: Number.MAX_SAFE_INTEGER,
    kind,
    ts: new Date().toISOString(),
    correlation_id: correlationId,
    ...payload,
  };
  const bytes = Buffer.byteLength(JSON.stringify(widest) + '\n', 'utf8');
  if (bytes > LINE_CEILING) {
    throw new Error(
      `${label} would serialize to ${bytes} bytes, over the ledger's ${LINE_CEILING}-byte line ceiling — refused before the roster write, so no seat is registered whose dispatch record could never be appended`
    );
  }
}

function dispatchPayloadOf(facts, entry, routeSeq, phase) {
  return {
    mission_id: facts.mission_id,
    task_id: entry.task_id,
    phase,
    route_seq: routeSeq,
    seat: facts.seat,
    family: facts.family,
    class: facts.class,
    attempt: facts.attempt,
    resumed: facts.resumed,
    requested_seat: facts.requested_seat,
    resolved_seat: facts.resolved_seat,
    worker_model: facts.worker_model,
    worker_effort: facts.worker_effort,
    host_model: facts.host_model,
    host_effort: facts.host_effort,
    routing_config: facts.routing_config,
    routing_digest: facts.routing_digest,
    routing_revision: facts.routing_revision,
    degraded_modes: facts.degraded_modes,
    spawned_ts: entry.spawned_ts,
  };
}

function register(treeRoot, input) {
  requireTreeRoot(treeRoot);
  const { ok, errors } = validateRegistration(input);
  if (!ok) {
    throw new Error(`invalid registration: ${errors.join('; ')}`);
  }

  // Resolved and cross-checked BEFORE either write: a refusal must reach no
  // disk at all, and the crash window the write order protects is meant to
  // hold the append and nothing else.
  const references = Object.prototype.hasOwnProperty.call(input, 'route_seq');
  let facts = null;
  if (references) {
    const records = readLedger(treeRoot);
    const route = recordAtSeq(records, input.route_seq, ROUTE_KIND, 'registration route_seq');
    facts = dispatchFactsOf(records, route);
    checkAgainstRoute(input, facts, input.route_seq);
    facts.phase = route.phase;
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

  // Built before the roster write so the last decidable refusal — whether the
  // ledger would take this line — is made while nothing has been written.
  let dispatch = null;
  if (references) {
    dispatch = {
      kind: DISPATCH_KIND,
      payload: dispatchPayloadOf(facts, entry, input.route_seq, facts.phase),
      correlation_id: isNonEmptyString(facts.mission_id) ? facts.mission_id : null,
    };
    // The label quotes the task id, so an oversized one is elided rather than
    // echoed back at full length into an error message.
    const shown =
      input.task_id.length > 60 ? `${input.task_id.slice(0, 60)}… (${input.task_id.length} characters)` : input.task_id;
    checkAppendable(dispatch.payload, dispatch.kind, dispatch.correlation_id, `the dispatch record for task_id "${shown}"`);
  }

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

  // ...and only now the telemetry. A crash here loses this record and leaves
  // both files intact (see the module header); the reverse order would leave a
  // dispatch nothing backs.
  if (dispatch !== null) {
    appendRecord(ledgerPath(treeRoot), dispatch);
  }
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

// --- the profile-outcome record (§16.2) --------------------------------------

// What the caller reports is deliberately tiny, and none of it is a value: it
// is which of the profiles the route already reserved actually ran, whether
// the host crossed the authorship line §5 draws, and why. Every model, effort,
// seat and family in the record below is then read off the dispatch and route
// records. A caller cannot name an actual profile of its own invention — it
// can only select one the machine reserved — so the worst a wrong report can
// do is pick the wrong recorded profile, never conjure an unrecorded one.
function validateOutcome(input) {
  if (!isPlainObject(input)) {
    return { ok: false, errors: ['outcome must be a plain JSON object'] };
  }
  const errors = [];
  for (const key of Object.keys(input)) {
    if (!OUTCOME_KEYS.includes(key)) errors.push(`outcome has unexpected extra key "${key}"`);
  }
  if (!Number.isSafeInteger(input.dispatch_seq) || input.dispatch_seq < 0) {
    errors.push('outcome field "dispatch_seq" must be a nonnegative integer naming the dispatch ledger seq');
  }
  if (typeof input.fallback_used !== 'boolean') {
    errors.push('outcome field "fallback_used" must be a boolean');
  }
  if (typeof input.host_materially_authored !== 'boolean') {
    errors.push('outcome field "host_materially_authored" must be a boolean');
  }
  if (input.fallback_used === true) {
    if (!isNonEmptyString(input.fallback_reason) || /[\r\n]/.test(input.fallback_reason)) {
      errors.push('outcome field "fallback_reason" must be a non-empty single-line string when "fallback_used" is true');
    } else if (input.fallback_reason.length > REASON_CEILING) {
      errors.push(`outcome field "fallback_reason" must be at most ${REASON_CEILING} characters`);
    }
  } else if (input.fallback_reason !== null) {
    errors.push('outcome field "fallback_reason" must be null unless "fallback_used" is true');
  }
  return { ok: errors.length === 0, errors };
}

// The reviewer that actually ran, as the route stream records it: the newest
// review route bound to this author route that nothing has superseded. Until
// one exists — and at worker completion it usually does not yet — the actual
// reviewer is null, which is the truth, not a gap to fill with the requested
// one.
function actualReviewerOf(records, authorRouteSeq) {
  const superseded = new Set(
    records
      .filter((r) => isPlainObject(r) && r.kind === SUPERSEDED_KIND)
      .map((r) => r.predecessor_route_seq)
  );
  let latest = null;
  for (const record of records) {
    if (!isPlainObject(record) || record.kind !== ROUTE_KIND || record.phase !== 'review') continue;
    if (record.author_route_seq !== authorRouteSeq) continue;
    if (superseded.has(record.seq)) continue;
    if (latest === null || record.seq > latest.seq) latest = record;
  }
  return latest === null
    ? { model: null, effort: null }
    : { model: latest.reviewer_model, effort: latest.reviewer_effort };
}

function recordOutcome(treeRoot, input) {
  requireTreeRoot(treeRoot);
  const { ok, errors } = validateOutcome(input);
  if (!ok) {
    throw new Error(`invalid outcome: ${errors.join('; ')}`);
  }

  const records = readLedger(treeRoot);
  const dispatch = recordAtSeq(records, input.dispatch_seq, DISPATCH_KIND, 'outcome dispatch_seq');
  if (dispatch.phase !== 'author') {
    throw new Error(
      `outcome refused — dispatch seq ${input.dispatch_seq} is a "${dispatch.phase}"-phase dispatch, and this record is written for an author-phase dispatch: no record anywhere reserves a reviewer fallback profile, so a reviewer's actual profile has no source to be read from`
    );
  }
  const already = records.find((r) => isPlainObject(r) && r.kind === OUTCOME_KIND && r.dispatch_seq === input.dispatch_seq);
  if (already) {
    throw new Error(
      `dispatch seq ${input.dispatch_seq} already has a profile outcome (seq ${already.seq}) — one dispatch runs once, and its outcome is never rewritten`
    );
  }
  const route = recordAtSeq(records, dispatch.route_seq, ROUTE_KIND, 'dispatch route_seq');

  // Attribution rule one (§16.2): a Fable seat that fell back to Opus is Opus
  // execution. The actual columns are what telemetry counts, and they carry
  // the profile the route RESERVED as its fallback — so a fallback nobody
  // reserved cannot be reported as having run.
  let actualWorker;
  if (input.fallback_used) {
    if (!isPlainObject(route.fallback_profile)) {
      throw new Error(
        `outcome refused — the route record at seq ${dispatch.route_seq} reserved no fallback profile, so no fallback ran: a fallback that was never reserved never happened`
      );
    }
    actualWorker = { model: route.fallback_profile.model, effort: route.fallback_profile.effort };
  } else {
    actualWorker = { model: dispatch.worker_model, effort: dispatch.worker_effort };
  }

  // Attribution rule two (§5): a Claude host that materially authors the diff
  // takes the attribution, and the cross-family review that was resolved
  // against the worker's family must re-resolve against the host's.
  if (input.host_materially_authored && !isNonEmptyString(dispatch.host_model)) {
    throw new Error(
      `outcome refused — the dispatch at seq ${input.dispatch_seq} records no host (a native seat runs its model directly), so there is no host authorship to attribute`
    );
  }
  const familyAttributed = input.host_materially_authored ? HOST_FAMILY : dispatch.family;

  // Nothing observes the host's runtime either, so its actual profile is the
  // one that was dispatched; the two columns exist so a writer that later
  // observes a divergence has somewhere honest to put it.
  const actualHost = { model: dispatch.host_model, effort: dispatch.host_effort };
  const reserved = isPlainObject(route.reserved_review) ? route.reserved_review : {};
  const requestedReviewer = {
    model: isNonEmptyString(reserved.model) ? reserved.model : null,
    effort: isNonEmptyString(reserved.effort) ? reserved.effort : null,
  };
  const actualReviewer = actualReviewerOf(records, dispatch.route_seq);

  // A safety refusal is not the caller's word either: route.js records it as
  // the reason a supersession rerouted this route's unchanged brief. An
  // outcome written before that supersession reads false, and the supersession
  // record remains the audit's authority in both directions.
  const safetyRefusal = records.some(
    (r) =>
      isPlainObject(r) &&
      r.kind === SUPERSEDED_KIND &&
      r.predecessor_route_seq === dispatch.route_seq &&
      r.reason === 'safety-refusal'
  );

  const runtimeMismatch =
    actualWorker.model !== dispatch.worker_model ||
    actualWorker.effort !== dispatch.worker_effort ||
    actualHost.model !== dispatch.host_model ||
    actualHost.effort !== dispatch.host_effort ||
    (actualReviewer.model !== null &&
      (actualReviewer.model !== requestedReviewer.model || actualReviewer.effort !== requestedReviewer.effort));

  return appendRecord(ledgerPath(treeRoot), {
    kind: OUTCOME_KIND,
    payload: {
      mission_id: dispatch.mission_id,
      dispatch_seq: input.dispatch_seq,
      route_seq: dispatch.route_seq,
      task_id: dispatch.task_id,
      seat: dispatch.seat,
      class: dispatch.class,
      attempt: dispatch.attempt,
      requested_worker_model: dispatch.worker_model,
      requested_worker_effort: dispatch.worker_effort,
      actual_worker_model: actualWorker.model,
      actual_worker_effort: actualWorker.effort,
      requested_host_model: dispatch.host_model,
      requested_host_effort: dispatch.host_effort,
      actual_host_model: actualHost.model,
      actual_host_effort: actualHost.effort,
      requested_reviewer_model: requestedReviewer.model,
      requested_reviewer_effort: requestedReviewer.effort,
      actual_reviewer_model: actualReviewer.model,
      actual_reviewer_effort: actualReviewer.effort,
      fallback_used: input.fallback_used,
      fallback_reason: input.fallback_used ? input.fallback_reason : null,
      evidence_level: EVIDENCE_LEVEL_WITHOUT_RECEIPTS,
      safety_refusal: safetyRefusal,
      runtime_mismatch: runtimeMismatch,
      family_requested: dispatch.family,
      family_attributed: familyAttributed,
      family_reattributed: familyAttributed !== dispatch.family,
      review_reresolve_required: familyAttributed !== dispatch.family,
    },
    correlation_id: isNonEmptyString(dispatch.mission_id) ? dispatch.mission_id : null,
  });
}

// --- CLI --------------------------------------------------------------------

const HELP = `roster.js — maestro fleet roster (sole writer of roster.json,
roster-archive.jsonl, and the ledger kinds "${DISPATCH_KIND}" and "${OUTCOME_KIND}")

usage:
  roster.js register <treeRoot>              registration JSON piped via stdin
  roster.js heartbeat <treeRoot> <task_id>
  roster.js mark <treeRoot> <task_id> <status>
  roster.js reconcile <treeRoot>             JSON array of live task ids via stdin
  roster.js retire <treeRoot> <task_id>
  roster.js record-outcome <treeRoot>        outcome JSON piped via stdin

commands:
  register    stdin: { seat, task_id, family, transcript_handle?,
              codex_session?, gemini_handle?, mission_id?, route_seq?,
              class?, attempt?, resumed? };
              family in {claude, gpt, gemini}; route_seq is the ledger seq of
              the route record the worker was spawned under (an integer);
              class one of ${CLASS_ORDER.join(', ')};
              attempt an integer >= 1; resumed a boolean. Adds
              { ..., spawned_ts, last_seen, status: "alive" }.
              A task_id already on the roster, or a seat that still has a
              live entry, is refused — never double a name.
              With route_seq, appends a "${DISPATCH_KIND}" ledger record AFTER
              the roster write, every field sourced from that route record —
              a crash between the two writes loses one telemetry datum and
              never corrupts either file. seat, family, mission_id, class,
              attempt and resumed are CHECKED against the route record and
              refused on contradiction, never taken as given. A dimension the
              route does not establish is not checked and is recorded null:
              on a REVIEW registration that is "resumed", since no record
              anywhere carries a reviewer's resume status — the claim stays on
              the roster entry as fleet bookkeeping and never enters the
              ledger as if it had been sourced. Without route_seq nothing is
              appended at all: with no record to source from, every field
              would be the caller's own word.
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
  record-outcome
              stdin: { dispatch_seq, fallback_used, fallback_reason,
              host_materially_authored }. Appends a "${OUTCOME_KIND}"
              record naming requested against actual for the worker, host and
              reviewer profiles. Only the four keys above are reported; every
              model, effort, seat and family is read off the dispatch and
              route records. fallback_used names the profile the ROUTE
              reserved as its fallback — a fallback nobody reserved is
              refused — so a Fable seat that fell back is recorded as Opus
              execution and never as a Fable success.
              host_materially_authored moves the family attribution to
              ${HOST_FAMILY} (§5) and flags the review for re-resolution; a
              dispatch with no host is refused. evidence_level is
              "${EVIDENCE_LEVEL_WITHOUT_RECEIPTS}" — no writer reports a
              runtime profile yet, and the record says so rather than
              guessing. safety_refusal is derived from the route
              supersession stream, never reported. One outcome per dispatch.

Prints the affected entry (or roster, or record) as JSON on success; exits 0.
Any refusal or invalid input prints to stderr and exits 1.
`;

const COMMAND_ARITY = {
  register: 0,
  heartbeat: 1,
  mark: 2,
  reconcile: 0,
  retire: 1,
  'record-outcome': 0,
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
    } else if (command === 'record-outcome') {
      const record = recordOutcome(treeRoot, readStdinJson('outcome'));
      process.stdout.write(JSON.stringify(record, null, 2) + '\n');
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
  recordOutcome,
  validateRegistration,
  validateOutcome,
  REGISTER_OPTIONAL_KEYS,
  OUTCOME_KEYS,
  EVIDENCE_LEVELS,
  ROSTER_BASENAME,
  ARCHIVE_BASENAME,
  DISPATCH_KIND,
  OUTCOME_KIND,
  FAMILIES,
  STATUSES,
};
