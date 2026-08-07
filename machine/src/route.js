'use strict';

// maestro machine layer — route lifecycle (sole writer of ledger kinds
// "route" and "route-superseded").
//
// ONE record kind carries the whole lifecycle: `route`, with a mandatory
// `phase` of "author" or "review" (execution-plan §7 — no five-kind zoo). The
// author-phase record is reserved before any author spawn and carries the
// reserved review capacity with it; the review-phase record is written after
// the author completes and before any review dispatch, and names the exact
// artifact identity it will judge. Records are immutable and ledger-appended:
// a predecessor is never overwritten or reinterpreted, only superseded.
//
// SELECTION HONESTY (§7 correction 9) is enforced, not merely documented.
// Fresh resolution SKIPS an ineligible candidate into `candidates_skipped`; it
// may never record a requested-then-substituted pair for a seat that was never
// eligible. `substituted: true` is legal only for a route that supersedes a
// predecessor, and must name that predecessor's own resolved seat as the seat
// it requested — so "substituted" always points at a concrete route that
// really was reserved. The four vocabularies stay distinct: candidate-skipped
// lives here in `selection`, route-superseded is its own record, and
// provider-rerouted / family-reattributed belong to friction.js and to
// roster.js's outcome telemetry respectively — never to this record.
//
// SUPERSESSION IS REPLACEMENT-FIRST. `supersede` reserves and validates the
// replacement route and only then appends the supersession record. A crash
// between the two writes leaves a valid orphan reservation that nothing points
// at — never a supersession pointing at a replacement that does not exist.
// The escalation budgets below therefore count *distinct predecessors*, so a
// retry after such a crash is not charged twice for one escalation event.
//
// A REVIEWER'S FAMILY IS DERIVED, NOT ACCEPTED. `reviewer_family` names a fact
// about the seat, and the routing config's seat table is where that fact lives,
// so both writers of a review-phase record resolve it there and refuse a record
// the config contradicts. It was never enough to cross-check the field against
// the author route's reserved capacity: both are the caller's own words, so the
// pair can agree and still be false — which is how a `reviewer-gemini` seat with
// family `claude` entered the ledger through the sanctioned path, defeating §8's
// cross-family law with one lawful call and no forgery.
//
// The §9 escalation state machine is validated here from day one, even though
// its full consumer lands in a later slice: every route naming a predecessor
// declares a transition and a reason, and this module decides whether that
// claim is legal against the ledger. An `escalation_profile` claim is
// convenience input, never authority — the recorded chain decides.

const fs = require('node:fs');
const path = require('node:path');

const { withLock, appendRecord, readRecords } = require('./jsonl.js');
const { readJson } = require('./atomic-json.js');
const { BRIEF_TIER_VALUES } = require('./validators.js');
const { FAMILIES, DATED_CONFIG_RE, loadRouting } = require('./routing.js');

const LEDGER_BASENAME = 'ledger.jsonl';
const STATE_BASENAME = 'state.json';
const ROUTE_KIND = 'route';
const SUPERSEDED_KIND = 'route-superseded';

const PHASES = ['author', 'review'];
// The §9 escalation ordering over the brief's task-class vocabulary: "higher"
// is what class-escalation must climb, and apex is the top with nothing above.
const CLASS_ORDER = ['recon', 'mechanical', 'standard', 'expert', 'apex'];
const TRANSITIONS = [
  'same-profile-resume',
  'same-class-provider-reroute',
  'class-escalation',
  'within-class-profile-escalation',
  'convergence',
];
const REASONS = ['quality', 'infrastructure', 'quota', 'safety-refusal'];
const INDEPENDENCE = ['cross-family', 'degraded-path'];
// A candidate is skipped because the lane is down or the capability is absent.
// Anything else is a different event with a different record.
const SKIP_REASONS = ['lane-down', 'capability-absent'];
// The two transitions that spend the mission's single profile escalation.
const ESCALATION_TRANSITIONS = ['class-escalation', 'within-class-profile-escalation'];
// Escalation and convergence answer a quality disagreement; infrastructure,
// quota and runtime trouble reroute in class and consume no quality budget.
const QUALITY_ONLY_TRANSITIONS = [...ESCALATION_TRANSITIONS, 'convergence'];
// A reviewer is replaced in class; escalation is an author-profile concept.
const REVIEW_TRANSITION = 'same-class-provider-reroute';
// What "same profile" means when a resume claims to be one.
const PROFILE_FIELDS = ['task_class', 'resolved_seat', 'worker_model', 'worker_effort', 'host_model', 'host_effort'];

const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
// git object ids, sha1 today and sha256 where a repository has moved to it.
const GIT_OID_RE = /^([0-9a-f]{40}|[0-9a-f]{64})$/;
const SINGLE_LINE_RE = /^[^\r\n]*$/;

const TEXT_CEILING = 200;
const TOKEN_CEILING = 60;
const NOTICES_MAX = 20;
const SKIPPED_MAX = 20;
const DEGRADED_MAX = 10;
const LANE_MAX = 10;

// --- shared shape helpers ----------------------------------------------------

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function checkExactKeys(obj, required, optional, label, errors) {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) errors.push(`${label} has unexpected extra key "${key}"`);
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) {
      errors.push(`${label} is missing required key "${key}"`);
    }
  }
}

// A bare name: seat, model, effort and lane tokens all share this shape, so a
// path fragment or an injected newline can never enter a durable record.
function checkToken(errors, value, label, max = TOKEN_CEILING) {
  if (!isNonEmptyString(value)) {
    errors.push(`${label} must be a non-empty string`);
    return;
  }
  if (value.length > max) {
    errors.push(`${label} must be at most ${max} characters`);
    return;
  }
  if (!SEGMENT_RE.test(value)) {
    errors.push(`${label} must be a bare name matching ${SEGMENT_RE}`);
  }
}

