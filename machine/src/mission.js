'use strict';

// maestro machine layer — mission lifecycle CLI.
//
// Sole sanctioned writer of:
//   ledger.jsonl kinds:            mission-open, envelope, consult, mission-close
//   missions/<id>/progress.jsonl:  genesis, checkpoint
//   missions/<id>/brief.json, missions/<id>/envelopes/*.json
//   state.json.missions[<id>] entries (status + next_action)
//
// Every state.json mutation runs inside updateJson's lock, and the ledger
// append it pairs with happens FROM INSIDE the updater, so both writes are
// decided against the same locked read (ledger-first: the evidence record
// lands before the resume pointer moves).
//
// close derives every fact it enforces from the ledger, never from caller
// prose. Its input is nothing but sequence references into durable records:
// the author family comes from the author-phase route record (a caller that
// could assert its own family could launder one — the old author_family input
// is gone), review independence and the reviewed artifact identity come from
// the review-phase route record, pass evidence comes from the gate record at
// the cited seq (gate.js run-gate is its only producer), and the landed
// result is proven equivalent to what was reviewed in a real git repository —
// commit containment for an ordinary merge, patch identity over the canonical
// patch for a squash. Identity is compared field by field, like with like; a
// patch digest is never compared with a commit sha. A degraded review's
// legality is judged under the route snapshot that authorized it: close reads
// no present-day provider or settings state, so a provider coming back online
// after a legal degraded review has nothing here to retroactively invalidate.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { withLock, appendRecord, readRecords } = require('./jsonl.js');
const { readJson, writeJson, updateJson } = require('./atomic-json.js');
const { validateBrief, validateEnvelope } = require('./validators.js');
const { assertContained } = require('./contain.js');
const { IDENTITY_FIELDS } = require('./gate.js');

const MISSION_STATUSES = { OPEN: 'open', DONE: 'done' };
const DEFAULT_NEXT_ACTION = 'dispatch a worker against brief.json';

// Ids and seats become path segments under missions/; anything outside this
// shape (separators, dot-prefixes, empty) is refused before any path is built.
const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function isSafeSegment(value) {
  return typeof value === 'string' && SEGMENT_RE.test(value);
}

function assertExactKeys(obj, requiredKeys, optionalKeys, label) {
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new TypeError(`${label} has unexpected extra key "${key}"`);
    }
  }
  for (const key of requiredKeys) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) {
      throw new TypeError(`${label} is missing required key "${key}"`);
    }
  }
}

function statePathOf(treeRoot) {
  return path.join(treeRoot, 'state.json');
}

function ledgerPathOf(treeRoot) {
  return path.join(treeRoot, 'ledger.jsonl');
}

function missionDirOf(treeRoot, missionId) {
  return path.join(treeRoot, 'missions', missionId);
}

function progressPathOf(treeRoot, missionId) {
  return path.join(missionDirOf(treeRoot, missionId), 'progress.jsonl');
}

// Minimal state.json genesis for a tree scaffold.js has not seeded yet;
// existing fields are always spread forward, never clobbered, since other
// scripts (stop.js, preflight.js) own their own fields in the same file.
function freshState() {
  return { schema_version: 1, missions: {}, active_mission: null };
}

function missionsOf(state, statePath) {
  if (!isPlainObject(state)) {
    throw new Error(`mission: ${statePath} is not a JSON object`);
  }
  const missions = state.missions === undefined ? {} : state.missions;
  if (!isPlainObject(missions)) {
    throw new Error(`mission: ${statePath} field "missions" is not an object`);
  }
  return missions;
}

// The guard every post-open write shares: the mission must exist and still
// be open — a closed mission's evidence stream never stays mutable.
function requireOpenMission(state, statePath, missionId) {
  const missions = missionsOf(state, statePath);
  const entry = missions[missionId];
  if (!isPlainObject(entry)) {
    throw new Error(`mission: no such mission "${missionId}" in ${statePath} (open it first)`);
  }
  if (entry.status !== MISSION_STATUSES.OPEN) {
    throw new Error(
      `mission: mission "${missionId}" has status "${entry.status}" — only an open mission accepts writes`
    );
  }
  return entry;
}

// --- open --------------------------------------------------------------------

