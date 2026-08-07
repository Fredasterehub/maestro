'use strict';

// maestro machine layer — friction recorder.
//
// The SOLE sanctioned writer of ledger.jsonl friction records: the closed
// vocabulary from DECISIONS.md's Visibility section — three rare real-time
// events (ladder engaged, seat degraded, worker died-and-re-dispatched) plus
// revise-verdict, recorded on every reviewer revise so the revise-cap and the
// per-mission audit patterns have one honest source. Unlike deviate.js's
// wrapper "deviation" kind, the ledger kind here is the friction kind
// *verbatim* — a reader can `grep '"kind":"ladder-engaged"'` the ledger
// directly, no second field to unwrap.
//
// `rates` is the read side: JSON aggregates over the ledger's friction
// records, the evidence `/maestro:audit` reports against. Zero of any kind
// is a legitimate, reportable outcome — it is never omitted from the shape.
// §16.5 widens the read side beyond friction alone: `rates` also joins the
// dispatch, route, route-superseded, review-outcome, dispatch-outcome and
// mission-close streams (each still written solely by its own module — this
// file only reads them) into a by-class breakdown, the two first-pass
// measures, fable-low's own rescue figures, and experiment proposals. A
// metric this join cannot source from a record one of those writers actually
// produced is reported absent, never approximated — see computeAttemptRates
// below.

const fs = require('node:fs');
const path = require('node:path');

const { appendRecord, readRecords } = require('./jsonl.js');
const { validateFriction, FRICTION_KINDS } = require('./validators.js');
// The join side of §16.5 reads across every kind these three modules are the
// sole writer of, never restating a kind string or a closed vocabulary this
// codebase already names once — the same discipline validators.js's
// FRICTION_KINDS import above already follows. DISPATCH_OUTCOME_KIND in
// particular is read rather than re-derived from route-superseded's own
// transition/reason pair: mission.js's closeMission already classified every
// non-winning dispatch once (its own closed TERMINAL_OUTCOMES vocabulary),
// and a second, independent classification of the same fact here is a second
// place for that mapping to drift out of sync with the one the close itself
// used — repair round 1, F4.
const { CLASS_ORDER, ROUTE_KIND, SUPERSEDED_KIND } = require('./route.js');
const { DISPATCH_KIND, OUTCOME_KIND: PROFILE_OUTCOME_KIND } = require('./roster.js');
const { DISPATCH_OUTCOME_KIND } = require('./mission.js');
// review-outcome and mission-close have no dedicated export — mission.js's
// own classify() and closePayloadOf reference them as the same literal
// strings, so this matches the existing convention rather than inventing one.
const REVIEW_OUTCOME_KIND = 'review-outcome';
const MISSION_CLOSE_KIND = 'mission-close';
// Twenty closes in one (class, seat) cell is where §16.6 says an experiment
// becomes worth proposing — never where a status is promoted, which is why
// this module never writes anything back for it.
const EXPERIMENT_PROPOSAL_THRESHOLD = 20;
// Provider reroutes and profile escalations are read off dispatch-outcome
// (F4, below); route-superseded's own transition vocabulary is still needed
// for the one fact dispatch-outcome cannot supply — whether a mission ever
// opened a convergence route at all (§16.5's "fraction still reaching
// convergence"), which has no terminal-outcome word of its own since
// convergence is a fresh adjudication route, not a fate the superseded
// dispatch itself is classified into.
const CONVERGENCE_TRANSITION = 'convergence';

const LEDGER_BASENAME = 'ledger.jsonl';
const UNKNOWN_MISSION = '(unknown mission)';

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Refuses a treeRoot that is not an existing directory: this module records
// into a tree, it never creates one — genesis belongs to the scaffold.
function requireTree(treeRoot) {
  if (!isNonEmptyString(treeRoot)) {
    throw new TypeError('friction: treeRoot must be a non-empty string');
  }
  let stat;
  try {
    stat = fs.statSync(treeRoot);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`friction: no tree at "${treeRoot}" — scaffold it first`);
    }
    throw err;
  }
  if (!stat.isDirectory()) {
    throw new Error(`friction: "${treeRoot}" is not a directory`);
  }
}