function checkPhrase(errors, value, label, max = TEXT_CEILING) {
  if (!isNonEmptyString(value)) {
    errors.push(`${label} must be a non-empty single-line string`);
    return;
  }
  if (!SINGLE_LINE_RE.test(value)) {
    errors.push(`${label} must not contain a newline or carriage return`);
    return;
  }
  if (value.length > max) {
    errors.push(`${label} must be at most ${max} characters`);
  }
}

function checkInt(errors, value, label, min) {
  if (!Number.isSafeInteger(value) || value < min) {
    errors.push(`${label} must be an integer >= ${min}`);
  }
}

function checkDigest(errors, value, label) {
  if (typeof value !== 'string' || !DIGEST_RE.test(value)) {
    errors.push(`${label} must be a sha256 digest ("sha256:" followed by 64 hex characters)`);
  }
}

function checkEnum(errors, value, label, allowed) {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    errors.push(`${label} must be one of ${allowed.join(', ')} (got ${JSON.stringify(value)})`);
  }
}

function checkBoolean(errors, value, label) {
  if (typeof value !== 'boolean') errors.push(`${label} must be a boolean`);
}

// Both null (a native seat runs the model directly) or both present (a hosted
// seat's host is a real second placement). One of each is an unreadable record.
function checkHostPair(errors, model, effort, modelKey, effortKey, label) {
  const bothNull = model === null && effort === null;
  const bothSet = isNonEmptyString(model) && isNonEmptyString(effort);
  if (!bothNull && !bothSet) {
    errors.push(
      `${label} fields "${modelKey}" and "${effortKey}" must both be null (native seat) or both be non-empty strings (hosted seat)`
    );
    return;
  }
  if (bothSet) {
    checkToken(errors, model, `${label} field "${modelKey}"`);
    checkToken(errors, effort, `${label} field "${effortKey}"`);
  }
}

// --- the seat table: a family is derived, never asserted ---------------------

// A family a record ASSERTS is worth nothing on its own: the assertion and the
// reservation it is cross-checked against are both the caller's, so the pair
// can be self-consistent and false. The routing config is the authority on
// which family a seat belongs to — the same authority the parity sweep binds
// agent frontmatter to — and this is the single shape both fences read: this
// module at reservation time, mission.js again at close.
//
// Three ways the family fails to come out, and all three are the same answer:
// no family. An alias seat is deliberately NOT resolved, matching routing.js's
// own read rule (an alias exists only so an older config keeps validating, and
// is never routable), so a record naming one is refused by absence. A seat the
// table does not carry, and a seat entry that records no family, likewise
// establish nothing. Callers refuse on `family === null` — a family that
// cannot be established has not been established, and there is no default.
function seatFamily(treeRoot, seatName) {
  let config;
  try {
    ({ config } = loadRouting(treeRoot));
  } catch (err) {
    return { family: null, reason: `the routing config could not be read (${err.message})` };
  }
  const seats = isPlainObject(config.seats) ? config.seats : {};
  const seat = Object.prototype.hasOwnProperty.call(seats, seatName) ? seats[seatName] : undefined;
  if (!isPlainObject(seat)) {
    return { family: null, reason: `the routing config's seat table records no seat "${seatName}"` };
  }
  if (Object.prototype.hasOwnProperty.call(seat, 'alias_of')) {
    return {
      family: null,
      reason: `the routing config records "${seatName}" as an alias of "${seat.alias_of}", and an alias seat is never routable`,
    };
  }
  if (!isNonEmptyString(seat.family)) {
    return { family: null, reason: `the routing config's entry for seat "${seatName}" records no family` };
  }
  return { family: seat.family, reason: null };
}

// --- author-phase route shape ------------------------------------------------

const AUTHOR_KEYS = [
  'mission_id',
  'attempt',
  'brief_digest',
  'task_class',
  'routing_config',
  'routing_digest',
  'routing_revision',
  'requested_seat',
  'resolved_seat',
  'author_family',
  'worker_model',
  'worker_effort',
  'host_model',
  'host_effort',
  'fallback_profile',
  'escalation_profile',
  'selection',
  'reserved_review',
  'lane_state',
  'degraded_modes',
  'notices',
];

const SELECTION_KEYS = ['candidates_skipped', 'substituted', 'substitution_reason'];
const RESERVED_REVIEW_KEYS = ['seat', 'family', 'model', 'effort', 'independence'];

function validateAuthorRoute(input, hasPredecessor) {
  try {
    return validateAuthorRouteChecked(input, hasPredecessor === true);
  } catch (err) {
    return { ok: false, errors: [`author route could not be inspected: ${err.message}`] };
  }
}