function openMission(treeRoot, input) {
  if (!isPlainObject(input)) {
    throw new TypeError('mission: open requires a JSON object via stdin');
  }
  assertExactKeys(input, ['mission_id', 'title', 'brief'], ['next_action'], 'open input');
  const { mission_id: missionId, title, brief } = input;
  if (!isSafeSegment(missionId)) {
    throw new TypeError(
      `mission: "mission_id" must match ${SEGMENT_RE} (got ${JSON.stringify(missionId)})`
    );
  }
  if (!isNonEmptyString(title)) {
    throw new TypeError('mission: "title" must be a non-empty string');
  }
  const nextAction = Object.prototype.hasOwnProperty.call(input, 'next_action')
    ? input.next_action
    : DEFAULT_NEXT_ACTION;
  if (!isNonEmptyString(nextAction)) {
    throw new TypeError('mission: "next_action" must be a non-empty string when provided');
  }
  const briefCheck = validateBrief(brief);
  if (!briefCheck.ok) {
    throw new Error(`mission: refusing to open on an invalid brief — ${briefCheck.errors.join('; ')}`);
  }

  const statePath = statePathOf(treeRoot);
  const missionDir = missionDirOf(treeRoot, missionId);
  let openSeq;

  updateJson(
    statePath,
    (current) => {
      const state = current === undefined ? freshState() : current;
      const missions = missionsOf(state, statePath);
      if (Object.prototype.hasOwnProperty.call(missions, missionId)) {
        throw new Error(`mission: mission "${missionId}" already exists in ${statePath} — open is one-shot`);
      }
      if (fs.existsSync(missionDir)) {
        throw new Error(`mission: mission directory already exists at ${missionDir} — open is one-shot`);
      }
      // A dangling symlink at missions/<id> (existsSync false) or a symlinked
      // missions/ parent would aim every write below outside the tree.
      assertContained(treeRoot, missionDir, 'mission');

      for (const sub of ['mailbox', 'envelopes', 'artifacts']) {
        fs.mkdirSync(path.join(missionDir, sub), { recursive: true });
      }
      writeJson(path.join(missionDir, 'brief.json'), brief);
      // Genesis-seeded stream: "never ran" stays distinguishable from "ran
      // and produced nothing".
      appendRecord(progressPathOf(treeRoot, missionId), {
        kind: 'genesis',
        payload: {},
        correlation_id: missionId,
      });
      openSeq = appendRecord(ledgerPathOf(treeRoot), {
        kind: 'mission-open',
        payload: { mission_id: missionId, title },
        correlation_id: missionId,
      }).seq;

      return {
        ...state,
        missions: {
          ...missions,
          [missionId]: { status: MISSION_STATUSES.OPEN, next_action: nextAction },
        },
      };
    },
    undefined
  );

  return { mission_id: missionId, mission_dir: missionDir, next_action: nextAction, ledger_seq: openSeq };
}

// --- checkpoint --------------------------------------------------------------

function checkpointMission(treeRoot, missionId, input) {
  if (!isSafeSegment(missionId)) {
    throw new TypeError(`mission: missionId must match ${SEGMENT_RE}`);
  }
  if (!isPlainObject(input)) {
    throw new TypeError('mission: checkpoint requires a JSON object via stdin');
  }
  assertExactKeys(input, ['step', 'done_evidence', 'next'], [], 'checkpoint input');
  for (const key of ['step', 'done_evidence', 'next']) {
    if (!isNonEmptyString(input[key])) {
      throw new TypeError(`mission: checkpoint field "${key}" must be a non-empty string`);
    }
  }

  const statePath = statePathOf(treeRoot);
  const progressPath = progressPathOf(treeRoot, missionId);
  let seq;

  updateJson(
    statePath,
    (current) => {
      const state = current;
      const entry = requireOpenMission(state, statePath, missionId);
      if (!fs.existsSync(progressPath)) {
        throw new Error(`mission: ${progressPath} does not exist — mission tree is missing its progress stream`);
      }
      assertContained(treeRoot, progressPath, 'mission');
      seq = appendRecord(progressPath, {
        kind: 'checkpoint',
        payload: { step: input.step, done_evidence: input.done_evidence, next: input.next },
        correlation_id: missionId,
      }).seq;
      return {
        ...state,
        missions: {
          ...missionsOf(state, statePath),
          [missionId]: { ...entry, next_action: input.next },
        },
      };
    },
    undefined
  );

  return { mission_id: missionId, progress_seq: seq, next_action: input.next };
}

// --- record-envelope ---------------------------------------------------------