// recordFriction(treeRoot, friction) -> stamped ledger record. Refuses
// (throws) before anything reaches disk on a malformed friction record.
function recordFriction(treeRoot, friction) {
  requireTree(treeRoot);
  const { ok, errors } = validateFriction(friction);
  if (!ok) {
    throw new TypeError(`friction: invalid friction record — ${errors.join('; ')}`);
  }
  const payload = { mission_id: friction.mission_id };
  if (Object.prototype.hasOwnProperty.call(friction, 'seat')) {
    payload.seat = friction.seat;
  }
  payload.detail = friction.detail;
  return appendRecord(path.join(treeRoot, LEDGER_BASENAME), {
    // Ledger kind is the friction kind verbatim — never wrapped.
    kind: friction.kind,
    payload,
    correlation_id: friction.mission_id,
  });
}

function emptyKindCounts() {
  const counts = {};
  for (const kind of FRICTION_KINDS) counts[kind] = 0;
  return counts;
}

// `dispatched` and `closed` are DIFFERENT UNITS and must never be divided
// into a rate (repair round 1, F5): `dispatched` counts author ATTEMPTS at
// this class (excluding resumes — a resume "is not a new attempt",
// route.js's own words), `closed` counts MISSIONS whose winning attempt's
// class is this one at the time it won. A mission that escalated from
// standard to expert reads `standard.dispatched: 1` and `expert.closed: 1` —
// one mission, two cells, on purpose. `initial_dispatches` and
// `initial_class_closes` share ONE unit (missions) on purpose, so
// `initial_class_closes / initial_dispatches` is a ratio the data actually
// supports: of the missions whose FIRST attempt was dispatched in this
// class, how many eventually closed, whatever class they closed under.
// `first_pass_unknown` is closes counted in `closed` whose dispatch/route
// record this join could not locate — reported as its own count, never
// folded silently into a `mission_first_pass`/`attempt_first_pass` zero
// (repair round 1, F11).
function emptyClassCell() {
  return {
    dispatched: 0,
    closed: 0,
    initial_dispatches: 0,
    initial_class_closes: 0,
    mission_first_pass: 0,
    attempt_first_pass: 0,
    degraded_path_closes: 0,
    first_pass_unknown: 0,
  };
}

function meanOf(values) {
  return values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
}

// The fable-low PROFILE, not any one seat's name: `executor-fable-low`,
// `planner` and `convergence` all pin fable-5/low (design §4/§16.5), and a
// rescue is a fact about the profile's own behaviour under escalation, not
// about which seat happened to carry it this time. `startsWith`, not a bare
// substring test, so a future model whose name merely CONTAINS "fable" (or a
// seat's own name leaking into a model-shaped field) does not silently join
// this population.
function isFableLowProfile(model, effort) {
  return typeof model === 'string' && model.toLowerCase().startsWith('fable') && effort === 'low';
}

