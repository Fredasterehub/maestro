'use strict';

// maestro machine layer — mission lifecycle CLI.
//
// Sole sanctioned writer of:
//   ledger.jsonl kinds:            mission-open, envelope, consult,
//                                  review-outcome, mission-close
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
//
// Honest scope of "derived": the ledger is plaintext with no writer
// attestation, and most route-record facts close derives (the reserved
// capacity, the seats themselves) entered the ledger as caller input to
// route.js before the author was spawned. Derivation therefore means the
// caller had to commit those facts in advance, immutably, timestamped, and
// cross-checked between independent records — it does not mean the facts are
// cryptographically proven. The two FAMILIES are stronger than that: neither
// is the caller's word at all, but the routing config's entry for the seat
// each record names, re-derived here at close as an independent second fence
// over route.js's own (checkRouteFamily below, run over both operands). Exactly one thing here is proven independently of
// the ledger: the landing, because git answers it from the repository's own
// objects. The gate's exit code is proven *if the record is genuine* —
// gate.js really re-ran the command and wrote what it got, which is why a
// gate record is the only kind admitted as evidence below — but close reads
// that record, it does not re-run anything, so a hand-appended gate record is
// believed here exactly as far as the ledger is.
//
// The same sentence bounds the fence below, and it is worth saying out loud
// rather than leaving to be found: every refusal here is scoped to ONE
// ledger.jsonl — the one under the treeRoot this process was handed. A close
// run against a different maestro tree reads a different ledger, sees none of
// this one's findings, and closes over them without ever lying about anything,
// because nothing it could read says they exist. Nothing derivable inside this
// machine reaches past that: there is no registry of trees, a tree is a
// directory scaffold.js will create on request, and a record can only be
// believed where it can be read.
//
// That is the boundary of the SCAN. It is not the cheapest way past the fence,
// and a reader who stops here would over-trust it: two cheaper ways sit inside
// a single tree, both already stated in this file. The ledger is plaintext
// with no writer attestation (above), so deleting the revise line costs less
// than standing up a tree. And the landing repository is caller-located via
// --repo (see proveLanding's known limits), so a close proven against a
// throwaway clone succeeds while the project's mainline never moves — which is
// why the close record names the repository it was proven in. Each of the
// three is a limit on a different thing: what this process can read, what it
// is willing to believe, and where it looked. None of them is closed by code
// in this module, and pretending otherwise in a comment would be the same
// overclaim the fence itself exists to prevent.
//
// record-review is the sole producer of the verdict close depends on: a
// review-outcome record binding the review route, the verdict, and the exact
// identity that was reviewed. A revise is recorded the same way as an approve
// — a revise that vanished is how a mission would quietly close on a rejected
// review — and close requires the standing recorded verdict for its review
// route to be an approve against the same identity every other stage names,
// AND no standing revise anywhere in this LEDGER — any mission's review route,
// not just this mission's — against that same identity. The unit of that law is
// the artifact, not the route and not the mission: a finding against an
// artifact is answered by evidence or by changing the work, never by reviewing
// the same work again somewhere quieter, and neither a second route nor a
// second mission is quiet enough. What "the same work" means is one predicate
// (`namesSameArtifact`), shared by the scan that dissolves a finding and the
// check that answers one, so the two can never disagree. A second TREE is, and
// that is the boundary named above: the fence is as wide as the ledger it
// reads, and no wider.
//
// close names the winning author and review dispatches, but a mission is
// every attempt it made, not only the one that won (§16.3). So close also
// walks every OTHER "dispatch" ledger record this mission's roster.js
// register calls produced and gives each a terminal outcome from the closed
// vocabulary in TERMINAL_OUTCOMES below — read off a route supersession's own
// recorded transition and reason, a standing review-outcome, or an
// unambiguous "blocked" worker envelope, exactly as every other fact in this
// file is read rather than asserted. A dispatch none of those three streams
// can classify refuses the close by name, because a guessed outcome is
// indistinguishable from a true one the moment it is written, and this record
// is the one nobody ever audits against reality afterward.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { withLock, appendRecord, readRecords } = require('./jsonl.js');
const { readJson, writeJson, updateJson } = require('./atomic-json.js');
const { validateBrief, validateEnvelope } = require('./validators.js');
const { assertContained } = require('./contain.js');
const { IDENTITY_FIELDS } = require('./gate.js');
const { seatFamily, FAMILY_DERIVATION, SUPERSEDED_KIND, ESCALATION_TRANSITIONS } = require('./route.js');
const { DISPATCH_KIND } = require('./roster.js');

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

// --- the same work -----------------------------------------------------------

// ONE predicate for "these two records are about the same change", defined
// here and used by every comparison that asks that question: the standing-
// revise scan (this mission's routes and every other mission's alike) and the
// overturn-evidence check that answers a finding. The path that DISSOLVES a
// finding and the path that ANSWERS it must never disagree about what they are
// looking at — when they did, answering a finding became impossible in exactly
// the case where dissolving it became free, and the incentive pointed at the
// escape.
//
// It is disjunctive: the same work when source_tree matches OR patch_digest
// matches. Each is already proof of the same change by construction — the same
// tree is the same bytes, the same canonical patch is the same diff — so
// requiring both means the fence fires only where the evidence is redundant,
// and every ordinary git operation that moves one while preserving the other
// walks through it:
//   - `git rebase main` after a sibling step lands: the patch is byte-identical,
//     the tree carries the sibling's file. No intent, no forgery — the normal
//     shape of parallel work, dissolving a standing revise as a side effect.
//   - a reparent (`git commit-tree` of the same tree onto a moved parent): the
//     tree is byte-identical, the patch now also undoes the sibling.
//   - `git commit --allow-empty`: both survive; only the head is fresh.
// A genuine repair moves both, and stays exactly as legal as it was.
//
// Neither source_head nor dirty participates. A head is a label — round three
// removed it from the match and that correction stands — and dirty describes
// the worktree an identity was measured in, not the work.
//
// A field matches only on a value actually recorded on BOTH records: under a
// disjunction, two absences agreeing would make an empty identity match
// everything, which is the opposite of what this is for.
//
// This predicate answers "the same work", and only the checks that ask that
// question use it. The comparisons that ask "the same identity record" —
// a verdict against the identity its route bound, the final gate against the
// artifact being closed, the pre-lock/locked drift guard — stay field by
// field over all four, and must: those are chain links, where anything but an
// exact match means the chain is broken, not that the work moved.
const CONTENT_IDENTITY_FIELDS = ['source_tree', 'patch_digest'];

function namesSameArtifact(recorded, identity) {
  return CONTENT_IDENTITY_FIELDS.some(
    (field) => isNonEmptyString(recorded[field]) && recorded[field] === identity[field]
  );
}

// What an identity record must actually carry to be readable as one. `{}` is a
// plain object and says nothing; under a predicate that matches on recorded
// values, saying nothing is indistinguishable from being about other work,
// which is fail-open for a record whose whole job is to name what was judged.
function carriesFullIdentity(identity) {
  return isPlainObject(identity) && IDENTITY_FIELDS.every((field) => identity[field] !== undefined);
}

// --- record-review -----------------------------------------------------------

const REVIEW_VERDICTS = ['approve', 'revise'];

// A verdict is not self-proving the way a gate record is — gate.js really
// re-ran the command; a verdict is a recorded assertion. So a verdict that
// REPLACES an earlier verdict on the same review route must answer it the
// way §8's symmetric rule demands: naming the record it supersedes, with a
// reason and recorded evidence — never a bare later append (route.js
// supersede is the model). The first verdict on a route carries none of that.
const REVIEW_SUPERSEDE_KEYS = ['supersedes_seq', 'reason', 'evidence_seq'];
const REASON_CEILING = 200;

// What §8 correction 19 means by "recorded contradictory repository evidence",
// in the only form this ledger can decide. A well-formed seq is not evidence:
// pointing at the finding being overturned, at the mission's own birth
// certificate, or at another mission's records answers nothing. So the record
// named must be
//   (1) a gate record — the one ledger kind produced by re-executing a command
//       against the repository (gate.js run-gate), which is what makes it a
//       repository fact rather than a second opinion; a review-outcome is a
//       finding, and a finding is never its own refutation;
//   (2) this mission's; and
//   (3) LATER than the record it answers — a fact that already existed when
//       the finding was written cannot be what contradicts it; and
//   (4) about the same WORK the answered verdict judged, where the gate record
//       names an artifact — a green gate on some other change is a true fact
//       that answers nothing here. "Same work" is `namesSameArtifact` above,
//       the one predicate, so a gate run after an ordinary rebase still
//       answers the finding it postdates: the rebase moved the tree and left
//       the patch, and the fence reads that pair the same way this check does.
//       When the two disagreed, a finding survived every honest answer in
//       precisely the case where it dissolved for free.
// The gate's own exit code is deliberately not constrained: a red gate is
// exactly the contradictory evidence that overturns an approve, just as a
// green one is what answers a revise.
//
// Used at three sites that must not drift apart: the record-review writer, the
// close-side re-derivation of the same chain (the writer can be bypassed by a
// hand-append, so the weaker copy would be the one that mattered), and the
// route-superseded escape a standing revise on another route is cleared by.