function validateAuthorRouteChecked(input, hasPredecessor) {
  if (!isPlainObject(input)) {
    return { ok: false, errors: ['author route must be a plain object'] };
  }
  const errors = [];
  const label = 'author route';
  checkExactKeys(input, AUTHOR_KEYS, [], label, errors);

  checkToken(errors, input.mission_id, `${label} field "mission_id"`);
  checkInt(errors, input.attempt, `${label} field "attempt"`, 1);
  checkDigest(errors, input.brief_digest, `${label} field "brief_digest"`);
  checkEnum(errors, input.task_class, `${label} field "task_class"`, CLASS_ORDER);
  if (typeof input.routing_config !== 'string' || !DATED_CONFIG_RE.test(input.routing_config)) {
    errors.push(`${label} field "routing_config" must be a dated routing config filename (routing-YYYY-MM-DD-N.json)`);
  }
  checkDigest(errors, input.routing_digest, `${label} field "routing_digest"`);
  checkInt(errors, input.routing_revision, `${label} field "routing_revision"`, 1);
  checkToken(errors, input.requested_seat, `${label} field "requested_seat"`);
  checkToken(errors, input.resolved_seat, `${label} field "resolved_seat"`);
  checkEnum(errors, input.author_family, `${label} field "author_family"`, [...FAMILIES]);
  checkToken(errors, input.worker_model, `${label} field "worker_model"`);
  checkToken(errors, input.worker_effort, `${label} field "worker_effort"`);
  checkHostPair(errors, input.host_model, input.host_effort, 'host_model', 'host_effort', label);
  checkBoolean(errors, input.escalation_profile, `${label} field "escalation_profile"`);

  if (input.fallback_profile !== null) {
    if (!isPlainObject(input.fallback_profile)) {
      errors.push(`${label} field "fallback_profile" must be null or { model, effort }`);
    } else {
      checkExactKeys(input.fallback_profile, ['model', 'effort'], [], `${label} fallback_profile`, errors);
      if (Object.prototype.hasOwnProperty.call(input.fallback_profile, 'model')) {
        checkToken(errors, input.fallback_profile.model, `${label} fallback_profile field "model"`);
      }
      if (Object.prototype.hasOwnProperty.call(input.fallback_profile, 'effort')) {
        checkToken(errors, input.fallback_profile.effort, `${label} fallback_profile field "effort"`);
      }
    }
  }

  validateSelection(errors, input, label, hasPredecessor);

  if (!isPlainObject(input.reserved_review)) {
    errors.push(`${label} field "reserved_review" must be an object { seat, family, model, effort, independence }`);
  } else {
    const rr = input.reserved_review;
    checkExactKeys(rr, RESERVED_REVIEW_KEYS, [], `${label} reserved_review`, errors);
    if (Object.prototype.hasOwnProperty.call(rr, 'seat')) checkToken(errors, rr.seat, `${label} reserved_review field "seat"`);
    if (Object.prototype.hasOwnProperty.call(rr, 'family')) {
      checkEnum(errors, rr.family, `${label} reserved_review field "family"`, [...FAMILIES]);
    }
    if (Object.prototype.hasOwnProperty.call(rr, 'model')) checkToken(errors, rr.model, `${label} reserved_review field "model"`);
    if (Object.prototype.hasOwnProperty.call(rr, 'effort')) checkToken(errors, rr.effort, `${label} reserved_review field "effort"`);
    if (Object.prototype.hasOwnProperty.call(rr, 'independence')) {
      checkEnum(errors, rr.independence, `${label} reserved_review field "independence"`, INDEPENDENCE);
    }
  }

  if (!isPlainObject(input.lane_state) || Object.keys(input.lane_state).length === 0) {
    errors.push(`${label} field "lane_state" must be a non-empty object of provider -> lane state`);
  } else if (Object.keys(input.lane_state).length > LANE_MAX) {
    errors.push(`${label} field "lane_state" must hold at most ${LANE_MAX} providers`);
  } else {
    for (const [provider, state] of Object.entries(input.lane_state)) {
      checkPhrase(errors, state, `${label} lane_state[${JSON.stringify(provider)}]`, TOKEN_CEILING);
    }
  }

  if (!Array.isArray(input.degraded_modes) || input.degraded_modes.length > DEGRADED_MAX) {
    errors.push(`${label} field "degraded_modes" must be an array of at most ${DEGRADED_MAX} mode tokens`);
  } else {
    input.degraded_modes.forEach((mode, i) => checkToken(errors, mode, `${label} degraded_modes[${i}]`));
  }

  if (!Array.isArray(input.notices)) {
    errors.push(`${label} field "notices" must be an array of single-line notices`);
  } else if (input.notices.length > NOTICES_MAX) {
    errors.push(`${label} field "notices" must hold at most ${NOTICES_MAX} entries`);
  } else {
    input.notices.forEach((notice, i) => checkPhrase(errors, notice, `${label} notices[${i}]`));
  }

  // §9: an escalation-only profile is not a thing a first attempt may pick.
  if (input.escalation_profile === true && !hasPredecessor) {
    errors.push(
      `${label}: a fresh route may not select an escalation-only profile — an escalation profile is reached by superseding a route that defeated the ordinary one`
    );
  }

  return { ok: errors.length === 0, errors };
}

// Correction 9 in machine form. A skipped candidate and a substituted seat are
// different facts and may never stand in for one another.
function validateSelection(errors, input, label, hasPredecessor) {
  const selection = input.selection;
  if (!isPlainObject(selection)) {
    errors.push(`${label} field "selection" must be an object { candidates_skipped, substituted, substitution_reason }`);
    return;
  }
  checkExactKeys(selection, SELECTION_KEYS, [], `${label} selection`, errors);
  checkBoolean(errors, selection.substituted, `${label} selection field "substituted"`);

  const skipped = selection.candidates_skipped;
  const skippedSeats = new Set();
  if (!Array.isArray(skipped)) {
    errors.push(`${label} selection field "candidates_skipped" must be an array`);
  } else if (skipped.length > SKIPPED_MAX) {
    errors.push(`${label} selection field "candidates_skipped" must hold at most ${SKIPPED_MAX} entries`);
  } else {
    skipped.forEach((candidate, i) => {
      const at = `${label} selection candidates_skipped[${i}]`;
      if (!isPlainObject(candidate)) {
        errors.push(`${at} must be an object { seat, reason }`);
        return;
      }
      checkExactKeys(candidate, ['seat', 'reason'], [], at, errors);
      if (Object.prototype.hasOwnProperty.call(candidate, 'seat')) {
        checkToken(errors, candidate.seat, `${at} field "seat"`);
        if (isNonEmptyString(candidate.seat)) {
          if (skippedSeats.has(candidate.seat)) {
            errors.push(`${label} selection candidates_skipped names seat "${candidate.seat}" twice`);
          }
          skippedSeats.add(candidate.seat);
        }
      }
      if (Object.prototype.hasOwnProperty.call(candidate, 'reason')) {
        checkEnum(errors, candidate.reason, `${at} field "reason"`, SKIP_REASONS);
      }
    });
  }

  if (selection.substituted === true) {
    checkPhrase(errors, selection.substitution_reason, `${label} selection field "substitution_reason"`);
    if (!hasPredecessor) {
      errors.push(
        `${label} selection: a fresh route may not claim substituted:true — no concrete route was reserved before it to lose (§7 correction 9); an ineligible candidate belongs in candidates_skipped`
      );
    }
  } else {
    if (selection.substitution_reason !== null) {
      errors.push(`${label} selection field "substitution_reason" must be null unless substituted is true`);
    }
    if (isNonEmptyString(input.requested_seat) && input.requested_seat !== input.resolved_seat) {
      errors.push(
        hasPredecessor
          ? `${label}: requested_seat "${input.requested_seat}" differs from resolved_seat "${input.resolved_seat}" without substituted:true`
          : `${label}: a fresh route must resolve the seat it requested — an ineligible candidate is recorded in candidates_skipped, never as a requested-then-substituted pair`
      );
    }
  }

  // A seat that was never eligible was never requested, and cannot be the seat
  // this route actually resolved to.
  for (const key of ['requested_seat', 'resolved_seat']) {
    if (isNonEmptyString(input[key]) && skippedSeats.has(input[key])) {
      errors.push(
        `${label}: ${key} "${input[key]}" also appears in candidates_skipped — a seat that was never eligible was never requested`
      );
    }
  }
}