// computeAttemptRates(records) -> { by_class, rescue, experiment_proposals },
// joined across the dispatch, route, route-superseded, review-outcome,
// dispatch-outcome, mission-close and profile-outcome streams by
// dispatch_seq / route_seq / mission_id — never by asserting a shape none of
// those writers promised. Anything this join cannot locate (a winning
// dispatch_seq with no "dispatch" record behind it, a rescue whose dispatch
// record cannot be found to time it) is left OUT of the count it would have
// fed, or surfaced in its own "could not resolve" counter, rather than
// guessed at: a missing join is a fact this module cannot state, not a zero
// to report in its place.
function computeAttemptRates(records) {
  const dispatchesBySeq = new Map();
  const authorDispatches = [];
  for (const r of records) {
    if (!isPlainObject(r) || r.kind !== DISPATCH_KIND) continue;
    dispatchesBySeq.set(r.seq, r);
    if (r.phase === 'author') authorDispatches.push(r);
  }
  // A resume "is not a new attempt" (route.js's own words at the writer that
  // enforces it) — it repeats the same attempt number under the same
  // profile, so it is excluded from every attempt-count below (repair round
  // 1, F5). It is still a real dispatch and still eligible to WIN a close;
  // only the counting of attempts excludes it.
  const freshAuthorDispatches = authorDispatches.filter((d) => d.resumed !== true);

  const routesBySeq = new Map();
  for (const r of records) {
    if (isPlainObject(r) && r.kind === ROUTE_KIND) routesBySeq.set(r.seq, r);
  }

  const supersessions = records.filter((r) => isPlainObject(r) && r.kind === SUPERSEDED_KIND);
  const reviewOutcomes = records.filter((r) => isPlainObject(r) && r.kind === REVIEW_OUTCOME_KIND);
  const dispatchOutcomes = records.filter((r) => isPlainObject(r) && r.kind === DISPATCH_OUTCOME_KIND);
  const closes = records.filter((r) => isPlainObject(r) && r.kind === MISSION_CLOSE_KIND);
  const profileOutcomes = records.filter((r) => isPlainObject(r) && r.kind === PROFILE_OUTCOME_KIND);

  // A mission closes once; nothing in mission.js can produce a second
  // "mission-close" for one mission_id, but latest-by-seq is kept anyway
  // rather than the first found, matching the same honesty rule this file's
  // by_mission loop already applies to nothing more exotic than trust.
  const closeByMission = new Map();
  for (const c of closes) {
    const held = closeByMission.get(c.mission_id);
    if (held === undefined || c.seq > held.seq) closeByMission.set(c.mission_id, c);
  }

  // A route that was itself superseded is a route mission.js's own close
  // logic disregards when judging the AUTHOR it belonged to
  // (mission.js:1722-1739's supersededReviewSeqs filter) — attempt_first_pass
  // mirrors that exclusion exactly (repair round 1, F3), rather than reading
  // every review-outcome record a reroute chain ever touched.
  const supersededRouteSeqs = new Set(supersessions.map((s) => s.predecessor_route_seq));

  const by_class = {};
  for (const cls of CLASS_ORDER) by_class[cls] = emptyClassCell();

  for (const d of freshAuthorDispatches) {
    if (!by_class[d.class]) by_class[d.class] = emptyClassCell();
    by_class[d.class].dispatched += 1;
  }

  // The mission's OWN first attempt, per mission — the earliest fresh
  // (non-resumed) attempt-1 dispatch by ledger seq. This is a MISSION fact
  // (one per mission), the same unit `closed` counts in, unlike `dispatched`
  // above which counts ATTEMPTS — see emptyClassCell's comment (F5).
  const initialDispatchByMission = new Map();
  for (const d of freshAuthorDispatches) {
    if (d.attempt !== 1) continue;
    const held = initialDispatchByMission.get(d.mission_id);
    if (held === undefined || d.seq < held.seq) initialDispatchByMission.set(d.mission_id, d);
  }
  for (const d of initialDispatchByMission.values()) {
    if (!by_class[d.class]) by_class[d.class] = emptyClassCell();
    by_class[d.class].initial_dispatches += 1;
  }

  const cellCloses = new Map(); // "class::seat" -> closes

  for (const close of closes) {
    if (closeByMission.get(close.mission_id) !== close) continue; // superseded by a later close of the same mission

    const cls = close.task_class;
    if (!by_class[cls]) by_class[cls] = emptyClassCell();
    by_class[cls].closed += 1;
    if (isPlainObject(close.review) && close.review.independence === 'degraded-path') {
      by_class[cls].degraded_path_closes += 1;
    }

    const initial = initialDispatchByMission.get(close.mission_id);
    if (initial !== undefined) {
      if (!by_class[initial.class]) by_class[initial.class] = emptyClassCell();
      by_class[initial.class].initial_class_closes += 1;
    }

    if (isNonEmptyString(close.author_seat)) {
      const key = `${cls}::${close.author_seat}`;
      cellCloses.set(key, (cellCloses.get(key) || 0) + 1);
    }

    const authorRoute = routesBySeq.get(close.author_route_seq);
    const winningDispatch = dispatchesBySeq.get(close.winning_author_dispatch_seq);
    if (authorRoute === undefined || winningDispatch === undefined) {
      // The join this close needs cannot be made — surfaced on its own
      // counter (F11), never folded silently into a first-pass zero.
      by_class[cls].first_pass_unknown += 1;
      continue;
    }

    // attempt_first_pass: the winning attempt's OWN review history — every
    // review route ever opened against the winning author route (a reviewer
    // reroute opens a new one that keeps the same author_route_seq, so
    // filtering on that field alone walks the whole reroute chain) EXCEPT
    // one route.js itself superseded, since mission.js's own close disregards
    // a replaced reviewer's verdict when judging the author (F3).
    const ownReviewRouteSeqs = new Set();
    for (const route of routesBySeq.values()) {
      if (route.phase === 'review' && route.author_route_seq === close.author_route_seq && !supersededRouteSeqs.has(route.seq)) {
        ownReviewRouteSeqs.add(route.seq);
      }
    }
    const attemptRevises = reviewOutcomes.filter(
      (ro) => ro.mission_id === close.mission_id && ownReviewRouteSeqs.has(ro.review_route_seq) && ro.verdict === 'revise'
    ).length;
    if (attemptRevises === 0) by_class[cls].attempt_first_pass += 1;

    // mission_first_pass: the winning attempt is the mission's first AND the
    // whole mission spent zero revise rounds (every review-outcome "revise"
    // recorded anywhere on the mission — a real revise round is a fact of
    // the mission's history whether or not the route it landed on was later
    // superseded, which is why this reads wider than attempt_first_pass's
    // own-route filter above), zero provider reroutes and zero profile
    // escalations. The latter two are read off the SAME "dispatch-outcome"
    // records mission.js's own close already wrote for every non-winning
    // dispatch (§16.3), not re-derived from route-superseded's
    // transition/reason pair a second time (F4) — mission.js is this
    // vocabulary's sole writer and its classification is the one this rate
    // must agree with.
    const missionRevises = reviewOutcomes.filter(
      (ro) => ro.mission_id === close.mission_id && ro.verdict === 'revise'
    ).length;
    const missionDispatchOutcomes = dispatchOutcomes.filter((o) => o.mission_id === close.mission_id);
    const providerReroutes = missionDispatchOutcomes.filter((o) => o.outcome === 'provider-rerouted').length;
    const profileEscalations = missionDispatchOutcomes.filter((o) => o.outcome === 'profile-escalated').length;
    const missionFirstPass =
      winningDispatch.attempt === 1 && missionRevises === 0 && providerReroutes === 0 && profileEscalations === 0;
    if (missionFirstPass) by_class[cls].mission_first_pass += 1;
  }

  // §16.6: propose, never conclude. A cell that reaches the threshold is
  // surfaced here; nothing anywhere in this module writes a status change.
  //
  // Plan §17 names this a ledger record ("experiment proposal ... at
  // aggregation threshold"); this returns a field instead (repair round 1,
  // F8 — liaison ruling). FRICTION_KINDS (validators.js) carries no
  // "experiment-proposal" kind, and validators.js is fenced out of this
  // step's surface — this module is the sole writer of the friction
  // vocabulary's ledger records, but it does not own that vocabulary, so it
  // cannot mint the kind a record would need without exceeding its brief.
  // If that vocabulary later gains one, this becomes an append instead of a
  // return; until then, a returned field, said plainly, is the honest
  // choice over a silent one. It also has no memory: every call recomputes
  // from the whole ledger, so a cell already proposed is proposed again on
  // the next run — there is no "already acted on" state for a stateless
  // aggregate to consult, and adding one is the same out-of-surface problem.
  const experiment_proposals = [];
  for (const [key, closesCount] of cellCloses) {
    if (closesCount >= EXPERIMENT_PROPOSAL_THRESHOLD) {
      const [cls, seat] = key.split('::');
      experiment_proposals.push({ class: cls, seat, closes: closesCount });
    }
  }
  experiment_proposals.sort((a, b) =>
    a.class === b.class ? a.seat.localeCompare(b.seat) : a.class.localeCompare(b.class)
  );

  // --- fable-low rescue metrics (§16.5/§16.6) ---------------------------
  //
  // Every measure below is stated over the fable-low population alone, in
  // its own terms — NEVER a raw comparison against opus. Production routing
  // is selection-biased (opus sees ordinary work; fable-low sees work an
  // escalation already required), so a ratio between the two would measure
  // the routing, not the models.
  //
  // The population that matters is split in two, and conflating them is
  // exactly the defect repair round 1 found (F1): `fallback_used: true`
  // means fable-low did NOT run — §16.2's own attribution rule counts that
  // as OPUS execution. `fable_low_ran` (`fallback_used: false`) is the
  // population where fable-low actually executed, and "was it rescued" —
  // did that execution's own dispatch go on to win the close — is a question
  // about THAT population, never about the fallback one.
  const fableLowDispatches = freshAuthorDispatches.filter((d) => isFableLowProfile(d.worker_model, d.worker_effort));
  const fableLowOutcomes = profileOutcomes.filter((p) => isFableLowProfile(p.requested_worker_model, p.requested_worker_effort));
  const fallbacks = fableLowOutcomes.filter((p) => p.fallback_used === true);
  const fableLowRan = fableLowOutcomes.filter((p) => p.fallback_used === false);
  // The record's own authoritative boolean (roster.js derives it from
  // route.js's closed reason vocabulary, never from the caller) — never a
  // regex over the free-text fallback_reason a fallback happens to carry
  // (F2): a refusal is not always a fallback (P3 — refused, then rerouted to
  // an entirely different route, fallback_used stays false) and a fallback's
  // free-text reason is not always a refusal in route.js's sense.
  const refusals = fableLowOutcomes.filter((p) => p.safety_refusal === true);

  let rescuedCount = 0;
  const rescueTimesMs = [];
  for (const p of fableLowRan) {
    const close = closeByMission.get(p.mission_id);
    if (close === undefined || close.winning_author_dispatch_seq !== p.dispatch_seq) continue;
    rescuedCount += 1;
    const dispatch = dispatchesBySeq.get(p.dispatch_seq);
    if (dispatch !== undefined && isNonEmptyString(dispatch.ts) && isNonEmptyString(close.ts)) {
      rescueTimesMs.push(new Date(close.ts).getTime() - new Date(dispatch.ts).getTime());
    }
  }
  // "Fraction still reaching convergence": of the executions where fable-low
  // actually ran, how many of those missions nonetheless opened a
  // convergence route — the escalation profile ran and the disagreement
  // still required adjudication.
  const convergenceCount = fableLowRan.filter((p) =>
    supersessions.some((s) => s.mission_id === p.mission_id && s.transition === CONVERGENCE_TRANSITION)
  ).length;

  // Every field this block reads (requested/actual model+effort,
  // fallback_used, safety_refusal) lives on a profile-outcome record whose
  // evidence_level ships `unknown` on every writer today (roster.js: "no
  // writer anywhere in machine/src reports what a worker's runtime actually
  // was") — surfaced here as data, not just prose, so a consumer can see the
  // caveat travels with the numbers (F7).
  const evidenceLevels = new Set(fableLowOutcomes.map((p) => p.evidence_level));
  const evidenceLevel = evidenceLevels.size === 0 ? null : evidenceLevels.size === 1 ? [...evidenceLevels][0] : 'mixed';

  const rescue = {
    // Every author-phase dispatch requesting the fable-low profile, read off
    // the "dispatch" records roster.js's register always writes — real
    // regardless of whether a profile-outcome was ever recorded for it
    // (F12). Every rate below, which needs fallback_used/safety_refusal, is
    // necessarily scoped to the smaller `fable_low_outcomes_recorded`
    // population instead; the gap between the two is itself a finding worth
    // reporting, not silently absorbed into either count.
    fable_low_dispatches: fableLowDispatches.length,
    fable_low_outcomes_recorded: fableLowOutcomes.length,
    fallback_count: fallbacks.length,
    fallback_rate: fableLowOutcomes.length > 0 ? fallbacks.length / fableLowOutcomes.length : null,
    refusal_count: refusals.length,
    refusal_rate: fableLowOutcomes.length > 0 ? refusals.length / fableLowOutcomes.length : null,
    rescued_count: rescuedCount,
    rescue_rate: fableLowRan.length > 0 ? rescuedCount / fableLowRan.length : null,
    time_to_rescue_ms: meanOf(rescueTimesMs),
    // Disclosed alongside the mean rather than left implicit: a dispatch
    // record this join could not find for a rescued execution drops that
    // one sample from the mean without dropping it from rescued_count, so
    // the two are not guaranteed equal (F10).
    time_to_rescue_sample_size: rescueTimesMs.length,
    convergence_count: convergenceCount,
    convergence_fraction: fableLowRan.length > 0 ? convergenceCount / fableLowRan.length : null,
    evidence_level: evidenceLevel,
    // No writer anywhere in machine/src records a dollar or token cost (the
    // dispatch, profile-outcome and mission-close payloads carry none) — so
    // this is reported absent rather than approximated from a proxy (e.g.
    // dispatch count) that is not actually cost. That is the discipline this
    // step exists to enforce, not an oversight to fill in later.
    incremental_cost_per_rescue: null,
  };

  return { by_class, rescue, experiment_proposals };
}