function recordEnvelope(treeRoot, missionId, seat, envelope) {
  if (!isSafeSegment(missionId)) {
    throw new TypeError(`mission: missionId must match ${SEGMENT_RE}`);
  }
  if (!isSafeSegment(seat)) {
    throw new TypeError(`mission: seat must match ${SEGMENT_RE} (got ${JSON.stringify(seat)})`);
  }
  const check = validateEnvelope(envelope);
  if (!check.ok) {
    throw new Error(`mission: refusing an invalid envelope — ${check.errors.join('; ')}`);
  }

  const statePath = statePathOf(treeRoot);
  const envelopesDir = path.join(missionDirOf(treeRoot, missionId), 'envelopes');

  // The open-status check, the file write, and the ledger append all run
  // under state.json's own lock — the same lock close's updater holds — so
  // a concurrent close can never let an envelope land on a done mission.
  // Lock order (state → ledger) matches every other writer.
  return withLock(statePath, () => {
    const state = readJson(statePath, undefined);
    requireOpenMission(state, statePath, missionId);
    // Before mkdir: a symlinked envelopes/ (or parent) would aim the write
    // outside the tree.
    assertContained(treeRoot, envelopesDir, 'mission');
    fs.mkdirSync(envelopesDir, { recursive: true });

    // ISO timestamp made filesystem-safe; a same-millisecond collision for the
    // same seat gets a numeric suffix rather than an overwrite.
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    let envelopePath = path.join(envelopesDir, `${ts}-${seat}.json`);
    for (let n = 2; fs.existsSync(envelopePath); n++) {
      envelopePath = path.join(envelopesDir, `${ts}-${seat}-${n}.json`);
    }
    writeJson(envelopePath, envelope);

    // File first, ledger second: the event names a path, and an event naming a
    // path that does not exist yet would be false the moment it was written.
    const seq = appendRecord(ledgerPathOf(treeRoot), {
      kind: 'envelope',
      payload: {
        mission_id: missionId,
        seat,
        state: envelope.state,
        path: path.relative(treeRoot, envelopePath),
      },
      correlation_id: missionId,
    }).seq;

    return { mission_id: missionId, seat, envelope_path: envelopePath, ledger_seq: seq };
  });
}

// --- record-consult ----------------------------------------------------------

function recordConsult(treeRoot, missionId, input) {
  if (!isSafeSegment(missionId)) {
    throw new TypeError(`mission: missionId must match ${SEGMENT_RE}`);
  }
  if (!isPlainObject(input)) {
    throw new TypeError('mission: record-consult requires a JSON object via stdin');
  }
  assertExactKeys(input, ['consult_id', 'question', 'verdict', 'anchor'], [], 'consult input');
  for (const key of ['consult_id', 'question', 'verdict', 'anchor']) {
    if (!isNonEmptyString(input[key])) {
      throw new TypeError(`mission: consult field "${key}" must be a non-empty string`);
    }
  }

  const statePath = statePathOf(treeRoot);

  // Same discipline as record-envelope: open-status is decided under the
  // state lock, so a racing close can never be interleaved with this append.
  return withLock(statePath, () => {
    const state = readJson(statePath, undefined);
    requireOpenMission(state, statePath, missionId);

    const seq = appendRecord(ledgerPathOf(treeRoot), {
      kind: 'consult',
      payload: {
        mission_id: missionId,
        consult_id: input.consult_id,
        question: input.question,
        verdict: input.verdict,
        anchor: input.anchor,
      },
      correlation_id: missionId,
    }).seq;

    return { mission_id: missionId, consult_id: input.consult_id, ledger_seq: seq };
  });
}

// --- close: ledger derivation ------------------------------------------------

// The whole close input: sequence references and nothing else. Every enforced
// fact is derived from the records these name; there is no key a caller could
// use to assert a family, a verdict, or an identity.
const CLOSE_KEYS = [
  'author_route_seq',
  'author_dispatch_seq',
  'review_route_seq',
  'review_dispatch_seq',
  'gate_seq',
  'winning_author_dispatch_seq',
  'winning_review_dispatch_seq',
];

const INDEPENDENCE_VALUES = new Set(['cross-family', 'degraded-path']);

// Where the landed result is proven. Same candidates, same order, as gate.js's
// merge-base resolution, so every stage of the chain measures against the same
// landing line.
const LANDING_BRANCHES = ['main', 'master'];

// The canonical patch, pinned knob for knob to gate.js's PATCH_ARGS (which is
// not exported): the reviewed patch fed to `git patch-id` must be produced by
// the same rules as the digest the review route recorded, or the squash proof
// would compare two different notions of "the patch".
const PATCH_ARGS = [
  'diff',
  '--no-color',
  '--no-ext-diff',
  '--no-textconv',
  '--full-index',
  '--binary',
  '--no-renames',
  '--diff-algorithm=myers',
  '-U3',
  '--src-prefix=a/',
  '--dst-prefix=b/',
];

// An inherited GIT_DIR (or friends) would silently aim git at a different
// repository than the path we were asked about.
function gitEnv() {
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR']) {
    delete env[key];
  }
  return env;
}

function git(repo, args, input) {
  return spawnSync('git', ['--no-optional-locks', '-C', repo, ...args], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    input: input === undefined ? '' : input,
    env: gitEnv(),
  });
}

function gitOut(repo, args, what, input) {
  const outcome = git(repo, args, input);
  if (outcome.error) {
    throw new Error(`mission: could not run git in "${repo}" (${what}): ${outcome.error.message}`);
  }
  if (outcome.status !== 0) {
    const detail = (outcome.stderr || '').trim().split('\n')[0] || `exit ${outcome.status}`;
    throw new Error(`mission: git ${args[0]} failed in "${repo}" (${what}): ${detail}`);
  }
  return outcome.stdout.trim();
}