// Whether a gate record carries the §7 identity fields at all. gate.js always
// writes them, so a record without either is either older than the field or a
// hand-append; the seq of the first one that carries them is what bounds the
// tolerance extended to the former.
function identityCarryingGate(record) {
  return (
    Object.prototype.hasOwnProperty.call(record, 'artifact_identity') ||
    Object.prototype.hasOwnProperty.call(record, 'identity_check')
  );
}

function firstIdentityCarryingGateSeq(records) {
  let first = null;
  for (const record of records) {
    if (!isPlainObject(record) || record.kind !== 'gate') continue;
    if (!Number.isSafeInteger(record.seq) || record.seq < 0) continue;
    if (!identityCarryingGate(record)) continue;
    if (first === null || record.seq < first) first = record.seq;
  }
  return first;
}

function checkOverturnEvidence(records, missionId, evidenceSeq, answered, who, what) {
  const answeredSeq = answered.seq;
  if (!Number.isSafeInteger(evidenceSeq) || evidenceSeq < 0) {
    throw new Error(`mission: ${who} refused — ${what} carries no evidence_seq naming a ledger record`);
  }
  const matches = recordsAtSeq(records, evidenceSeq);
  if (matches.length !== 1) {
    throw new Error(
      `mission: ${who} refused — ${what} names ${matches.length === 0 ? 'no' : 'an ambiguous'} ledger record in "evidence_seq" ${evidenceSeq}`
    );
  }
  const evidence = matches[0];
  if (evidence.kind !== 'gate') {
    throw new Error(
      `mission: ${who} refused — ${what} cites seq ${evidenceSeq}, a "${evidence.kind}" record; contradictory repository evidence is a gate record (gate.js re-ran the command), never a verdict, a narration, or the mission's own open record`
    );
  }
  if (evidence.mission_id !== missionId) {
    throw new Error(
      `mission: ${who} refused — ${what} cites gate record ${evidenceSeq}, which belongs to mission ${JSON.stringify(evidence.mission_id)}, not "${missionId}"`
    );
  }
  if (evidenceSeq <= answeredSeq) {
    throw new Error(
      `mission: ${who} refused — ${what} cites gate record ${evidenceSeq}, which does not postdate the verdict at seq ${answeredSeq} it answers; a fact recorded before the finding cannot be what contradicts it`
    );
  }
  // A gate record from before identities were carried names no artifact and
  // claims nothing either way — the same tolerance checkGateIdentity extends,
  // and the same BOUND: once any gate record in this stream carries the
  // fields, a later field-less one is an omission, not a legacy record, and
  // omission would otherwise be the cheapest way to skip this binding
  // entirely. A record that does name an artifact must name the judged one.
  if (!identityCarryingGate(evidence)) {
    const firstCarrying = firstIdentityCarryingGateSeq(records);
    if (firstCarrying !== null && evidence.seq > firstCarrying) {
      throw new Error(
        `mission: ${who} refused — ${what} cites gate record ${evidenceSeq}, which carries no artifact identity although this stream's gate records have carried one since seq ${firstCarrying}; an omission is not a legacy record`
      );
    }
  }
  if (isPlainObject(evidence.artifact_identity) && isPlainObject(answered.artifact_identity)) {
    // The predicate reads recorded values, so an identity object carrying none
    // would answer "not the same work" about a record that in truth says
    // nothing. `{}` means the same thing everywhere the predicate is used —
    // unreadable, refused — rather than a different thing at each call site.
    const unreadable = [
      carriesFullIdentity(evidence.artifact_identity) ? null : `gate record ${evidenceSeq}`,
      carriesFullIdentity(answered.artifact_identity) ? null : `the verdict at seq ${answeredSeq}`,
    ].filter((named) => named !== null);
    if (unreadable.length > 0) {
      throw new Error(
        `mission: ${who} refused — ${what} rests on an identity that names no artifact: ${unreadable.join(' and ')} carries an artifact_identity without its ${IDENTITY_FIELDS.join(', ')} fields`
      );
    }
    if (!namesSameArtifact(evidence.artifact_identity, answered.artifact_identity)) {
      throw new Error(
        `mission: ${who} refused — ${what} cites gate record ${evidenceSeq}, which tested a different artifact than the verdict it answers: neither ${CONTENT_IDENTITY_FIELDS.join(' nor ')} matches the identity that verdict judged; a gate on other work contradicts nothing here`
      );
    }
  }
  return evidence;
}

// The verdict, recorded at the moment it is given (§17) and bound to the
// review route and the exact identity the reviewer judged. Both verdicts are
// recorded the same way: an approve is what close later requires, and a
// revise on the record is what stops a rejected review from quietly closing.
function recordReview(treeRoot, missionId, input) {
  if (!isSafeSegment(missionId)) {
    throw new TypeError(`mission: missionId must match ${SEGMENT_RE}`);
  }
  if (!isPlainObject(input)) {
    throw new TypeError('mission: record-review requires a JSON object via stdin');
  }
  assertExactKeys(
    input,
    ['review_route_seq', 'review_dispatch_seq', 'verdict', 'artifact_identity'],
    REVIEW_SUPERSEDE_KEYS,
    'review input'
  );
  for (const key of ['review_route_seq', 'review_dispatch_seq']) {
    if (!Number.isSafeInteger(input[key]) || input[key] < 0) {
      throw new TypeError(`mission: "${key}" must be a nonnegative integer naming a ledger seq`);
    }
  }
  if (!REVIEW_VERDICTS.includes(input.verdict)) {
    throw new TypeError(
      `mission: "verdict" must be one of ${REVIEW_VERDICTS.join(', ')} (got ${JSON.stringify(input.verdict)})`
    );
  }
  if (!isPlainObject(input.artifact_identity)) {
    throw new TypeError('mission: "artifact_identity" must be the reviewed identity object');
  }
  assertExactKeys(input.artifact_identity, IDENTITY_FIELDS, [], 'review artifact_identity');
  const superseding = REVIEW_SUPERSEDE_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(input, key));
  if (superseding.length > 0 && superseding.length < REVIEW_SUPERSEDE_KEYS.length) {
    throw new TypeError(
      `mission: a superseding verdict carries all of ${REVIEW_SUPERSEDE_KEYS.join(', ')} — got only ${superseding.join(', ')}`
    );
  }
  if (superseding.length > 0) {
    for (const key of ['supersedes_seq', 'evidence_seq']) {
      if (!Number.isSafeInteger(input[key]) || input[key] < 0) {
        throw new TypeError(`mission: "${key}" must be a nonnegative integer naming a ledger seq`);
      }
    }
    if (!isNonEmptyString(input.reason) || /[\r\n]/.test(input.reason) || input.reason.length > REASON_CEILING) {
      throw new TypeError(
        `mission: "reason" must be a non-empty single-line string of at most ${REASON_CEILING} characters`
      );
    }
  }

  const statePath = statePathOf(treeRoot);
  const ledgerPath = ledgerPathOf(treeRoot);

  // Same discipline as every other writer: verdicts land only on an open
  // mission, decided under the state lock a racing close would hold.
  return withLock(statePath, () => {
    const state = readJson(statePath, undefined);
    requireOpenMission(state, statePath, missionId);

    const { records, errors } = readRecords(ledgerPath);
    if (errors.length > 0) {
      const detail = errors.map((e) => `line ${e.line}: ${e.reason}`).join('; ');
      throw new Error(`mission: ${ledgerPath} has malformed record(s) — refusing to trust this stream: ${detail}`);
    }

    const reviewRoute = routeOfMission(
      records,
      missionId,
      input.review_route_seq,
      'review',
      'review route',
      'record-review'
    );
    // The verdict must name the identity the review route bound: a verdict on
    // some other artifact is a broken chain, not a recordable fact.
    const bound = reviewRoute.artifact_identity;
    if (!isPlainObject(bound)) {
      throw new Error(
        `mission: record-review refused — review route at seq ${input.review_route_seq} carries no artifact identity to verdict against`
      );
    }
    const changed = IDENTITY_FIELDS.filter((field) => input.artifact_identity[field] !== bound[field]);
    if (changed.length > 0) {
      throw new Error(
        `mission: record-review refused — the verdict names a different artifact than the review route bound: field(s) ${changed.join(', ')} differ`
      );
    }
    checkDispatchMembership(records, missionId, input.review_dispatch_seq, 'review dispatch seq', 'record-review');

    // §8 symmetric rule, at the writer: a verdict that replaces the standing
    // verdict on this route must name it, with a reason and evidence; a first
    // verdict must not pretend to supersede anything.
    let standing = null;
    for (const record of records) {
      if (!isPlainObject(record) || record.kind !== 'review-outcome') continue;
      if (record.review_route_seq !== input.review_route_seq) continue;
      if (!Number.isSafeInteger(record.seq) || record.seq < 0) continue;
      if (standing === null || record.seq > standing.seq) standing = record;
    }
    const supersedes = Object.prototype.hasOwnProperty.call(input, 'supersedes_seq');
    if (standing === null && supersedes) {
      throw new Error(
        `mission: record-review refused — no verdict exists for review route ${input.review_route_seq}, so there is nothing to supersede`
      );
    }
    if (standing !== null && !supersedes) {
      throw new Error(
        `mission: record-review refused — a verdict already stands for review route ${input.review_route_seq} (seq ${standing.seq}); a replacing verdict must name it in "supersedes_seq" with a reason and evidence_seq — a recorded verdict is answered, never silently replaced`
      );
    }
    if (supersedes && input.supersedes_seq !== standing.seq) {
      throw new Error(
        `mission: record-review refused — "supersedes_seq" ${input.supersedes_seq} is not the standing verdict for review route ${input.review_route_seq} (seq ${standing.seq})`
      );
    }
    if (supersedes) {
      checkOverturnEvidence(
        records,
        missionId,
        input.evidence_seq,
        standing,
        'record-review',
        `the ${input.verdict} replacing the verdict at seq ${standing.seq}`
      );
    }

    const identity = {};
    for (const field of IDENTITY_FIELDS) identity[field] = input.artifact_identity[field];
    const seq = appendRecord(ledgerPath, {
      kind: 'review-outcome',
      payload: {
        mission_id: missionId,
        review_route_seq: input.review_route_seq,
        review_dispatch_seq: input.review_dispatch_seq,
        verdict: input.verdict,
        artifact_identity: identity,
        supersedes_seq: supersedes ? input.supersedes_seq : null,
        reason: supersedes ? input.reason : null,
        evidence_seq: supersedes ? input.evidence_seq : null,
      },
      correlation_id: missionId,
    }).seq;

    return { mission_id: missionId, verdict: input.verdict, review_route_seq: input.review_route_seq, ledger_seq: seq };
  });
}