// computeRates(treeRoot) -> aggregates over every friction record on the
// ledger: counts per kind (global), a per-mission breakdown (per kind plus
// a total), the revise-verdict count per mission on its own (the field the
// revise-cap pattern reads directly), and the ladder-engaged total (the
// field the ladder-engagement pattern reads directly). A ledger record whose
// kind is outside FRICTION_KINDS is not a friction record and is skipped —
// this stream is shared with every other ledger writer.
//
// §16.5's read side widens this beyond the friction kinds alone: by_class
// (dispatched/closed/initial_dispatches/initial_class_closes/
// mission_first_pass/attempt_first_pass/degraded_path_closes/
// first_pass_unknown per task class, joined through the dispatch, route,
// review-outcome, dispatch-outcome and mission-close streams — see
// computeAttemptRates), rescue (fable-low's own terms, never a comparison
// against opus), and experiment_proposals (§16.6 — a proposal, never a
// promotion). Every one of these is derived from a record one of this
// codebase's other sole writers already produced; nothing here asserts a
// fact none of them recorded.
function computeRates(treeRoot) {
  requireTree(treeRoot);
  const { records, errors } = readRecords(path.join(treeRoot, LEDGER_BASENAME));

  const by_kind = emptyKindCounts();
  const by_mission = {};

  for (const record of records) {
    if (!isPlainObject(record) || typeof record.kind !== 'string' || !FRICTION_KINDS.has(record.kind)) {
      continue;
    }
    by_kind[record.kind] += 1;
    const missionId = isNonEmptyString(record.mission_id) ? record.mission_id : UNKNOWN_MISSION;
    if (!by_mission[missionId]) {
      by_mission[missionId] = { ...emptyKindCounts(), total: 0 };
    }
    by_mission[missionId][record.kind] += 1;
    by_mission[missionId].total += 1;
  }

  const revise_verdict_by_mission = {};
  for (const [missionId, counts] of Object.entries(by_mission)) {
    revise_verdict_by_mission[missionId] = counts['revise-verdict'];
  }

  const { by_class, rescue, experiment_proposals } = computeAttemptRates(records);

  return {
    by_kind,
    by_mission,
    revise_verdict_by_mission,
    ladder_engaged_total: by_kind['ladder-engaged'],
    unparseable_lines: errors.length,
    by_class,
    rescue,
    experiment_proposals,
  };
}