// The landing can only be proven in a real git repository: a directory git
// does not track can neither contain the reviewed commit nor carry its patch.
function requireLandingRepo(repo) {
  if (!isNonEmptyString(repo)) {
    throw new TypeError('mission: the landing repository must be a non-empty path');
  }
  let stat;
  try {
    stat = fs.statSync(repo);
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(`mission: no such landing repository "${repo}"`);
    throw err;
  }
  if (!stat.isDirectory()) {
    throw new Error(`mission: landing repository "${repo}" is not a directory`);
  }
  if (git(repo, ['rev-parse', '--show-toplevel']).status !== 0) {
    throw new Error(`mission: "${repo}" is not a git worktree — the landed result can only be proven in a real git context`);
  }
}

function landingBranchOf(repo) {
  for (const branch of LANDING_BRANCHES) {
    const outcome = git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    if (outcome.status === 0 && outcome.stdout.trim() !== '') {
      return { branch, head: outcome.stdout.trim() };
    }
  }
  throw new Error(
    `mission: close refused — no landing branch (${LANDING_BRANCHES.join(' or ')}) exists in "${repo}", so nothing can have landed`
  );
}

// `git patch-id --stable` over a canonical patch: whitespace and hunk offsets
// are normalised away, which is exactly right for proving a squash landed an
// equivalent change (and exactly why the identity digest does NOT use it).
function patchIdOf(repo, patch) {
  const out = gitOut(repo, ['patch-id', '--stable'], 'patch identity', patch);
  return out === '' ? null : out.split(/\s+/)[0];
}

// Post-merge proof that the landed result is the reviewed result (§7 chain):
// an ordinary merge is proven by commit containment — the exact reviewed
// commit is an ancestor of the landing branch; a squash merge, whose landed
// commit is a different object by construction, is proven by patch identity
// over the canonical patch. Nothing weaker closes.
function proveLanding(repo, identity) {
  requireLandingRepo(repo);
  const head = identity.source_head;

  if (git(repo, ['rev-parse', '--verify', '--quiet', `${head}^{commit}`]).status !== 0) {
    throw new Error(
      `mission: close refused — the reviewed commit ${head} is unknown to "${repo}"; a landing cannot be proven where the artifact never existed`
    );
  }
  // Like against like, at the landing stage too: the recorded tree must be
  // the tree of the recorded commit, or the identity never described one
  // artifact in the first place.
  const tree = gitOut(repo, ['rev-parse', `${head}^{tree}`], 'reviewed tree');
  if (tree !== identity.source_tree) {
    throw new Error(
      `mission: close refused — recorded source_tree ${identity.source_tree} is not the tree of source_head ${head} (${tree}); the reviewed identity does not describe one artifact`
    );
  }

  const landing = landingBranchOf(repo);
  const contained = git(repo, ['merge-base', '--is-ancestor', head, landing.head]);
  if (contained.status === 0) {
    return { method: 'commit-containment', branch: landing.branch, landed_head: landing.head };
  }
  if (contained.status !== 1) {
    const detail = (contained.stderr || '').trim().split('\n')[0] || `exit ${contained.status}`;
    throw new Error(`mission: git merge-base failed in "${repo}" (containment): ${detail}`);
  }

  const baseOutcome = git(repo, ['merge-base', head, landing.head]);
  if (baseOutcome.status !== 0) {
    throw new Error(
      `mission: close refused — the reviewed commit ${head} shares no history with ${landing.branch}; nothing of it can have landed`
    );
  }
  const base = baseOutcome.stdout.trim();
  const reviewedId = patchIdOf(repo, gitOut(repo, [...PATCH_ARGS, base, head], 'reviewed canonical patch'));
  if (reviewedId === null) {
    throw new Error(
      `mission: close refused — the reviewed change is empty against its merge base; there is nothing whose landing could be proven`
    );
  }

  const listed = gitOut(repo, ['rev-list', '--no-merges', `${base}..${landing.head}`], 'landed commits');
  for (const commit of listed === '' ? [] : listed.split('\n')) {
    // A parentless commit squashed nothing; skip rather than fail the walk.
    if (git(repo, ['rev-parse', '--verify', '--quiet', `${commit}^^{commit}`]).status !== 0) continue;
    const patch = gitOut(repo, [...PATCH_ARGS, `${commit}^`, commit], 'landed canonical patch');
    if (patchIdOf(repo, patch) === reviewedId) {
      return { method: 'squash-patch-identity', branch: landing.branch, landed_head: commit };
    }
  }
  throw new Error(
    `mission: close refused — ${landing.branch} neither contains the reviewed commit ${head} nor carries any commit with its patch identity; the landed result is not proven to be the reviewed result`
  );
}

function recordsAtSeq(records, seq) {
  return records.filter((r) => isPlainObject(r) && r.seq === seq);
}