// --- review-phase route shape ------------------------------------------------

const REVIEW_KEYS = [
  'mission_id',
  'author_route_seq',
  'author_attempt',
  'author_dispatch_seq',
  'artifact_identity',
  'reviewer_seat',
  'reviewer_family',
  'reviewer_model',
  'reviewer_effort',
  'reviewer_host_model',
  'reviewer_host_effort',
  'independence',
  'routing_config',
  'routing_digest',
  'replacement_reason',
];

const IDENTITY_KEYS = ['source_head', 'source_tree', 'patch_digest', 'dirty'];

// The canonical artifact identity object (§7). Shapes are checked strictly so
// a digest can never be compared with a SHA downstream: a bare oid in
// patch_digest and a prefixed digest in source_head are both refused here.
function validateArtifactIdentity(identity, label) {
  const errors = [];
  const at = label || 'artifact_identity';
  if (!isPlainObject(identity)) {
    return { ok: false, errors: [`${at} must be an object { source_head, source_tree, patch_digest, dirty }`] };
  }
  checkExactKeys(identity, IDENTITY_KEYS, [], at, errors);
  for (const key of ['source_head', 'source_tree']) {
    if (!Object.prototype.hasOwnProperty.call(identity, key)) continue;
    if (typeof identity[key] !== 'string' || !GIT_OID_RE.test(identity[key])) {
      errors.push(`${at} field "${key}" must be a git object id (40 or 64 hex characters, no digest prefix)`);
    }
  }
  if (Object.prototype.hasOwnProperty.call(identity, 'patch_digest')) {
    checkDigest(errors, identity.patch_digest, `${at} field "patch_digest"`);
  }
  if (Object.prototype.hasOwnProperty.call(identity, 'dirty')) {
    checkBoolean(errors, identity.dirty, `${at} field "dirty"`);
    if (identity.dirty === true) {
      errors.push(`${at}: a review route may not name a dirty worktree — the reviewed artifact must be durable`);
    }
  }
  return { ok: errors.length === 0, errors };
}

function validateReviewRoute(input) {
  try {
    return validateReviewRouteChecked(input);
  } catch (err) {
    return { ok: false, errors: [`review route could not be inspected: ${err.message}`] };
  }
}

function validateReviewRouteChecked(input) {
  if (!isPlainObject(input)) {
    return { ok: false, errors: ['review route must be a plain object'] };
  }
  const errors = [];
  const label = 'review route';
  checkExactKeys(input, REVIEW_KEYS, [], label, errors);

  checkToken(errors, input.mission_id, `${label} field "mission_id"`);
  checkInt(errors, input.author_route_seq, `${label} field "author_route_seq"`, 0);
  checkInt(errors, input.author_attempt, `${label} field "author_attempt"`, 1);
  // The dispatch record this names is roster.js's to write (§17); until that
  // writer exists, the binding is validated as a shape, not resolved.
  checkInt(errors, input.author_dispatch_seq, `${label} field "author_dispatch_seq"`, 0);

  const identity = validateArtifactIdentity(input.artifact_identity, `${label} artifact_identity`);
  if (!identity.ok) errors.push(...identity.errors);

  checkToken(errors, input.reviewer_seat, `${label} field "reviewer_seat"`);
  checkEnum(errors, input.reviewer_family, `${label} field "reviewer_family"`, [...FAMILIES]);
  checkToken(errors, input.reviewer_model, `${label} field "reviewer_model"`);
  checkToken(errors, input.reviewer_effort, `${label} field "reviewer_effort"`);
  checkHostPair(
    errors,
    input.reviewer_host_model,
    input.reviewer_host_effort,
    'reviewer_host_model',
    'reviewer_host_effort',
    label
  );
  checkEnum(errors, input.independence, `${label} field "independence"`, INDEPENDENCE);
  if (typeof input.routing_config !== 'string' || !DATED_CONFIG_RE.test(input.routing_config)) {
    errors.push(`${label} field "routing_config" must be a dated routing config filename (routing-YYYY-MM-DD-N.json)`);
  }
  checkDigest(errors, input.routing_digest, `${label} field "routing_digest"`);
  if (input.replacement_reason !== null) {
    checkPhrase(errors, input.replacement_reason, `${label} field "replacement_reason"`);
  }

  return { ok: errors.length === 0, errors };
}

// --- supersession shape ------------------------------------------------------

const SUPERSEDE_KEYS = ['mission_id', 'predecessor_route_seq', 'transition', 'reason', 'evidence_seq', 'replacement'];

function validateSupersession(input) {
  if (!isPlainObject(input)) {
    return { ok: false, errors: ['supersession must be a plain object'] };
  }
  const errors = [];
  const label = 'supersession';
  checkExactKeys(input, SUPERSEDE_KEYS, [], label, errors);
  checkToken(errors, input.mission_id, `${label} field "mission_id"`);
  checkInt(errors, input.predecessor_route_seq, `${label} field "predecessor_route_seq"`, 0);
  checkEnum(errors, input.transition, `${label} field "transition"`, TRANSITIONS);
  checkEnum(errors, input.reason, `${label} field "reason"`, REASONS);
  checkInt(errors, input.evidence_seq, `${label} field "evidence_seq"`, 0);
  if (!isPlainObject(input.replacement)) {
    errors.push(`${label} field "replacement" must be the replacement route object`);
  } else if (Object.prototype.hasOwnProperty.call(input.replacement, 'predecessor')) {
    errors.push(
      `${label} replacement must not carry its own "predecessor" — supersede injects the transition block it validated`
    );
  }
  return { ok: errors.length === 0, errors };
}