// --- CLI --------------------------------------------------------------------

const HELP = `friction.js — maestro friction recorder (sole writer of ledger friction records)

usage: friction.js record <treeRoot>   (friction JSON piped via stdin)
       friction.js rates <treeRoot>

commands:
  record   stdin { kind, mission_id, seat?, detail } — kind one of
           ${[...FRICTION_KINDS].join(', ')};
           mission_id and detail non-empty strings; detail single-line,
           <=200 chars; seat non-empty when present; no extra keys. Appends
           a ledger record whose "kind" is the friction kind verbatim (not
           a wrapper kind) and prints the stamped record.
  rates    prints JSON aggregates over the ledger's friction records:
           { by_kind, by_mission, revise_verdict_by_mission,
             ladder_engaged_total, unparseable_lines, by_class, rescue,
             experiment_proposals }. by_kind and every by_mission entry carry
           all eleven kinds even at zero — zero friction is a legitimate,
           reportable outcome. by_class carries every task class even at
           zero: dispatched (attempts registered at this class, excluding
           resumes) and closed (missions whose winning class was this one)
           are DIFFERENT UNITS from an escalated mission and must never be
           divided into a rate; initial_dispatches and initial_class_closes
           share one unit (missions) on purpose — of the missions that
           started in this class, how many eventually closed, whichever
           class they closed under. mission_first_pass (winning attempt is
           the mission's first AND zero revise rounds/provider
           reroutes/profile escalations mission-wide) and attempt_first_pass
           (the winning attempt's own review history alone) are named and
           counted separately — attempt_first_pass is always >=
           mission_first_pass, never the other way, and neither is ever
           reported as the other. first_pass_unknown counts closes this join
           could not resolve a first-pass fact for (never folded into a
           first-pass zero). rescue reports fable-low's own
           fallback/refusal/rescue/time-to-rescue/convergence figures, scoped
           to the population that actually ran under that profile — never
           the population that fell back to opus, and never a comparison
           against opus — plus fable_low_dispatches vs
           fable_low_outcomes_recorded (the coverage gap where an outcome was
           never recorded), evidence_level (every field these rates read
           ships this profile-outcome caveat, closed vocabulary, "unknown" on
           every writer today), and incremental_cost_per_rescue, always null:
           no writer in this codebase records a cost. experiment_proposals
           lists every (class, seat) cell at 20+ closes — a returned field,
           not a ledger record: no kind in FRICTION_KINDS names it, and
           minting one is outside this module's surface. A proposal to run an
           experiment, never a promotion of that cell's status; recomputed
           fresh on every call, so a cell already proposed is proposed again
           on the next run rather than tracked as acted on.

Errors go to stderr with exit 1; nothing reaches disk on a refusal.
`;

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  const [command, treeRoot, ...rest] = argv;
  try {
    if (command === 'record') {
      if (!isNonEmptyString(treeRoot)) throw new Error('record requires <treeRoot>');
      if (rest.length > 0) throw new Error(`unexpected extra argument(s): ${rest.join(' ')}`);

      const text = fs.readFileSync(0, 'utf8'); // fd 0 = stdin
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        throw new Error(`friction JSON via stdin is not valid JSON: ${err.message}`);
      }
      const result = recordFriction(treeRoot, parsed);
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } else if (command === 'rates') {
      if (!isNonEmptyString(treeRoot)) throw new Error('rates requires <treeRoot>');
      if (rest.length > 0) throw new Error(`unexpected extra argument(s): ${rest.join(' ')}`);

      const result = computeRates(treeRoot);
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } else {
      throw new Error(
        command === undefined ? 'a command is required' : `unknown command "${command}" (expected record or rates)`
      );
    }
  } catch (err) {
    process.stderr.write(`friction.js: ${err.message}\n${HELP}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = { recordFriction, computeRates, LEDGER_BASENAME };