function routeOfMission(records, missionId, seq, phase, label) {
  const matches = recordsAtSeq(records, seq);
  if (matches.length === 0) {
    throw new Error(`mission: close refused — no ledger record has seq ${seq} (${label})`);
  }
  if (matches.length > 1) {
    throw new Error(`mission: close refused — seq ${seq} is ambiguous (${matches.length} records carry it)`);
  }
  const route = matches[0];
  if (route.kind !== 'route') {
    throw new Error(
      `mission: close refused — ledger record at seq ${seq} has kind "${route.kind}", not "route" (${label})`
    );
  }
  if (route.mission_id !== missionId) {
    throw new Error(
      `mission: close refused — ${label} at seq ${seq} belongs to mission ${JSON.stringify(route.mission_id)}, not "${missionId}"`
    );
  }
  if (route.phase !== phase) {
    throw new Error(
      `mission: close refused — ${label} at seq ${seq} is a "${route.phase}"-phase route, not "${phase}"-phase`
    );
  }
  return route;
}

// "The dispatch belongs to this mission." The dispatch ledger record's writer
// (roster.js's post-registration append, §17) ships in a later step, so
// existence cannot yet be required here — the review route binds the seq as a
// shape for the same reason. What the disk can already decide is decided: a
// seq that names another mission's record is a provable lie and refuses the
// close; a seq no record carries yet claims nothing either way, and a legal
// close is never invalidated by a writer arriving later.
function checkDispatchMembership(records, missionId, seq, label) {
  const matches = recordsAtSeq(records, seq);
  if (matches.length > 1) {
    throw new Error(`mission: close refused — seq ${seq} is ambiguous (${matches.length} records carry it)`);
  }
  if (matches.length === 0) return;
  const record = matches[0];
  const owner = isNonEmptyString(record.mission_id)
    ? record.mission_id
    : isNonEmptyString(record.correlation_id)
      ? record.correlation_id
      : null;
  if (owner !== null && owner !== missionId) {
    throw new Error(
      `mission: close refused — ${label} ${seq} names a record belonging to mission "${owner}", not "${missionId}"`
    );
  }
}

function requireUnsuperseded(records, missionId, routeSeq, label) {
  const superseded = records.find(
    (r) =>
      isPlainObject(r) &&
      r.kind === 'route-superseded' &&
      r.mission_id === missionId &&
      r.predecessor_route_seq === routeSeq
  );
  if (superseded) {
    throw new Error(
      `mission: close refused — ${label} at seq ${routeSeq} was superseded by route ${superseded.replacement_route_seq} (seq ${superseded.seq}); only the winning route closes a mission`
    );
  }
}

// Independence and floor, judged against the records alone. A degraded-path
// review is legal at every class, apex included (no class ceiling), under the
// route snapshot that authorized it — deliberately, there is no code here
// that consults preflight, settings, or any present-day lane state, which is
// what makes a provider's recovery after a legal degraded review incapable of
// retroactively invalidating it.
function checkReviewLegality(authorRoute, reviewRoute) {
  const family = authorRoute.author_family;
  if (!INDEPENDENCE_VALUES.has(reviewRoute.independence)) {
    throw new Error(
      `mission: close refused — review route independence ${JSON.stringify(reviewRoute.independence)} is outside ${[...INDEPENDENCE_VALUES].join(' | ')}`
    );
  }
  if (reviewRoute.independence === 'cross-family' && reviewRoute.reviewer_family === family) {
    throw new Error(
      `mission: close refused — review is labeled cross-family but reviewer family "${reviewRoute.reviewer_family}" is the author family: a degraded review reported as cross-family is a laundered label`
    );
  }
  const reserved = authorRoute.reserved_review;
  const honoured =
    isPlainObject(reserved) &&
    reserved.seat === reviewRoute.reviewer_seat &&
    reserved.family === reviewRoute.reviewer_family &&
    reserved.model === reviewRoute.reviewer_model &&
    reserved.effort === reviewRoute.reviewer_effort &&
    reserved.independence === reviewRoute.independence;
  if (!honoured && !isNonEmptyString(reviewRoute.replacement_reason)) {
    throw new Error(
      `mission: close refused — the review profile differs from the capacity reserved at route time ${JSON.stringify(reserved)} with no recorded replacement_reason; the floor recorded at route time was not met`
    );
  }
}

function reviewedIdentityOf(reviewRoute, reviewRouteSeq) {
  const identity = reviewRoute.artifact_identity;
  if (!isPlainObject(identity)) {
    throw new Error(
      `mission: close refused — review route at seq ${reviewRouteSeq} carries no artifact identity; nothing binds what was reviewed`
    );
  }
  if (identity.dirty !== false) {
    throw new Error(
      `mission: close refused — the reviewed artifact identity is dirty; a dirty worktree is never a reviewable artifact`
    );
  }
  return identity;
}