// --- close: ledger derivation ------------------------------------------------

// The whole close input: sequence references and nothing else. Every enforced
// fact is derived from the records these name; there is no key a caller could
// use to assert a family, a verdict, or an identity. The winning_* keys are
// equality-enforced against the primary seqs today — with one attempt per
// mission and no dispatch-record writer yet, they cannot legally differ. They
// stay in the schema because §16.3's attribution contract names them: when
// multi-attempt telemetry lands, the close payload must already carry the
// winning references, and a fail-closed input schema is cheaper to keep than
// to re-widen.
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
// landing line (gate.js resolves the bare name via merge-base; here the ref is
// resolved explicitly as refs/heads/<name> — the stricter of the two rules).
// The fixed set is a public-contract limit: a project whose mainline is named
// anything else cannot close, and widening it is a change to make in both
// modules at once, not here alone.
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
//
// Known limits, stated rather than implied: the repository itself is
// caller-located (--repo) — no earlier record names a repository yet, so the
// proof binds the recorded identity to A repository containing it, and the
// close record therefore names which one (toplevel, root commits, origin) so
// the proof is re-auditable; binding the repository to a record written
// earlier in the chain belongs to the step that writes one. And patch_digest
// is compared record-to-record only: after the merge the merge base has
// moved, so the review-time digest genuinely cannot be recomputed here —
// head and tree are re-derived against real git objects, the digest is not.
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
  // The repository the proof ran in, recorded into the close so the proof can
  // be re-audited: the toplevel path, the landing line's root commit(s) (a
  // repository fingerprint no clone can shed), and the origin URL when one is
  // configured.
  const originOutcome = git(repo, ['config', '--get', 'remote.origin.url']);
  const repository = {
    path: gitOut(repo, ['rev-parse', '--show-toplevel'], 'repository toplevel'),
    roots: gitOut(repo, ['rev-list', '--max-parents=0', landing.head], 'repository roots').split('\n').sort(),
    origin: originOutcome.status === 0 && originOutcome.stdout.trim() !== '' ? originOutcome.stdout.trim() : null,
  };

  const contained = git(repo, ['merge-base', '--is-ancestor', head, landing.head]);
  if (contained.status === 0) {
    return { method: 'commit-containment', branch: landing.branch, landed_head: landing.head, repository };
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
      return { method: 'squash-patch-identity', branch: landing.branch, landed_head: commit, repository };
    }
  }
  throw new Error(
    `mission: close refused — ${landing.branch} neither contains the reviewed commit ${head} nor carries any commit with its patch identity; the landed result is not proven to be the reviewed result`
  );
}

function recordsAtSeq(records, seq) {
  return records.filter((r) => isPlainObject(r) && r.seq === seq);
}

// Gate records are grouped by gate_id, and gate.js writes it as a bare segment
// (gate.js:270-272). A hand-appended record carrying an object there would
// group by reference — every such record its own group, and none of them
// equal to the cited gate — so the id is projected onto a string key first:
// same name, same group, whatever the record's shape.
function gateKeyOf(record) {
  return typeof record.gate_id === 'string'
    ? `s:${record.gate_id}`
    : `x:${JSON.stringify(record.gate_id === undefined ? null : record.gate_id)}`;
}