// --- tree, state and ledger access ------------------------------------------

// This module records into a tree, it never creates one — genesis belongs to
// the scaffold.
function requireTree(treeRoot) {
  if (!isNonEmptyString(treeRoot)) {
    throw new TypeError('route: treeRoot must be a non-empty string');
  }
  let stat;
  try {
    stat = fs.statSync(treeRoot);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`route: no tree at "${treeRoot}" — scaffold it first`);
    }
    throw err;
  }
  if (!stat.isDirectory()) {
    throw new Error(`route: "${treeRoot}" is not a directory`);
  }
}

function statePathOf(treeRoot) {
  return path.join(treeRoot, STATE_BASENAME);
}

function ledgerPathOf(treeRoot) {
  return path.join(treeRoot, LEDGER_BASENAME);
}

// mission.js's open-status guard, applied to this stream's writer too: a
// closed mission's route topology is settled and accepts no new records.
function requireOpenInState(treeRoot, missionId) {
  const statePath = statePathOf(treeRoot);
  const state = readJson(statePath, undefined);
  if (!isPlainObject(state) || !isPlainObject(state.missions)) {
    throw new Error(`route: ${statePath} is missing or malformed — mission.js open records missions there`);
  }
  const entry = state.missions[missionId];
  if (!isPlainObject(entry)) {
    throw new Error(`route: no such mission "${missionId}" in ${statePath} (mission.js open first)`);
  }
  if (entry.status !== 'open') {
    throw new Error(
      `route: mission "${missionId}" has status "${entry.status}" — a closed mission's route stream accepts no new records`
    );
  }
}

// Authority is derived from this stream, so a stream that cannot be read end
// to end yields no verdict at all.
function readLedger(treeRoot) {
  const ledgerPath = ledgerPathOf(treeRoot);
  const { records, errors } = readRecords(ledgerPath);
  if (errors.length > 0) {
    const detail = errors.map((e) => `line ${e.line}: ${e.reason}`).join('; ');
    throw new Error(`route: ${ledgerPath} has malformed record(s) — refusing to derive a route from it: ${detail}`);
  }
  return records;
}

function recordAtSeq(records, seq) {
  const matches = records.filter((r) => isPlainObject(r) && r.seq === seq);
  if (matches.length > 1) {
    throw new Error(`route: ledger seq ${seq} is ambiguous (${matches.length} records carry it)`);
  }
  return matches.length === 1 ? matches[0] : null;
}

function routeAtSeq(records, seq) {
  const record = recordAtSeq(records, seq);
  if (record === null) {
    throw new Error(`route: no route record at ledger seq ${seq}`);
  }
  if (record.kind !== ROUTE_KIND) {
    throw new Error(`route: ledger seq ${seq} is a "${record.kind}" record, not a route record`);
  }
  return record;
}

function routesOfMission(records, missionId) {
  return records.filter((r) => isPlainObject(r) && r.kind === ROUTE_KIND && r.mission_id === missionId);
}

// --- §9 escalation state machine --------------------------------------------

// A budget is spent by an escalation *event*, and an event is identified by the
// route it escalated from. A crash-orphaned replacement and the retry that
// follows it name the same predecessor, so recovery is never charged twice.
function predecessorsUsing(records, missionId, transitions, reason) {
  const seqs = new Set();
  for (const route of routesOfMission(records, missionId)) {
    const block = route.predecessor;
    if (!isPlainObject(block)) continue;
    if (!transitions.includes(block.transition)) continue;
    if (reason !== undefined && block.reason !== reason) continue;
    seqs.add(block.predecessor_route_seq);
  }
  return seqs;
}

function profileDiff(predecessor, replacement) {
  return PROFILE_FIELDS.filter((field) => predecessor[field] !== replacement[field]);
}