// The gate's identity binding (§7 chain). A record from before identities were
// carried has neither field and claims nothing either way — it still closes,
// since a legal close is never invalidated by a field arriving later. A record
// that does carry them must name the reviewed artifact, field by field, and
// its identity_check must not report that the tree changed during the run —
// the same rule check-honesty applies, so close and the audit agree on the
// same record.
function checkGateIdentity(gate, reviewedIdentity, gateSeq) {
  const hasIdentity = Object.prototype.hasOwnProperty.call(gate, 'artifact_identity');
  const hasCheck = Object.prototype.hasOwnProperty.call(gate, 'identity_check');
  if (!hasIdentity && !hasCheck) return;

  if (!isPlainObject(gate.artifact_identity)) {
    throw new Error(
      `mission: close refused — gate record at seq ${gateSeq} could not name the identity it tested; a gate that names no artifact is not evidence for this one`
    );
  }
  const changed = IDENTITY_FIELDS.filter((field) => gate.artifact_identity[field] !== reviewedIdentity[field]);
  if (changed.length > 0) {
    throw new Error(
      `mission: close refused — the gate at seq ${gateSeq} tested a different artifact than the review: field(s) ${changed.join(', ')} differ; the artifact changed between review and gate`
    );
  }
  const check = gate.identity_check;
  if (isPlainObject(check) && check.verified === false) {
    const fields = Array.isArray(check.changed) ? check.changed.map((c) => c.field).join(', ') : 'unknown field(s)';
    throw new Error(
      `mission: close refused — gate record at seq ${gateSeq} mutated the tree it tested (${fields} changed across the run); such a pass is not evidence for the artifact it named`
    );
  }
}

// Everything the ledger can decide about this close, decided in one place.
// Returns the resolved records; every check refuses by throwing.
function deriveCloseFacts(records, missionId, input) {
  const authorRoute = routeOfMission(records, missionId, input.author_route_seq, 'author', 'author route');
  const reviewRoute = routeOfMission(records, missionId, input.review_route_seq, 'review', 'review route');

  if (reviewRoute.author_route_seq !== input.author_route_seq) {
    throw new Error(
      `mission: close refused — review route at seq ${input.review_route_seq} binds author route ${reviewRoute.author_route_seq}, not ${input.author_route_seq}`
    );
  }
  if (reviewRoute.author_dispatch_seq !== input.author_dispatch_seq) {
    throw new Error(
      `mission: close refused — review route at seq ${input.review_route_seq} binds author dispatch ${reviewRoute.author_dispatch_seq}, not ${input.author_dispatch_seq}`
    );
  }

  checkDispatchMembership(records, missionId, input.author_dispatch_seq, 'author dispatch seq');
  checkDispatchMembership(records, missionId, input.review_dispatch_seq, 'review dispatch seq');

  // The cited route chain must be un-superseded (below), which makes it the
  // winning topology — so the winning attribution must be the very dispatches
  // that chain binds, not seqs of the caller's choosing.
  if (input.winning_author_dispatch_seq !== reviewRoute.author_dispatch_seq) {
    throw new Error(
      `mission: close refused — winning_author_dispatch_seq ${input.winning_author_dispatch_seq} is not the author dispatch ${reviewRoute.author_dispatch_seq} the winning review route binds`
    );
  }
  if (input.winning_review_dispatch_seq !== input.review_dispatch_seq) {
    throw new Error(
      `mission: close refused — winning_review_dispatch_seq ${input.winning_review_dispatch_seq} is not the cited review dispatch ${input.review_dispatch_seq}`
    );
  }

  requireUnsuperseded(records, missionId, input.author_route_seq, 'author route');
  requireUnsuperseded(records, missionId, input.review_route_seq, 'review route');

  checkReviewLegality(authorRoute, reviewRoute);
  const identity = reviewedIdentityOf(reviewRoute, input.review_route_seq);

  // Gate evidence: kind, mission, real exit 0, latest-by-seq for its gate_id
  // (check-honesty's law — a stale success can never paper over a later
  // failure), and the §7 identity binding.
  const gateSeq = input.gate_seq;
  const gateMatches = recordsAtSeq(records, gateSeq);
  if (gateMatches.length === 0) {
    throw new Error(`mission: close refused — no ledger record has seq ${gateSeq}`);
  }
  if (gateMatches.length > 1) {
    throw new Error(`mission: close refused — seq ${gateSeq} is ambiguous (${gateMatches.length} records carry it)`);
  }
  const gate = gateMatches[0];
  if (gate.kind !== 'gate') {
    throw new Error(
      `mission: close refused — ledger record at seq ${gateSeq} has kind "${gate.kind}", not "gate"`
    );
  }
  if (gate.mission_id !== missionId) {
    throw new Error(
      `mission: close refused — gate record at seq ${gateSeq} belongs to mission ${JSON.stringify(gate.mission_id)}, not "${missionId}"`
    );
  }
  if (gate.exit_code !== 0) {
    throw new Error(
      `mission: close refused — gate record at seq ${gateSeq} has exit_code ${JSON.stringify(gate.exit_code)}, and only a real 0 closes a mission`
    );
  }
  for (const record of records) {
    if (!isPlainObject(record) || record.kind !== 'gate') continue;
    if (record.mission_id !== missionId || record.gate_id !== gate.gate_id) continue;
    if (Number.isSafeInteger(record.seq) && record.seq > gate.seq) {
      throw new Error(
        `mission: close refused — gate "${gate.gate_id}" at seq ${gateSeq} is superseded by a later run at seq ${record.seq} (latest-by-seq honesty)`
      );
    }
  }
  checkGateIdentity(gate, identity, gateSeq);

  return { authorRoute, reviewRoute, gate, identity };
}