function routeOfMission(records, missionId, seq, phase, label, who = 'close') {
  const matches = recordsAtSeq(records, seq);
  if (matches.length === 0) {
    throw new Error(`mission: ${who} refused — no ledger record has seq ${seq} (${label})`);
  }
  if (matches.length > 1) {
    throw new Error(`mission: ${who} refused — seq ${seq} is ambiguous (${matches.length} records carry it)`);
  }
  const route = matches[0];
  if (route.kind !== 'route') {
    throw new Error(
      `mission: ${who} refused — ledger record at seq ${seq} has kind "${route.kind}", not "route" (${label})`
    );
  }
  if (route.mission_id !== missionId) {
    throw new Error(
      `mission: ${who} refused — ${label} at seq ${seq} belongs to mission ${JSON.stringify(route.mission_id)}, not "${missionId}"`
    );
  }
  if (route.phase !== phase) {
    throw new Error(
      `mission: ${who} refused — ${label} at seq ${seq} is a "${route.phase}"-phase route, not "${phase}"-phase`
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
function checkDispatchMembership(records, missionId, seq, label, who = 'close') {
  const matches = recordsAtSeq(records, seq);
  if (matches.length > 1) {
    throw new Error(`mission: ${who} refused — seq ${seq} is ambiguous (${matches.length} records carry it)`);
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
      `mission: ${who} refused — ${label} ${seq} names a record belonging to mission "${owner}", not "${missionId}"`
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

// Whether a route record was written under the rule that a family is derived
// from the routing config's seat table rather than asserted. route.js stamps
// the marker on every route record it writes, so a record without it either
// predates the rule or is a hand-append; the seq of the first one that carries
// it is what bounds the tolerance below, exactly as firstIdentityCarryingGateSeq
// bounds the gate identity tolerance. The specs come from route.js so the
// writer and this fence can never disagree about what marks a record.
function derivedFamily(record, spec) {
  return Object.prototype.hasOwnProperty.call(record, spec.marker);
}

function firstDerivedFamilySeq(records, spec) {
  let first = null;
  for (const record of records) {
    if (!isPlainObject(record) || record.kind !== 'route' || record.phase !== spec.phase) continue;
    if (!Number.isSafeInteger(record.seq) || record.seq < 0) continue;
    if (!derivedFamily(record, spec)) continue;
    if (first === null || record.seq < first) first = record.seq;
  }
  return first;
}

// The independent second fence for §8's cross-family law, run over BOTH of the
// comparison's operands. Every check below reads `author_family` and
// `reviewer_family` as facts, and route.js's reservation-time derivation is
// written by the same hand that writes the record — so close re-derives each
// family from the config's entry for the seat that record names, and a record
// the config contradicts does not close, whoever wrote it and whenever they
// wrote it. That deliberately reaches records written before the rule existed:
// a false family is false at any age, and those records are the whole reason
// this fence is here rather than only at the writer.
//
// Both operands, because the law is a comparison and a fence on one side of a
// comparison is not a fence. A claude author asserting family "gpt" makes an
// honestly-derived claude reviewer read as cross-family, which is the same
// laundering the reviewer-side derivation prevents, entered from the other end.
//
// EXACTLY ONE THING is tolerated: a family that cannot be derived AT ALL — the
// seat table does not carry the seat, the name is an alias, the entry records
// no family, or the config cannot be read. A legal close is never invalidated
// by a rule arriving later, so a record from before the rule closes over a seat
// nothing can resolve. That tolerance is BOUNDED in the same shape as the gate
// identity check: once any route of that phase in this stream carries the
// derived marker, a later one without it is an omission, not a legacy record,
// and omission would otherwise be the cheapest way past this binding — name a
// seat nobody has heard of and the family goes unchecked. Each phase is bounded
// by its own records, so a stream that derived reviewers before it derived
// authors does not retroactively condemn its own author routes.
//
// A DERIVED FAMILY THAT DISAGREES IS NEVER TOLERATED — not at any age, not
// under any marker, no exception. The two cases must not be read as one, and a
// rolled-back routing table is precisely where they part company: a rollback
// that leaves the seat unresolvable takes the tolerance above, while a rollback
// that reseats the SAME seat to a different concrete family produces a
// derivation that succeeds and disagrees, and that refuses. Failing closed is
// deliberate — this fence cannot tell a config that was corrected from one that
// was rewritten to launder a past review, and the two are indistinguishable
// from inside the ledger. The cost is the known limit recorded against this
// step: the derivation reads the tree's ACTIVE config, not the dated one the
// record names, so a rollback can refuse a close that was lawful when it was
// recorded. Closing that needs the record's own dated config, which is routing
// knowledge and belongs to whoever owns that hold — not to a widened tolerance
// here, which would trade a refused honest close for an accepted false one.
function checkRouteFamily(treeRoot, phase, route, routeSeq, records) {
  const spec = FAMILY_DERIVATION[phase];
  const seatName = route[spec.seatField];
  const { family, reason } = seatFamily(treeRoot, seatName);
  if (family === null) {
    if (derivedFamily(route, spec)) {
      throw new Error(
        `mission: close refused — the ${spec.label} at seq ${routeSeq} names ${spec.who} seat ${JSON.stringify(seatName)}, whose family cannot be derived: ${reason}; a family that cannot be established has not been established`
      );
    }
    const firstDerived = firstDerivedFamilySeq(records, spec);
    if (firstDerived !== null && route.seq > firstDerived) {
      throw new Error(
        `mission: close refused — the ${spec.label} at seq ${routeSeq} names ${spec.who} seat ${JSON.stringify(seatName)}, whose family cannot be derived (${reason}), and it records no derived family although this stream's ${spec.label}s have since seq ${firstDerived}; an omission is not a legacy record`
      );
    }
    return;
  }
  if (family !== route[spec.familyField]) {
    throw new Error(
      `mission: close refused — the ${spec.label} at seq ${routeSeq} claims ${spec.who} family ${JSON.stringify(route[spec.familyField])} for seat ${JSON.stringify(seatName)}, which the routing config seats in family "${family}"; ${spec.article} ${spec.who}'s family is derived from the config, never asserted alongside the seat`
    );
  }
}

// Independence legality, judged against the records alone. A degraded-path
// review is legal at every class, apex included (no class ceiling), under the
// route snapshot that authorized it — deliberately, there is no code here
// that consults preflight, settings, or any present-day lane state, which is
// what makes a provider's recovery after a legal degraded review incapable of
// retroactively invalidating it. But "under its snapshot" cuts both ways: the
// snapshot must have recorded degraded operation (non-empty degraded_modes),
// or the label authorizes itself. Which seat/model a given class earns on the
// degraded path is routing knowledge and lands with author-aware review
// resolution (3b); the fence here is that the degraded path cannot be entered
// by labeling alone.
//
// EXACTLY WHAT THAT FENCE DOES NOT DECIDE, since the check is one token deep:
//   - `degraded_modes` and `lane_state` are both free-form at this base
//     (route.js:285-289 validates modes as bare tokens, route.js:275-283
//     validates lane states as arbitrary phrases) and no module in machine/src
//     defines a vocabulary for either. So close cannot tell a mode token that
//     names a real outage from one that contradicts its own snapshot's lane
//     states: a route recording degraded_modes ["codex_down"] beside
//     lane_state {gpt: "auto"} passes here. The check is a pre-committed
//     assertion of degradation — made before the author was spawned, immutably
//     and timestamped — not a validated one. Cross-checking the two needs a
//     lane vocabulary that a later step must define, not prose parsed here.
//   - A snapshot that reserved a CROSS-FAMILY reviewer and then reviewed on the
//     degraded path is not authorized by its snapshot at all: the reservation
//     is a forecast, and the degraded path was entered later, when the reserved
//     reviewer was lost (route.js:801-808 makes that deviation carry a
//     replacement_reason). Refusing it here would dead-end the legitimate case
//     — a cross-family lane that goes down while the author is running — with
//     no recovery, so it closes, and which of the two authorized this degraded
//     review is DERIVED and recorded (`review.degraded_authorization`) rather
//     than left indistinguishable in the close record.
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
  if (reviewRoute.independence === 'degraded-path') {
    const modes = authorRoute.degraded_modes;
    if (!Array.isArray(modes) || modes.length === 0) {
      throw new Error(
        `mission: close refused — review is labeled degraded-path but the author route's snapshot records no degraded mode; the degraded path is authorized by the recorded snapshot (cross_family_when_available is a locked floor), never by its own label`
      );
    }
  }
  // Deviation from the reserved capacity must be recorded. This is NOT a
  // strength floor: no model/effort ordering exists at this base to rank the
  // replacement against the reservation, so an arbitrarily weaker reviewer
  // with a recorded replacement_reason passes here. The ranking arrives with
  // class-aware review rows; until then this check makes the deviation
  // auditable, not safe.
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
      `mission: close refused — the review profile differs from the capacity reserved at route time ${JSON.stringify(reserved)} with no recorded replacement_reason; a deviation from the reservation must be recorded`
    );
  }
}

// Which record authorized a degraded-path review, for the close payload: the
// author route's own reserved capacity ("snapshot"), or a recorded deviation
// from a reservation that named some other independence ("deviation" — the
// reserved reviewer was lost after the snapshot was taken, and only the review
// route's replacement_reason speaks to it). Null for a cross-family review.
// An auditor reading a close record can then tell the two apart, which is the
// distinction the degraded_modes fence alone cannot make.
function degradedAuthorizationOf(authorRoute, reviewRoute) {
  if (reviewRoute.independence !== 'degraded-path') return null;
  const reserved = authorRoute.reserved_review;
  return isPlainObject(reserved) && reserved.independence === 'degraded-path' ? 'snapshot' : 'deviation';
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
// since a legal close is never invalidated by a field arriving later. That
// tolerance is BOUNDED: once any gate record in this stream carries the
// fields, a later field-less gate record is an omission, not a legacy record,
// and omission would otherwise be the cheapest way to skip the binding. A
// record that does carry them must name the reviewed artifact, field by
// field, and its identity_check must not report that the tree changed during
// the run — the same rule check-honesty applies, so close and the audit agree
// on the same record.
function checkGateIdentity(gate, reviewedIdentity, gateSeq, records) {
  if (!identityCarryingGate(gate)) {
    const firstCarrying = firstIdentityCarryingGateSeq(records);
    if (firstCarrying !== null && gate.seq > firstCarrying) {
      throw new Error(
        `mission: close refused — gate record at seq ${gateSeq} carries no artifact identity although this stream's gate records have carried one since seq ${firstCarrying}; an omission is not a legacy record`
      );
    }
    return;
  }

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

// Every verdict in this LEDGER, grouped by the mission and the review route it
// names, each group ordered by seq. The grouping spans missions on purpose:
// what a verdict binds is an artifact, and an artifact belongs to no mission.
// Mission ids are free to mint (openMission refuses only a duplicate id), so a
// scan that saw the closing mission's routes alone would be walked around by
// opening a second mission on the byte-identical work — the same attack as the
// second review route, one level up.
//
// The one cross-mission refusal here is misattribution: a verdict claiming
// another mission while naming the route this close cites is not evidence of
// anything, whichever mission it belongs to.
function verdictsByMissionRoute(records, missionId, citedRouteSeq) {
  const byMission = new Map();
  for (const record of records) {
    if (!isPlainObject(record) || record.kind !== 'review-outcome') continue;
    if (!Number.isSafeInteger(record.seq) || record.seq < 0) continue;
    if (record.mission_id !== missionId && record.review_route_seq === citedRouteSeq) {
      throw new Error(
        `mission: close refused — review-outcome at seq ${record.seq} names this mission's review route ${citedRouteSeq} but claims mission ${JSON.stringify(record.mission_id)}; a verdict that misattributes its mission is not evidence`
      );
    }
    let byRoute = byMission.get(record.mission_id);
    if (byRoute === undefined) {
      byRoute = new Map();
      byMission.set(record.mission_id, byRoute);
    }
    const held = byRoute.get(record.review_route_seq);
    if (held === undefined) byRoute.set(record.review_route_seq, [record]);
    else held.push(record);
  }
  for (const byRoute of byMission.values()) {
    for (const outcomes of byRoute.values()) outcomes.sort((a, b) => a.seq - b.seq);
  }
  return byMission;
}

// One review route's replacement chain, re-derived here rather than trusted to
// the writer — the writer can be bypassed by a hand-append, so the close-side
// copy is the one that matters, and it is the same rule: a verdict that
// replaces the standing one on its route names it, says why, and cites a gate
// record answering the verdict it replaces. The first verdict on a route
// supersedes nothing and must claim nothing, or a close record would name a
// supersession that never happened.
//
// ownerMissionId is the mission whose route this is — this mission's, or a
// foreign one's when the chain being re-derived belongs to another mission's
// route. The evidence a chain cites is always scoped to the mission that
// recorded the chain, so a foreign chain is answered with foreign evidence and
// never with ours.
function requireAnsweredChain(records, ownerMissionId, outcomes) {
  const first = outcomes[0];
  if (first.supersedes_seq !== null && first.supersedes_seq !== undefined) {
    throw new Error(
      `mission: close refused — the verdict at seq ${first.seq} is the first for review route ${first.review_route_seq} and claims to supersede seq ${first.supersedes_seq}; there was nothing before it to answer`
    );
  }
  for (let i = 1; i < outcomes.length; i++) {
    const replacer = outcomes[i];
    const replaced = outcomes[i - 1];
    if (replacer.supersedes_seq !== replaced.seq || !isNonEmptyString(replacer.reason)) {
      throw new Error(
        `mission: close refused — the verdict at seq ${replacer.seq} replaces the verdict at seq ${replaced.seq} without naming it with a reason and recorded evidence; a recorded verdict is answered, never silently replaced`
      );
    }
    checkOverturnEvidence(
      records,
      ownerMissionId,
      replacer.evidence_seq,
      replaced,
      'close',
      `the verdict at seq ${replacer.seq}, replacing the verdict at seq ${replaced.seq},`
    );
  }
}

// Returns { own, byMission }: this mission's routes (every chain re-derived,
// so a defect anywhere in this mission's verdict stream refuses the close),
// and every mission's routes for the artifact-scoped scan below. Foreign
// chains are NOT re-derived here — another mission's malformed verdict stream
// is not this close's business until it names this close's artifact, and
// re-deriving them all would make one mission's mess unclosable elsewhere.
function standingVerdictsOf(records, missionId, citedRouteSeq) {
  const byMission = verdictsByMissionRoute(records, missionId, citedRouteSeq);
  const own = byMission.get(missionId) === undefined ? new Map() : byMission.get(missionId);
  for (const outcomes of own.values()) requireAnsweredChain(records, missionId, outcomes);
  return { own, byMission };
}

// The one escape a standing revise has outside its own verdict chain:
// `route.js supersede` naming that route, in the mission that recorded it,
// whose evidence_seq is held to the SAME standard as a superseding verdict's —
// otherwise superseding the route would be the cheaper way round, which is
// exactly the shape being closed. Unanswered, `refusal()` builds the message.
function requireReviseAnswered(records, ownerMissionId, routeSeq, last, label, refusal) {
  const superseded = records.find(
    (r) =>
      isPlainObject(r) &&
      r.kind === 'route-superseded' &&
      r.mission_id === ownerMissionId &&
      r.predecessor_route_seq === routeSeq
  );
  if (superseded === undefined) {
    throw new Error(refusal());
  }
  checkOverturnEvidence(
    records,
    ownerMissionId,
    superseded.evidence_seq,
    last,
    'close',
    `the supersession of ${label} (seq ${superseded.seq}), which answers the standing revise at seq ${last.seq},`
  );
}

// §8 correction 19, enforced against the artifact rather than the route — and
// now rather than the mission, which is the same law one boundary further out.
//
// Re-deriving the replacement chain per review route closed the quiet append
// and nothing else: reserving a SECOND review route on the same author
// dispatch, naming the byte-identical artifact, and recording a first (so
// ritual-free) approve there overturned a standing revise with two lawful CLI
// calls. Scoping the scan to every route of this mission closed that. But a
// route belongs to a mission and an identity does not, and mission ids cost
// one `mission open` with a valid brief: open a second mission, reserve a
// chain binding the byte-identical identity, approve there (first verdict, so
// ritual-free), close THAT mission. The victim stays open forever and nothing
// flags it; the work lands with the finding unanswered.
//
// The rule is therefore: no verdict standing at "revise" against the identity
// being closed, anywhere in this LEDGER, in any mission. It is answered in one
// of three ways, each of which leaves a record, and each of which is honoured
// in the mission that recorded the finding:
//   - a superseding verdict on its own route, carrying evidence (above);
//   - `route.js supersede` naming that route, whose evidence_seq is held to
//     the same standard; or
//   - the author changes the artifact, so the new review round names a
//     different identity and the old finding is no longer about this work.
// The third is what keeps a genuine second round legal. A foreign revise that
// was answered any of those three ways does not block: foreign chains are
// re-derived with the identical rule, under their own mission's id, so a
// foreign mission that did the work of answering its finding is believed
// exactly as this one would be.
//
// Refusing on a foreign mission's revise is fail-closed in the direction this
// design prefers: two verdicts whose identities share a tree or a patch are
// about the same work by construction, never a coincidence.
//
// The limit of the rule is that third escape, and `namesSameArtifact` is what
// decides how wide it is. It is disjunctive, so no relabelling reaches it: an
// empty commit preserves both fields, a rebase preserves the patch, a reparent
// preserves the tree, and any one match is enough. What remains is a commit
// that genuinely changes both the tree and the patch while changing nothing
// that matters — a reformatting, a stray newline — and nothing on the record
// can tell that from a repair, because the record holds hashes and not
// meaning. That is the honest statement of the limit: the fence costs a real
// edit to the work, and a real edit is cheap. What the rule does buy is that
// overturning a finding without editing the work always costs a recorded gate
// run and a stated reason, in the mission that recorded the finding — and,
// because the same predicate governs that gate, editing is never the only path
// left open.
//
// The other limit is where this scan can look, and it has moved twice already:
// review round one scoped the rule to the cited route, round two to every
// route of this mission, round three (here) to every mission in this ledger.
// Each time the same attack was re-run one boundary out, and each time the
// boundary was still inside the ledger, which is why widening it was
// derivable at all. The next boundary out is not: a close run against a second
// maestro tree reads a second ledger.jsonl and cannot see these findings, and
// standing up a tree costs no more than minting a mission id did. That is
// where this SCAN stops, and no scan of THIS ledger can reach a record that is
// not in it. It is not, however, where the fence is cheapest to get around:
// the ledger is plaintext and --repo is caller-chosen, and both of those are
// cheaper than a second tree. The module header states all three together,
// because a reader who takes any one of them for the frontier will trust this
// fence further than it earns.
function requireNoStandingRevise(records, missionId, verdicts, identity, citedRouteSeq) {
  for (const [routeSeq, outcomes] of verdicts.own) {
    const last = outcomes[outcomes.length - 1];
    if (last.verdict !== 'revise') continue;
    // Readable or refused: a revise on this mission's own route is about this
    // mission's work whatever it manages to say, so one naming `{}` fails
    // closed exactly like one naming nothing at all, rather than falling
    // through the predicate as a quiet non-match. Foreign records get no such
    // treatment — see below.
    if (!carriesFullIdentity(last.artifact_identity)) {
      throw new Error(
        `mission: close refused — the standing verdict for review route ${routeSeq} (seq ${last.seq}) is a revise naming no artifact; a finding that cannot be matched to an artifact cannot be shown answered`
      );
    }
    if (!namesSameArtifact(last.artifact_identity, identity)) continue;
    requireReviseAnswered(
      records,
      missionId,
      routeSeq,
      last,
      `review route ${routeSeq}`,
      () =>
        `mission: close refused — review route ${routeSeq} carries a standing revise (seq ${last.seq}) against the very artifact being closed${
          routeSeq === citedRouteSeq ? '' : `, and route ${citedRouteSeq} is being cited instead`
        }; a finding is answered on its own route or by superseding that route with recorded evidence, never by reviewing the same work again elsewhere`
    );
  }

  // Foreign missions, scoped to this artifact. A route whose verdicts never
  // name this identity is another mission's business entirely and is not read;
  // one that does name it is re-derived by the same chain rule, so a defect in
  // a foreign chain ABOUT THIS WORK refuses the close rather than passing
  // quietly — and a foreign mess about other work never reaches this close.
  //
  // A foreign record naming nothing, or naming only some of the four fields,
  // is skipped rather than refused: it could be about anything, and refusing
  // on it would let one junk line in another mission freeze every close in
  // the tree. Skipped, though, means it never reaches the predicate —
  // `carriesFullIdentity` gates both reads below, so a partial identity is
  // unreadable here exactly as `{}` is everywhere else. This is not caution
  // beyond what the rule needs: loosen the guard to match on a partial
  // identity and the resulting block becomes an unanswerable wall, because
  // answering it in the stranger's own mission — a superseding verdict, or
  // `route.js supersede` — is judged by the very same readability rule
  // (`checkOverturnEvidence`'s own full-identity check on the record it
  // cites), and a partial identity fails that too. A record the evidence
  // rule refuses to read cannot be a record the fence enforces.
  for (const [foreignId, byRoute] of verdicts.byMission) {
    if (foreignId === missionId) continue;
    for (const [routeSeq, outcomes] of byRoute) {
      const aboutThisWork = outcomes.some(
        (o) => carriesFullIdentity(o.artifact_identity) && namesSameArtifact(o.artifact_identity, identity)
      );
      if (!aboutThisWork) continue;
      requireAnsweredChain(records, foreignId, outcomes);
      const last = outcomes[outcomes.length - 1];
      if (last.verdict !== 'revise') continue;
      if (!carriesFullIdentity(last.artifact_identity) || !namesSameArtifact(last.artifact_identity, identity)) continue;
      requireReviseAnswered(
        records,
        foreignId,
        routeSeq,
        last,
        `mission ${JSON.stringify(foreignId)}'s review route ${routeSeq}`,
        () =>
          `mission: close refused — mission ${JSON.stringify(foreignId)} carries a standing revise (seq ${last.seq}) on its review route ${routeSeq} against the very artifact being closed; a finding is answered in the mission that recorded it — on its own route, or by superseding that route with recorded evidence — never by opening a second mission on the same work and approving there`
      );
    }
  }
}

// --- close: terminal outcomes for non-winning dispatches ---------------------

// §16.3's closed vocabulary for "what happened to an attempt that did not
// win". Every word is read off a record roster.js or route.js already wrote —
// never accepted from the caller, and never invented for a legal ledger
// combination none of the more specific words name (that residual case reads
// as "superseded", the generic word, rather than as a guess).
const TERMINAL_OUTCOMES = [
  'revised',
  'blocked',
  'superseded',
  'runtime-failed',
  'provider-rerouted',
  'quota-rerouted',
  'profile-escalated',
  'safety-refused',
];

// Every "dispatch" ledger record naming this mission — roster.js register's
// sole writer of the kind (§16.1). A registration with no route_seq never
// reaches the ledger at all (roster.js's own limit, not this module's to
// widen), so this is exactly the population a terminal outcome can be
// derived for.
function dispatchesOfMission(records, missionId) {
  return records.filter((r) => isPlainObject(r) && r.kind === DISPATCH_KIND && r.mission_id === missionId);
}

// The verdict currently standing on ONE review route, scanned fresh rather
// than trusted to a cache — the last review-outcome by seq that names it. A
// record naming this route while claiming a different mission is not read as
// evidence for anything, the same misattribution rule verdictsByMissionRoute
// enforces at the cited route, extended here to every route a non-winning
// dispatch might name.
function standingVerdictOfRoute(records, missionId, reviewRouteSeq) {
  let standing = null;
  for (const record of records) {
    if (!isPlainObject(record) || record.kind !== 'review-outcome') continue;
    if (record.review_route_seq !== reviewRouteSeq) continue;
    if (record.mission_id !== missionId) {
      throw new Error(
        `mission: close refused — review-outcome at seq ${record.seq} names review route ${reviewRouteSeq} of mission "${missionId}" but claims mission ${JSON.stringify(record.mission_id)}; a verdict that misattributes its mission is not evidence`
      );
    }
    if (!Number.isSafeInteger(record.seq) || record.seq < 0) continue;
    if (standing === null || record.seq > standing.seq) standing = record;
  }
  return standing;
}

// The one signal outside the route/review streams: the worker's own six-field
// envelope (validators.js), whose "state" is exactly done | partial | blocked
// and whose sole writer is this module's own recordEnvelope. An envelope
// names a seat, never a dispatch, so it is bound to one by the window between
// this dispatch and the next dispatch this mission ever registers on the same
// seat — the span in which this seat's live entry was this dispatch and no
// other. A window carrying more than one envelope, or envelopes that
// disagree, names nothing with confidence and reads as no signal at all —
// never as "blocked" by majority.
function envelopeOutcomeOf(records, missionId, dispatch, dispatches) {
  if (!isNonEmptyString(dispatch.seat)) return null;
  let windowEnd = Infinity;
  for (const other of dispatches) {
    if (other === dispatch) continue;
    if (other.seat !== dispatch.seat) continue;
    if (!Number.isSafeInteger(other.seq) || other.seq <= dispatch.seq) continue;
    if (other.seq < windowEnd) windowEnd = other.seq;
  }
  const inWindow = records.filter(
    (r) =>
      isPlainObject(r) &&
      r.kind === 'envelope' &&
      r.mission_id === missionId &&
      r.seat === dispatch.seat &&
      Number.isSafeInteger(r.seq) &&
      r.seq > dispatch.seq &&
      r.seq < windowEnd
  );
  if (inWindow.length === 0) return null;
  return inWindow.every((r) => r.state === 'blocked') ? 'blocked' : null;
}

// One non-winning dispatch's terminal outcome, read off exactly three
// streams and nothing the caller says: whether route.js supersede replaced
// its route (and, if so, the transition and reason IT recorded, never a
// caller's word about either), whether a review-outcome stands against it,
// and, failing both, whether its own worker reported "blocked". Silent or
// ambiguous on all three, this throws rather than guess — the refusal names
// the dispatch so the liaison knows exactly which attempt it could not close.
function terminalOutcomeOfDispatch(records, missionId, dispatch, dispatches) {
  const routeSeq = dispatch.route_seq;
  if (!Number.isSafeInteger(routeSeq) || routeSeq < 0) {
    throw new Error(
      `mission: close refused — dispatch ${dispatch.seq} names no readable route_seq; a terminal outcome cannot be derived from a dispatch that names nothing`
    );
  }

  // route.js supersede is the one writer of this kind: if it replaced this
  // dispatch's route, the transition and reason it recorded are the fact —
  // never asserted, always read back.
  const superseded = records.find(
    (r) =>
      isPlainObject(r) && r.kind === SUPERSEDED_KIND && r.mission_id === missionId && r.predecessor_route_seq === routeSeq
  );
  if (superseded) {
    const { transition, reason } = superseded;
    if (reason === 'safety-refusal') return 'safety-refused';
    if (reason === 'quota') return 'quota-rerouted';
    if (reason === 'infrastructure') {
      return transition === 'same-profile-resume' ? 'runtime-failed' : 'provider-rerouted';
    }
    if (reason === 'quality') {
      if (ESCALATION_TRANSITIONS.includes(transition)) return 'profile-escalated';
      if (transition === 'same-profile-resume') return 'revised';
      // convergence, and the structurally-legal but otherwise unnamed
      // same-class-provider-reroute + quality pairing: the generic word,
      // recorded rather than guessed at from a transition-reason pair none of
      // the more specific vocabulary names.
      return 'superseded';
    }
    throw new Error(
      `mission: close refused — the supersession of route ${routeSeq} (seq ${superseded.seq}) records reason ${JSON.stringify(reason)}, outside route.js's closed vocabulary; a terminal outcome cannot be read from an unrecognised reason`
    );
  }

  // Not superseded: the route stood as reserved. What happened to the work
  // it named is read off the review-outcome stream instead.
  if (dispatch.phase === 'review') {
    const standing = standingVerdictOfRoute(records, missionId, routeSeq);
    if (standing !== null) {
      if (standing.verdict === 'revise') return 'revised';
      if (standing.verdict === 'approve') return 'superseded';
    }
  } else {
    // The author's fate is read off the review route(s) bound to it — every
    // one route.js has not itself superseded further, since a superseded
    // review route's own verdict (if any) speaks for a replaced reviewer, not
    // for this author's work.
    const supersededReviewSeqs = new Set(
      records
        .filter((r) => isPlainObject(r) && r.kind === SUPERSEDED_KIND && r.mission_id === missionId)
        .map((r) => r.predecessor_route_seq)
    );
    const reviewRoutes = records.filter(
      (r) =>
        isPlainObject(r) &&
        r.kind === 'route' &&
        r.phase === 'review' &&
        r.mission_id === missionId &&
        r.author_route_seq === routeSeq &&
        !supersededReviewSeqs.has(r.seq)
    );
    let anyRevise = false;
    let anyApprove = false;
    for (const reviewRoute of reviewRoutes) {
      const standing = standingVerdictOfRoute(records, missionId, reviewRoute.seq);
      if (standing === null) continue;
      if (standing.verdict === 'revise') anyRevise = true;
      else if (standing.verdict === 'approve') anyApprove = true;
    }
    if (anyApprove) return 'superseded';
    if (anyRevise) return 'revised';
  }

  const blocked = envelopeOutcomeOf(records, missionId, dispatch, dispatches);
  if (blocked !== null) return blocked;

  throw new Error(
    `mission: close refused — dispatch ${dispatch.seq} (${dispatch.phase}-phase, route ${routeSeq}) cannot be classified: no supersession names its route, no review-outcome stands against it, and no unambiguous blocked envelope names its fate; a terminal outcome is derived, never guessed`
  );
}

// Every non-winning dispatch this mission ever registered, each given the
// terminal outcome the ledger already established for it. The two winning
// seqs are the only ones excluded — close already names their fate itself.
function terminalOutcomesOf(records, missionId, winningAuthorDispatchSeq, winningReviewDispatchSeq) {
  const dispatches = dispatchesOfMission(records, missionId);
  const winners = new Set([winningAuthorDispatchSeq, winningReviewDispatchSeq]);
  return dispatches
    .filter((d) => !winners.has(d.seq))
    .map((dispatch) => ({
      dispatch_seq: dispatch.seq,
      route_seq: dispatch.route_seq,
      phase: dispatch.phase,
      seat: dispatch.seat,
      outcome: terminalOutcomeOfDispatch(records, missionId, dispatch, dispatches),
    }))
    .sort((a, b) => a.dispatch_seq - b.dispatch_seq);
}

// Everything the ledger can decide about this close, decided in one place.
// Returns the resolved records; every check refuses by throwing.
function deriveCloseFacts(treeRoot, records, missionId, input) {
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

  // Before checkReviewLegality, which reads both families as facts when it
  // compares them: a laundering verdict is only worth having if BOTH families
  // it compares are the ones the config records for the seats they name.
  checkRouteFamily(treeRoot, 'author', authorRoute, input.author_route_seq, records);
  checkRouteFamily(treeRoot, 'review', reviewRoute, input.review_route_seq, records);
  checkReviewLegality(authorRoute, reviewRoute);
  const identity = reviewedIdentityOf(reviewRoute, input.review_route_seq);

  // The recorded verdict (§17): the standing verdict for this review route
  // must be an approve, for the very dispatch being credited, against the
  // same identity every other stage names.
  const verdicts = standingVerdictsOf(records, missionId, input.review_route_seq);
  const outcomes = verdicts.own.get(input.review_route_seq);
  if (outcomes === undefined) {
    throw new Error(
      `mission: close refused — no review-outcome record names review route ${input.review_route_seq}; a close needs a recorded verdict, not a narrated one`
    );
  }
  const outcome = outcomes[outcomes.length - 1];
  if (outcome.review_dispatch_seq !== input.review_dispatch_seq) {
    throw new Error(
      `mission: close refused — the recorded verdict (seq ${outcome.seq}) names review dispatch ${outcome.review_dispatch_seq}, not the ${input.review_dispatch_seq} being credited`
    );
  }
  if (outcome.verdict !== 'approve') {
    throw new Error(
      `mission: close refused — the standing recorded review verdict (seq ${outcome.seq}) is ${JSON.stringify(outcome.verdict)}, and only a recorded approve closes a mission`
    );
  }
  const verdictDrift = IDENTITY_FIELDS.filter(
    (field) => !isPlainObject(outcome.artifact_identity) || outcome.artifact_identity[field] !== identity[field]
  );
  if (verdictDrift.length > 0) {
    throw new Error(
      `mission: close refused — the recorded approve (seq ${outcome.seq}) names a different artifact than the review route bound: field(s) ${verdictDrift.join(', ')} differ`
    );
  }
  requireNoStandingRevise(records, missionId, verdicts, identity, input.review_route_seq);

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
  const gateKey = gateKeyOf(gate);
  for (const record of records) {
    if (!isPlainObject(record) || record.kind !== 'gate') continue;
    if (record.mission_id !== missionId || gateKeyOf(record) !== gateKey) continue;
    if (Number.isSafeInteger(record.seq) && record.seq > gate.seq) {
      throw new Error(
        `mission: close refused — gate ${JSON.stringify(gate.gate_id)} at seq ${gateSeq} is superseded by a later run at seq ${record.seq} (latest-by-seq honesty)`
      );
    }
  }
  // §8: one gate, one name — the final gate. No record yet names WHICH
  // gate_id is the final one, so the derivable form of that law is: no other
  // gate_id's latest record for this mission may stand as anything but an
  // honest pass. A failure someone recorded and nobody answered is not closed
  // over just because a greener gate ran under a different name — and neither
  // is a green whose own identity_check says it mutated the tree it tested,
  // which is the same unanswered thing wearing a 0 (check-honesty and
  // checkGateIdentity both treat that record as a non-pass).
  const latestPerGate = new Map();
  for (const record of records) {
    if (!isPlainObject(record) || record.kind !== 'gate') continue;
    if (record.mission_id !== missionId) continue;
    if (!Number.isSafeInteger(record.seq) || record.seq < 0) continue;
    const key = gateKeyOf(record);
    const held = latestPerGate.get(key);
    if (held === undefined || record.seq > held.seq) latestPerGate.set(key, record);
  }
  for (const [key, record] of latestPerGate) {
    if (key === gateKey) continue;
    if (record.exit_code !== 0) {
      throw new Error(
        `mission: close refused — the latest record of gate ${JSON.stringify(record.gate_id)} (seq ${record.seq}) has exit_code ${JSON.stringify(record.exit_code)}; an unanswered red gate on this mission's record is not closed over`
      );
    }
    const otherCheck = record.identity_check;
    if (isPlainObject(otherCheck) && otherCheck.verified === false) {
      throw new Error(
        `mission: close refused — the latest record of gate ${JSON.stringify(record.gate_id)} (seq ${record.seq}) exited 0 but reports that it mutated the tree it tested; a dishonest green is as unanswered as a red`
      );
    }
  }
  checkGateIdentity(gate, identity, gateSeq, records);
  // §8 order: the final gate runs on the APPROVED artifact — a gate that ran
  // before the standing approve existed proved a pre-verdict state of the
  // world, whatever its identity says.
  if (gate.seq < outcome.seq) {
    throw new Error(
      `mission: close refused — the cited gate (seq ${gate.seq}) ran before the standing approve was recorded (seq ${outcome.seq}); the final gate runs on the approved artifact (review-then-gate order)`
    );
  }

  // Every OTHER dispatch this mission ever registered gets its terminal
  // outcome here, derived from the same ledger this whole function already
  // trusts — never accepted from the caller, and refused rather than guessed
  // where the ledger does not establish which outcome applies.
  const terminalOutcomes = terminalOutcomesOf(
    records,
    missionId,
    input.winning_author_dispatch_seq,
    input.winning_review_dispatch_seq
  );

  return { authorRoute, reviewRoute, outcome, gate, identity, terminalOutcomes };
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
    review_outcome_seq: facts.outcome.seq,
    review: {
      seat: facts.reviewRoute.reviewer_seat,
      family: facts.reviewRoute.reviewer_family,
      model: facts.reviewRoute.reviewer_model,
      effort: facts.reviewRoute.reviewer_effort,
      independence: facts.reviewRoute.independence,
      replacement_reason: facts.reviewRoute.replacement_reason === undefined ? null : facts.reviewRoute.replacement_reason,
      degraded_authorization: degradedAuthorizationOf(facts.authorRoute, facts.reviewRoute),
    },
    artifact_identity: identity,
    landing,
    // §16.3: every non-winning dispatch this mission registered, each with
    // the terminal outcome deriveCloseFacts read off the ledger for it. Empty
    // for a single-attempt mission — there is nothing else to account for.
    terminal_outcomes: facts.terminalOutcomes,
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

  // The git proof runs BEFORE the state lock is taken: jsonl's lock is
  // reclaimed as stale after 30s, and the squash proof walks the landing
  // branch with a git spawn per commit — an unbounded hold inside the lock
  // would let another writer steal it mid-close. The identity the proof binds
  // comes from an immutable ledger record, so proving it against the
  // repository early loses nothing; every ledger-derived refusal is re-run
  // inside the lock against the locked read, which is the read the decision
  // is made on.
  // Open status is read once here, outside the lock, purely so the message a
  // liaison sees names the real problem: re-closing a done mission whose
  // landing branch has since moved on would otherwise report the repository
  // trouble the proof hits first. The authoritative one-shot check is still
  // the one inside the lock below — this read decides nothing.
  requireOpenMission(readJson(statePath, undefined), statePath, missionId);

  let preFacts;
  {
    const { records, errors } = readRecords(ledgerPath);
    if (errors.length > 0) {
      const detail = errors.map((e) => `line ${e.line}: ${e.reason}`).join('; ');
      throw new Error(`mission: ${ledgerPath} has malformed record(s) — refusing to trust this stream: ${detail}`);
    }
    preFacts = deriveCloseFacts(treeRoot, records, missionId, input);
  }
  const landing = proveLanding(repo, preFacts.identity);

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

      const facts = deriveCloseFacts(treeRoot, records, missionId, input);
      // The landing was proven against the pre-lock read's identity and the
      // payload is built from the locked read's. They cannot differ today —
      // the cited seqs are immutable, the ledger is append-only, and
      // recordsAtSeq refuses an ambiguous seq — but "cannot" is an argument,
      // and this is the check that makes it structural if a later step ever
      // loosens one of those three.
      const drifted = IDENTITY_FIELDS.filter((field) => facts.identity[field] !== preFacts.identity[field]);
      if (drifted.length > 0) {
        throw new Error(
          `mission: close refused — the reviewed identity changed between the landing proof and the locked read: field(s) ${drifted.join(', ')} differ; the proof does not describe the artifact being closed`
        );
      }
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
  record-review <treeRoot> <missionId>
      stdin { review_route_seq, review_dispatch_seq, verdict,
      artifact_identity, supersedes_seq?, reason?, evidence_seq? } — verdict
      "approve" or "revise", both recorded the same way (ledger kind
      "review-outcome"): the approve is what close later requires, the revise
      on record is what stops a rejected review from quietly closing. A
      verdict that REPLACES the standing verdict on the same review route
      must carry all three supersession keys — the standing record's seq, a
      single-line reason, and an evidence_seq naming a GATE record of this
      mission recorded after the verdict being answered — because a verdict is
      an assertion, not a re-executed command (a first verdict must carry none
      of the three). What that buys is worth stating exactly: on work that did
      NOT change, no gate can transition, so the record named is a
      re-observation of the repository recorded after the finding, plus a
      stated reason — not a contradiction of the finding. The rule enforces
      that overturning a verdict costs a fresh gate run and a reason on the
      record, never a silent replacement; judging whether the reason is good is
      a human's job, not this CLI's. The gate must be about the same work the
      answered verdict judged, by the same predicate the close-side fence uses
      (source_tree OR patch_digest) — so a gate run after an ordinary rebase
      still answers the finding it postdates. A verdict is not its own
      refutation: an evidence_seq naming a review-outcome, the mission-open
      record, or another mission's record is refused. REFUSES a verdict whose artifact_identity
      differs field by field from the identity the named review route bound,
      a seq that is not this mission's review-phase route, a review dispatch
      seq naming another mission's record, or a supersession naming anything
      but the standing verdict.
  close [--repo <path>] <treeRoot> <missionId>
      stdin: sequence references and nothing else —
      { ${CLOSE_KEYS.join(', ')} }
      (the winning seqs equal the primary ones in the single-attempt case).
      Every enforced fact is DERIVED from the records those seqs name, never
      accepted from the caller: the reviewer profile, independence and reviewed
      artifact identity come from the review-phase route record, pass evidence
      from the gate record, and BOTH families from the routing config's entries
      for the seats those records name — never from the records' own claims
      about themselves. REFUSES when: either route is missing, ambiguous, of the
      wrong kind/phase/mission, or superseded by a replacement; the review
      route binds a different author route or author dispatch; a dispatch seq
      names another mission's record; the winning seqs are not the dispatches
      the cited chain binds; either route's family is not the one the routing
      config records for the seat that record names (author_family against
      resolved_seat, reviewer_family against reviewer_seat), or that family
      cannot be derived at all in a stream whose routes of that phase already
      derive theirs (a record from before that rule closes over an underivable
      seat, and the first derived record of its phase is where that tolerance
      stops); a review labeled cross-family names a reviewer
      of the author's own family; a degraded-path label on a route snapshot
      that recorded no degraded mode (the label never authorizes itself); the
      review profile differs from the capacity reserved at route time with no
      replacement_reason (a recorded deviation, not a strength floor — no
      model/effort ordering exists yet to rank the replacement); no
      review-outcome record names the review route, the standing one is a
      revise, a replacing verdict failed to answer the one before it with a
      reason and a later gate record of its own mission, the verdict is for a
      different review dispatch, or it approves a different identity than the
      review route bound; ANY review route IN THIS LEDGER — this mission's or
      another mission's — carries a standing revise against the artifact being
      closed. "The same artifact" is one predicate used by every check that
      asks it: the same work when source_tree OR patch_digest matches, since
      either alone already proves the same change. An empty commit, a rebase
      onto a moved mainline and a reparent are all relabels, not second rounds;
      only a real edit to the work is one. Such a finding is answered
      in the mission that recorded it: on its own route, or by superseding that
      route with evidence held to the same standard — never by reserving a
      second route, and never by opening a second mission, on the
      byte-identical artifact and approving there. A foreign finding that WAS
      answered any of those ways does not block. Also refuses when: the gate is
      not exit 0, not this mission's, not the latest run of its gate_id,
      older than the standing approve (the final gate runs on the approved
      artifact), omits its identity fields in a stream whose gate records
      already carry them, or names a different artifact identity than the
      review (field by field — a digest is never compared with a commit sha)
      or reports its tree changed during the run; any OTHER gate_id's latest
      record for this mission stands red or reports a tree it mutated (one
      gate, one name — an unanswered failure is not closed over, and a
      dishonest green is as unanswered as a red); or the landed result is not proven
      equivalent in --repo (default: current directory): commit containment
      for an ordinary merge, patch identity over the canonical patch for a
      squash — the proof's repository (toplevel, roots, origin) is recorded
      into the close so it can be re-audited.
      A degraded-path review is legal at every class under the route snapshot
      that authorized it; close reads no present-day provider state, so a
      provider recovering after a legal degraded review changes nothing. That
      fence is one recorded token deep: degraded_modes and lane_state are
      free-form at this base, so a snapshot that contradicts itself still
      closes, and a degraded review that replaced a cross-family reservation
      closes on its recorded replacement_reason — the close record's
      review.degraded_authorization says which of the two authorized it
      ("snapshot" or "deviation") rather than leaving them alike. §16.3: every
      OTHER "dispatch" ledger record this mission registered (roster.js
      register, excluding the two winning seqs above) is given a terminal
      outcome in the close record's "terminal_outcomes", drawn from exactly
      ${TERMINAL_OUTCOMES.join(' | ')} and derived, never asserted — a route
      supersession's own transition and reason (safety-refusal, quota,
      infrastructure by same-profile-resume vs same-class-provider-reroute,
      quality by escalation vs same-profile-resume vs anything else legal but
      unnamed), a standing review-outcome against an unsuperseded route, or an
      unambiguous "blocked" worker envelope in the window between one dispatch
      and the next on its seat. A dispatch none of those three streams can
      classify REFUSES the close, naming the dispatch. Empty for a
      single-attempt mission. On success sets status "done" and appends
      ledger kind "mission-close" naming the derived facts and the landing
      proof.

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
  'record-review': 2,
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
    } else if (command === 'record-review') {
      result = recordReview(treeRoot, rest[1], input);
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
  recordReview,
  closeMission,
  CLOSE_KEYS,
  REVIEW_VERDICTS,
  LANDING_BRANCHES,
  MISSION_STATUSES,
  TERMINAL_OUTCOMES,
};