// Every rule §9 lists, checked against the recorded chain rather than against
// the caller's claim about it.
function checkAuthorTransition(records, predecessor, replacement, block) {
  const { transition, reason } = block;
  const missionId = replacement.mission_id;

  if (QUALITY_ONLY_TRANSITIONS.includes(transition) && reason !== 'quality') {
    throw new Error(
      `route: transition "${transition}" is a quality response — reason "${reason}" reroutes in class and consumes no quality budget`
    );
  }
  if (reason === 'safety-refusal' && transition !== 'same-class-provider-reroute') {
    throw new Error(
      `route: a safety refusal reroutes the unchanged brief to another provider — transition must be same-class-provider-reroute, not "${transition}"`
    );
  }
  if (reason === 'safety-refusal' && replacement.brief_digest !== predecessor.brief_digest) {
    throw new Error('route: a safety refusal never rewrites the brief — the replacement must carry the same brief digest');
  }

  if (transition === 'same-profile-resume') {
    if (replacement.attempt !== predecessor.attempt) {
      throw new Error(
        `route: same-profile-resume must keep attempt ${predecessor.attempt} (got ${replacement.attempt}) — a resume is not a new attempt`
      );
    }
    const changed = profileDiff(predecessor, replacement);
    if (changed.length > 0) {
      throw new Error(
        `route: same-profile-resume must keep the profile it resumes — ${changed
          .map((f) => `${f} changed from ${JSON.stringify(predecessor[f])} to ${JSON.stringify(replacement[f])}`)
          .join('; ')}`
      );
    }
    if (replacement.brief_digest !== predecessor.brief_digest) {
      throw new Error('route: same-profile-resume must keep the brief it resumes — a different brief is a different task');
    }
    if (reason === 'quality') {
      if (predecessor.task_class === 'mechanical') {
        throw new Error('route: the mechanical class takes zero same-profile quality repairs — escalate instead');
      }
      const spent = predecessorsUsing(records, missionId, ['same-profile-resume'], 'quality');
      spent.delete(predecessor.seq);
      if (spent.size > 0) {
        throw new Error(
          `route: mission "${missionId}" has already spent its one same-profile quality repair (route seq ${[...spent][0]}) — escalate or converge`
        );
      }
    }
  } else if (replacement.attempt !== predecessor.attempt + 1) {
    throw new Error(
      `route: ${transition} is a new attempt — expected attempt ${predecessor.attempt + 1} (predecessor attempt ${predecessor.attempt}), got ${replacement.attempt}`
    );
  }

  if (transition === 'same-class-provider-reroute' && replacement.task_class !== predecessor.task_class) {
    throw new Error(
      `route: same-class-provider-reroute must keep task class "${predecessor.task_class}" (got "${replacement.task_class}")`
    );
  }

  if (ESCALATION_TRANSITIONS.includes(transition)) {
    if (predecessor.task_class === 'apex') {
      throw new Error(
        transition === 'class-escalation'
          ? 'route: apex is the top task class — there is nothing to escalate to; convergence or operator escalation only'
          : 'route: apex never invents a higher automatic effort — convergence or operator escalation only'
      );
    }
    if (transition === 'class-escalation') {
      if (CLASS_ORDER.indexOf(replacement.task_class) <= CLASS_ORDER.indexOf(predecessor.task_class)) {
        throw new Error(
          `route: class-escalation must name a higher task class than "${predecessor.task_class}" (got "${replacement.task_class}")`
        );
      }
    } else {
      if (replacement.task_class !== predecessor.task_class) {
        throw new Error(
          `route: within-class-profile-escalation must keep task class "${predecessor.task_class}" (got "${replacement.task_class}")`
        );
      }
      if (profileDiff(predecessor, replacement).length === 0) {
        throw new Error('route: within-class-profile-escalation must change the profile it escalates');
      }
    }
    const spent = predecessorsUsing(records, missionId, ESCALATION_TRANSITIONS);
    spent.delete(predecessor.seq);
    if (spent.size > 0) {
      throw new Error(
        `route: mission "${missionId}" has already spent its one profile escalation (route seq ${[...spent][0]}) — further quality disagreement goes to convergence`
      );
    }
  }

  // The escalated claim is convenience input; the recorded chain is authority.
  if (replacement.escalation_profile === true && !ESCALATION_TRANSITIONS.includes(transition)) {
    throw new Error(
      `route: an escalation-only profile is reachable only through an escalation transition (got "${transition}")`
    );
  }

  // A substitution names a concrete route that really was reserved.
  if (replacement.selection.substituted === true) {
    if (replacement.requested_seat !== predecessor.resolved_seat) {
      throw new Error(
        `route: substituted:true must name the predecessor's resolved seat "${predecessor.resolved_seat}" as requested_seat (got "${replacement.requested_seat}")`
      );
    }
    if (replacement.resolved_seat === replacement.requested_seat) {
      throw new Error('route: substituted:true requires a resolved seat different from the requested one');
    }
  }
}

function checkReviewTransition(predecessor, replacement, block) {
  if (block.transition !== REVIEW_TRANSITION) {
    throw new Error(
      `route: a review-phase route is superseded only by ${REVIEW_TRANSITION} (got "${block.transition}") — escalation is an author-profile transition`
    );
  }
  if (replacement.author_route_seq !== predecessor.author_route_seq) {
    throw new Error(
      `route: a review-phase replacement must keep author_route_seq ${predecessor.author_route_seq} (got ${replacement.author_route_seq})`
    );
  }
  if (replacement.author_attempt !== predecessor.author_attempt) {
    throw new Error(
      `route: a review-phase replacement must keep author_attempt ${predecessor.author_attempt} (got ${replacement.author_attempt})`
    );
  }
}

// --- record construction -----------------------------------------------------

// Rebuilt from the named fields of an exact-key-validated input: the payload
// appended is the contract, never the raw parsed object.
function authorPayload(input, predecessorBlock) {
  const payload = {};
  for (const key of AUTHOR_KEYS) payload[key] = input[key];
  payload.phase = 'author';
  payload.predecessor = predecessorBlock;
  // Derived, never caller-supplied: only a same-profile resume is a resume.
  payload.resumed = predecessorBlock !== null && predecessorBlock.transition === 'same-profile-resume';
  return payload;
}

function reviewPayload(input, predecessorBlock) {
  const payload = {};
  for (const key of REVIEW_KEYS) payload[key] = input[key];
  payload.artifact_identity = {};
  for (const key of IDENTITY_KEYS) payload.artifact_identity[key] = input.artifact_identity[key];
  payload.phase = 'review';
  payload.predecessor = predecessorBlock;
  // Derived, never caller-supplied — REVIEW_KEYS excludes it, so a caller
  // offering it is refused as an extra key. It says one thing: this record's
  // reviewer_family was checked against the routing config's seat table when
  // it was written. close reads its presence to tell a record written under
  // that rule from one that predates it.
  payload.reviewer_family_derived = true;
  return payload;
}

// §8's cross-family law rests entirely on a route record's reviewer family
// being true, and every check downstream reads it as given. So it is derived
// here from the seat the record names, and a record whose asserted family the
// config contradicts is refused before it can become durable. Comparing the
// assertion against the author route's reservation proves nothing — the same
// caller wrote both — which is exactly how a gemini seat with a claude family
// passed as lawful.
function checkReviewerFamilyDerived(treeRoot, input) {
  const { family, reason } = seatFamily(treeRoot, input.reviewer_seat);
  if (family === null) {
    throw new Error(
      `route: the family of reviewer seat "${input.reviewer_seat}" cannot be derived — ${reason}; a family that cannot be established has not been established`
    );
  }
  if (family !== input.reviewer_family) {
    throw new Error(
      `route: reviewer_family "${input.reviewer_family}" contradicts the routing config, which seats "${input.reviewer_seat}" in family "${family}" — a reviewer's family belongs to the seat and is derived from the config, never asserted alongside it`
    );
  }
}