function closePayloadOf(missionId, input, facts, landing) {
  const identity = {};
  for (const field of IDENTITY_FIELDS) identity[field] = facts.identity[field];
  return {
    mission_id: missionId,
    author_route_seq: input.author_route_seq,
    author_dispatch_seq: input.author_dispatch_seq,
    review_route_seq: input.review_route_seq,
    review_dispatch_seq: input.review_dispatch_seq,
    gate_seq: input.gate_seq,
    winning_author_dispatch_seq: input.winning_author_dispatch_seq,
    winning_review_dispatch_seq: input.winning_review_dispatch_seq,
    author_family: facts.authorRoute.author_family,
    author_seat: facts.authorRoute.resolved_seat,
    task_class: facts.authorRoute.task_class,
    review: {
      seat: facts.reviewRoute.reviewer_seat,
      family: facts.reviewRoute.reviewer_family,
      model: facts.reviewRoute.reviewer_model,
      effort: facts.reviewRoute.reviewer_effort,
      independence: facts.reviewRoute.independence,
      replacement_reason: facts.reviewRoute.replacement_reason === undefined ? null : facts.reviewRoute.replacement_reason,
    },
    artifact_identity: identity,
    landing,
  };
}

// --- close -------------------------------------------------------------------

function closeMission(treeRoot, missionId, input, options) {
  if (!isSafeSegment(missionId)) {
    throw new TypeError(`mission: missionId must match ${SEGMENT_RE}`);
  }
  if (!isPlainObject(input)) {
    throw new TypeError('mission: close requires a JSON object via stdin');
  }
  assertExactKeys(input, CLOSE_KEYS, [], 'close input');
  for (const key of CLOSE_KEYS) {
    if (!Number.isSafeInteger(input[key]) || input[key] < 0) {
      throw new TypeError(`mission: "${key}" must be a nonnegative integer naming a ledger seq`);
    }
  }
  const repo = isPlainObject(options) && isNonEmptyString(options.repo) ? options.repo : process.cwd();

  const statePath = statePathOf(treeRoot);
  const ledgerPath = ledgerPathOf(treeRoot);
  let closeSeq;
  let payload;

  updateJson(
    statePath,
    (current) => {
      const state = current;
      const entry = requireOpenMission(state, statePath, missionId);

      const { records, errors } = readRecords(ledgerPath);
      if (errors.length > 0) {
        const detail = errors.map((e) => `line ${e.line}: ${e.reason}`).join('; ');
        throw new Error(`mission: ${ledgerPath} has malformed record(s) — refusing to trust this stream: ${detail}`);
      }

      const facts = deriveCloseFacts(records, missionId, input);
      const landing = proveLanding(repo, facts.identity);
      payload = closePayloadOf(missionId, input, facts, landing);

      closeSeq = appendRecord(ledgerPath, {
        kind: 'mission-close',
        payload,
        correlation_id: missionId,
      }).seq;

      const next = {
        ...state,
        missions: {
          ...missionsOf(state, statePath),
          [missionId]: { ...entry, status: MISSION_STATUSES.DONE, next_action: null },
        },
      };
      // A resume pointer aimed at a mission that just finished is stale the
      // moment the close lands.
      if (next.active_mission === missionId) {
        next.active_mission = null;
      }
      return next;
    },
    undefined
  );

  return {
    mission_id: missionId,
    status: MISSION_STATUSES.DONE,
    ledger_seq: closeSeq,
    gate_seq: input.gate_seq,
    landing: payload.landing,
  };
}

// --- CLI ---------------------------------------------------------------------

const HELP = `mission.js — maestro mission lifecycle (sole writer of mission records)

usage: mission.js <command> [flags] <treeRoot> [args]   (input JSON piped via stdin)

commands:
  open <treeRoot>
      stdin { mission_id, title, brief, next_action? } — brief is the
      eight-field dispatch brief and is validated before anything is written.
      Creates missions/<id>/{brief.json, mailbox/, envelopes/, artifacts/,
      progress.jsonl (genesis-seeded)}, appends ledger kind "mission-open",
      and sets state.json.missions[<id>] = { status: "open", next_action }.
      One-shot: an existing mission id or directory refuses the open.
  checkpoint <treeRoot> <missionId>
      stdin { step, done_evidence, next } — appends a "checkpoint" record to
      missions/<id>/progress.jsonl and moves state.json.missions[<id>]
      .next_action to next. Open missions only.
  record-envelope <treeRoot> <missionId> <seat>
      stdin: a six-field worker envelope, validated (invalid is refused with
      the exact validator errors). Written atomically to
      missions/<id>/envelopes/<ts>-<seat>.json, then ledger kind "envelope".
  record-consult <treeRoot> <missionId>
      stdin { consult_id, question, verdict, anchor } — ledger kind "consult".
  close [--repo <path>] <treeRoot> <missionId>
      stdin: sequence references and nothing else —
      { ${CLOSE_KEYS.join(', ')} }
      (the winning seqs equal the primary ones in the single-attempt case).
      Every enforced fact is DERIVED from the records those seqs name, never
      accepted from the caller: the author family comes from the author-phase
      route record, the reviewer profile, independence and reviewed artifact
      identity from the review-phase route record, pass evidence from the
      gate record. REFUSES when: either route is missing, ambiguous, of the
      wrong kind/phase/mission, or superseded by a replacement; the review
      route binds a different author route or author dispatch; a dispatch seq
      names another mission's record; the winning seqs are not the dispatches
      the cited chain binds; a review labeled cross-family names a reviewer
      of the author's own family; the review profile differs from the
      capacity reserved at route time with no replacement_reason; the gate is
      not exit 0, not this mission's, not the latest run of its gate_id, or
      names a different artifact identity than the review (field by field —
      a digest is never compared with a commit sha) or reports its tree
      changed during the run; or the landed result is not proven equivalent
      in --repo (default: current directory): commit containment for an
      ordinary merge, patch identity over the canonical patch for a squash.
      A degraded-path review is legal at every class under the route snapshot
      that authorized it; close reads no present-day provider state, so a
      provider recovering after a legal degraded review changes nothing. On
      success sets status "done" and appends ledger kind "mission-close"
      naming the derived facts and the landing proof.

Prints a result JSON on success and exits 0; any refusal prints its reason to
stderr and exits 1.
`;

function readStdinJson() {
  let text;
  try {
    text = fs.readFileSync(0, 'utf8'); // fd 0 = stdin
  } catch (err) {
    throw new Error(`stdin could not be read: ${err.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`stdin did not carry valid JSON: ${err.message}`);
  }
}

// Positional arity per command, after <command> itself. Fail-closed: a
// surplus argument or an unknown command is a refusal, never ignored.
const COMMAND_ARITY = {
  open: 1,
  checkpoint: 2,
  'record-envelope': 3,
  'record-consult': 2,
  close: 2,
};

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  const [command, ...restRaw] = argv;
  if (!Object.prototype.hasOwnProperty.call(COMMAND_ARITY, command)) {
    process.stderr.write(
      `mission.js: ${command === undefined ? 'a command is required' : `unknown command "${command}"`}\n${HELP}`
    );
    process.exit(1);
  }
  // close takes an optional leading --repo <path> naming the repository the
  // landing is proven in; it is a location, not an asserted fact — the proof
  // itself is derived by git from the recorded identity.
  let rest = restRaw;
  let closeRepo;
  if (command === 'close' && rest[0] === '--repo') {
    if (rest.length < 2) {
      process.stderr.write(`mission.js: --repo requires a path\n${HELP}`);
      process.exit(1);
    }
    closeRepo = rest[1];
    rest = rest.slice(2);
  }
  if (rest.length !== COMMAND_ARITY[command]) {
    process.stderr.write(
      `mission.js: "${command}" takes exactly ${COMMAND_ARITY[command]} argument(s), got ${rest.length}\n${HELP}`
    );
    process.exit(1);
  }
  const [treeRoot] = rest;
  if (!isNonEmptyString(treeRoot)) {
    process.stderr.write(`mission.js: <treeRoot> must be a non-empty path\n`);
    process.exit(1);
  }

  try {
    const input = readStdinJson();
    let result;
    if (command === 'open') {
      result = openMission(treeRoot, input);
    } else if (command === 'checkpoint') {
      result = checkpointMission(treeRoot, rest[1], input);
    } else if (command === 'record-envelope') {
      result = recordEnvelope(treeRoot, rest[1], rest[2], input);
    } else if (command === 'record-consult') {
      result = recordConsult(treeRoot, rest[1], input);
    } else {
      result = closeMission(treeRoot, rest[1], input, { repo: closeRepo });
    }
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exit(0);
  } catch (err) {
    process.stderr.write(`mission.js: ${err.message}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = {
  openMission,
  checkpointMission,
  recordEnvelope,
  recordConsult,
  closeMission,
  CLOSE_KEYS,
  LANDING_BRANCHES,
  MISSION_STATUSES,
};