// The author route's reserved review capacity is the promise the review route
// either honours or must explain having lost.
function checkReviewAgainstAuthor(input, authorRoute) {
  if (authorRoute.phase !== 'author') {
    throw new Error(`route: route seq ${authorRoute.seq} is a review-phase route, not an author-phase route`);
  }
  if (authorRoute.mission_id !== input.mission_id) {
    throw new Error(
      `route: route seq ${authorRoute.seq} belongs to mission "${authorRoute.mission_id}", not "${input.mission_id}"`
    );
  }
  if (authorRoute.attempt !== input.author_attempt) {
    throw new Error(
      `route: author_attempt ${input.author_attempt} does not match the author route's attempt ${authorRoute.attempt}`
    );
  }

  // No family laundering (§8): a cross-family label is a factual claim about
  // two different families, re-checked after every substitution.
  if (input.independence === 'cross-family' && input.reviewer_family === authorRoute.author_family) {
    throw new Error(
      `route: cross-family independence with reviewer family "${input.reviewer_family}" is the author's own family — no family laundering; a same-family reviewer is the degraded path`
    );
  }

  const reserved = authorRoute.reserved_review;
  const honoured =
    isPlainObject(reserved) &&
    reserved.seat === input.reviewer_seat &&
    reserved.family === input.reviewer_family &&
    reserved.model === input.reviewer_model &&
    reserved.effort === input.reviewer_effort &&
    reserved.independence === input.independence;

  if (!honoured && input.replacement_reason === null) {
    throw new Error(
      `route: the reviewer differs from the reserved review capacity ${JSON.stringify(reserved)} — "replacement_reason" must say what was lost`
    );
  }
  if (honoured && input.replacement_reason !== null) {
    throw new Error('route: "replacement_reason" must be null when the reserved review capacity was honoured');
  }
}

// --- reserve / reserve-review / supersede ------------------------------------

// All three writers serialize on state.json and re-check the mission's open
// status inside that lock, so a close landing mid-call wins and two concurrent
// escalations can never both pass the budget check. Lock order (state →
// ledger) matches every other writer, so they cannot deadlock.
function withOpenMission(treeRoot, missionId, fn) {
  if (!isNonEmptyString(missionId) || !SEGMENT_RE.test(missionId)) {
    throw new TypeError(`route: mission_id must match ${SEGMENT_RE}`);
  }
  requireOpenInState(treeRoot, missionId);
  return withLock(statePathOf(treeRoot), () => {
    requireOpenInState(treeRoot, missionId);
    return fn();
  });
}

function appendRoute(treeRoot, payload, missionId) {
  return appendRecord(ledgerPathOf(treeRoot), {
    kind: ROUTE_KIND,
    payload,
    correlation_id: missionId,
  });
}

// reserve(treeRoot, input) -> the stamped author-phase route record. Written
// before any author spawn; the reserved review capacity travels with it.
function reserve(treeRoot, input) {
  requireTree(treeRoot);
  const { ok, errors } = validateAuthorRoute(input, false);
  if (!ok) {
    throw new TypeError(`route: invalid author route — ${errors.join('; ')}`);
  }
  return withOpenMission(treeRoot, input.mission_id, () =>
    appendRoute(treeRoot, authorPayload(input, null), input.mission_id)
  );
}

// reserveReview(treeRoot, input) -> the stamped review-phase route record.
// Written after the author completes and before any review dispatch.
function reserveReview(treeRoot, input) {
  requireTree(treeRoot);
  const { ok, errors } = validateReviewRoute(input);
  if (!ok) {
    throw new TypeError(`route: invalid review route — ${errors.join('; ')}`);
  }
  checkReviewerFamilyDerived(treeRoot, input);
  return withOpenMission(treeRoot, input.mission_id, () => {
    const records = readLedger(treeRoot);
    checkReviewAgainstAuthor(input, routeAtSeq(records, input.author_route_seq));
    return appendRoute(treeRoot, reviewPayload(input, null), input.mission_id);
  });
}

// supersede(treeRoot, input) -> { route, superseded }. Replacement-first: the
// replacement route is reserved and durable BEFORE the supersession record
// that points at it, so a crash between the two leaves an orphan reservation
// nothing references — never a supersession naming a route that isn't there.
function supersede(treeRoot, input) {
  requireTree(treeRoot);
  const shape = validateSupersession(input);
  if (!shape.ok) {
    throw new TypeError(`route: invalid supersession — ${shape.errors.join('; ')}`);
  }

  return withOpenMission(treeRoot, input.mission_id, () => {
    const records = readLedger(treeRoot);
    const predecessor = routeAtSeq(records, input.predecessor_route_seq);
    if (predecessor.mission_id !== input.mission_id) {
      throw new Error(
        `route: route seq ${predecessor.seq} belongs to mission "${predecessor.mission_id}", not "${input.mission_id}"`
      );
    }
    const already = records.find(
      (r) => isPlainObject(r) && r.kind === SUPERSEDED_KIND && r.predecessor_route_seq === predecessor.seq
    );
    if (already) {
      throw new Error(
        `route: route seq ${predecessor.seq} is already superseded by route ${already.replacement_route_seq} (seq ${already.seq}) — a predecessor is superseded once`
      );
    }
    const evidence = recordAtSeq(records, input.evidence_seq);
    if (evidence === null) {
      throw new Error(`route: "evidence_seq" ${input.evidence_seq} names no ledger record`);
    }
    if (isNonEmptyString(evidence.correlation_id) && evidence.correlation_id !== input.mission_id) {
      throw new Error(
        `route: "evidence_seq" ${input.evidence_seq} belongs to mission "${evidence.correlation_id}", not "${input.mission_id}"`
      );
    }

    const replacement = input.replacement;
    if (replacement.mission_id !== input.mission_id) {
      throw new Error(
        `route: replacement mission_id ${JSON.stringify(replacement.mission_id)} does not match the predecessor's mission "${input.mission_id}"`
      );
    }

    const block = {
      predecessor_route_seq: input.predecessor_route_seq,
      transition: input.transition,
      reason: input.reason,
      evidence_seq: input.evidence_seq,
    };

    let payload;
    if (predecessor.phase === 'author') {
      const check = validateAuthorRoute(replacement, true);
      if (!check.ok) {
        throw new TypeError(`route: invalid author route — ${check.errors.join('; ')}`);
      }
      checkAuthorTransition(records, predecessor, replacement, block);
      payload = authorPayload(replacement, block);
    } else {
      const check = validateReviewRoute(replacement);
      if (!check.ok) {
        throw new TypeError(`route: invalid review route — ${check.errors.join('; ')}`);
      }
      // The same derivation, because this site writes the same record kind: a
      // replacement reviewer is exactly where a lost cross-family lane gets
      // swapped, and a fence only reserveReview held would be one supersede
      // call away from the hole it closed.
      checkReviewerFamilyDerived(treeRoot, replacement);
      checkReviewTransition(predecessor, replacement, block);
      checkReviewAgainstAuthor(replacement, routeAtSeq(records, replacement.author_route_seq));
      payload = reviewPayload(replacement, block);
    }

    // (1) the replacement becomes durable...
    const route = appendRoute(treeRoot, payload, input.mission_id);
    // (2) ...and only then does anything point at it.
    const superseded = appendRecord(ledgerPathOf(treeRoot), {
      kind: SUPERSEDED_KIND,
      payload: {
        mission_id: input.mission_id,
        predecessor_route_seq: predecessor.seq,
        replacement_route_seq: route.seq,
        transition: input.transition,
        reason: input.reason,
        evidence_seq: input.evidence_seq,
      },
      correlation_id: input.mission_id,
    });
    return { route, superseded };
  });
}

// --- CLI ---------------------------------------------------------------------

const HELP = `route.js — maestro route lifecycle (sole writer of ledger kinds "${ROUTE_KIND}" and "${SUPERSEDED_KIND}")

usage:
  route.js reserve <treeRoot>          author-phase route JSON via stdin
  route.js reserve-review <treeRoot>   review-phase route JSON via stdin
  route.js supersede <treeRoot>        supersession JSON via stdin

commands:
  reserve         Written BEFORE any author spawn. stdin keys:
                  ${AUTHOR_KEYS.join(', ')}.
                  task_class one of ${CLASS_ORDER.join(', ')}; families
                  ${[...FAMILIES].join(', ')}; host_model/host_effort both null
                  (native seat) or both set (hosted); selection is
                  { candidates_skipped: [{seat, reason: ${SKIP_REASONS.join('|')}}],
                  substituted, substitution_reason }; reserved_review is
                  { seat, family, model, effort, independence }. A FRESH route
                  skips ineligible candidates and may never claim
                  substituted:true, request a seat it skipped, or select an
                  escalation-only profile. Appends phase "author".
  reserve-review  Written after the author completes, before any review
                  dispatch. stdin keys: ${REVIEW_KEYS.join(', ')}.
                  artifact_identity is { source_head, source_tree,
                  patch_digest, dirty } — oids and digests never interchange,
                  and a dirty worktree is refused. reviewer_family is DERIVED
                  from the routing config's entry for reviewer_seat: a family
                  the config contradicts is refused, and so is a seat the seat
                  table does not carry, an alias seat, or an entry recording no
                  family — an unestablished family never passes as a default.
                  Binds the named author route: a reviewer differing from its
                  reserved review capacity requires replacement_reason, an
                  honoured one forbids it, and cross-family independence naming
                  the author's own family is refused. Appends phase "review".
  supersede       stdin { mission_id, predecessor_route_seq, transition, reason,
                  evidence_seq, replacement }. transition one of
                  ${TRANSITIONS.join(', ')};
                  reason one of ${REASONS.join(', ')}.
                  REPLACEMENT-FIRST: the replacement route is appended and
                  durable before the supersession record that names it, so a
                  crash leaves an orphan reservation, never a dangling pointer.
                  Enforces the escalation state machine: one same-profile
                  quality repair (zero for mechanical), one profile escalation
                  per mission, infrastructure/quota/runtime reroutes consume no
                  quality budget, a safety refusal reroutes the unchanged brief,
                  apex invents no higher effort, and an escalation-only profile
                  is reachable only through an escalation transition. A review-
                  phase replacement derives its reviewer family exactly as
                  reserve-review does. Prints { route, superseded }.

Every route record is immutable: a predecessor is never overwritten. Refusals
go to stderr with exit 1; nothing reaches disk on a refusal.
`;

const COMMANDS = { reserve, 'reserve-review': reserveReview, supersede };

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  const [command, treeRoot, ...rest] = argv;
  try {
    if (!Object.prototype.hasOwnProperty.call(COMMANDS, command)) {
      throw new Error(
        command === undefined
          ? 'a command is required'
          : `unknown command "${command}" (expected reserve, reserve-review or supersede)`
      );
    }
    if (!isNonEmptyString(treeRoot)) throw new Error(`${command} requires <treeRoot>`);
    if (rest.length > 0) throw new Error(`unexpected extra argument(s): ${rest.join(' ')}`);

    const text = fs.readFileSync(0, 'utf8'); // fd 0 = stdin
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new Error(`${command} JSON via stdin is not valid JSON: ${err.message}`);
    }
    const result = COMMANDS[command](treeRoot, parsed);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exit(0);
  } catch (err) {
    process.stderr.write(`route.js: ${err.message}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = {
  reserve,
  reserveReview,
  supersede,
  seatFamily,
  validateAuthorRoute,
  validateReviewRoute,
  validateArtifactIdentity,
  validateSupersession,
  ROUTE_KIND,
  SUPERSEDED_KIND,
  PHASES,
  CLASS_ORDER,
  TRANSITIONS,
  REASONS,
  INDEPENDENCE,
  SKIP_REASONS,
  ESCALATION_TRANSITIONS,
  AUTHOR_KEYS,
  REVIEW_KEYS,
  IDENTITY_KEYS,
};
