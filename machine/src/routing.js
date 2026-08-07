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
// Degraded modes key off two data sources, composed through one mechanism:
// state.json.preflight (a provider whose recorded routing token is anything
// but "present" is down — unknown routes as absent, and is never rounded
// up; no recorded preflight applies no probe-driven degradation, and the
// output says so via preflight_recorded) and settings provider_lanes (a
// lane the operator set to "operator-down" is out regardless of probe
// health). Either cause activates the same degraded table; each contributes
// its own notice, so a reader can always tell why a lane is out.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { readJson, writeJson } = require('./atomic-json.js');
const { read: readSettings } = require('./settings.js');
const { BRIEF_TIER_VALUES, validateBrief } = require('./validators.js');

const ROUTING_DIRNAME = 'routing';
const ACTIVE_BASENAME = 'active.json';
const STATE_BASENAME = 'state.json';
const SCHEMA_VERSION = 1;

const FAMILIES = ['claude', 'gpt', 'gemini'];

// Strict basename-only pattern: no path separator can match, so a pointer
// naming '../x' or an absolute path is rejected by shape alone.
const DATED_CONFIG_RE = /^routing-\d{4}-\d{2}-\d{2}-\d+\.json$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

// preflight provider key → degraded sub-table name in the dated config →
// the settings provider_lanes key (which doubles as the worker family the
// lane carries, so capability records key off it too).
const PROVIDER_MODES = [
  ['codex', 'codex_down', 'gpt'],
  ['gemini', 'gemini_down', 'gemini'],
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

// r1 -> r2: split the Sol seat by class, wherever Sol is named. The single
// executor-sol / reviewer-sol profiles become per-class seats mirroring
// their agent-file frontmatter; the old names stay in the seat table as
// migration aliases (alias_of), which are never routable — review rows
// repoint to the expert successors, and degraded substitution maps carry
// the split so every live successor keeps the substitute the old seat had.
function migrateSolSplit(config) {
  const out = JSON.parse(JSON.stringify(config));
  // Shaped refusals over raw TypeErrors: MIGRATIONS is called directly
  // (not only through revise), and §11 wants each migration independently
  // testable — a structurally incomplete source names its missing piece.
  if (!isPlainObject(out.seats)) {
    throw new Error('r1->r2 migration: config has no seats table — not a revision-1 shape');
  }
  for (const required of ['executor-sol', 'reviewer-sol']) {
    if (!isPlainObject(out.seats[required])) {
      throw new Error(`r1->r2 migration: config has no seats["${required}"] to split — not a revision-1 shape`);
    }
  }
  if (!isPlainObject(out.review_routing)) {
    throw new Error('r1->r2 migration: config has no review_routing table — not a revision-1 shape');
  }
  for (const family of FAMILIES) {
    if (!Array.isArray(out.review_routing[family])) {
      throw new Error(`r1->r2 migration: review_routing.${family} is not an array — not a revision-1 shape`);
    }
  }
  if (!isPlainObject(out.degraded)) {
    throw new Error('r1->r2 migration: config has no degraded table — not a revision-1 shape');
  }

  const added = {
    'executor-sol-expert': { model: 'gpt-5.6-sol', family: 'gpt', effort: 'medium', host: 'sonnet-5', host_effort: 'medium' },
    'executor-sol-apex': { model: 'gpt-5.6-sol', family: 'gpt', effort: 'high', host: 'sonnet-5', host_effort: 'high' },
    // scope: 'scoped' survives the split: it is a property of the seat's
    // meaning (diff-scoped review), not of the profile being re-tiered.
    'reviewer-sol-expert-rev': { model: 'gpt-5.6-sol', family: 'gpt', effort: 'medium', host: 'sonnet-5', host_effort: 'medium', scope: 'scoped' },
    'reviewer-sol-apex-rev': { model: 'gpt-5.6-sol', family: 'gpt', effort: 'high', host: 'sonnet-5', host_effort: 'high', scope: 'scoped' },
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
  // Successors of an alias in substitution-map positions: an old name used
  // as a target repoints to its expert successor; an old name used as a
  // key fans out to every successor, each inheriting the old substitute —
  // no live seat is left without the substitute its predecessor had, and
  // no alias stays named anywhere a seat name resolves.
  const SPLIT_KEYS = {
    'executor-sol': ['executor-sol-expert', 'executor-sol-apex'],
    'reviewer-sol': ['reviewer-sol-expert-rev', 'reviewer-sol-apex-rev'],
  };
  const repointTarget = (target) =>
    target === 'executor-sol' ? 'executor-sol-expert' : target === 'reviewer-sol' ? 'reviewer-sol-expert-rev' : target;
  for (const table of Object.values(out.degraded)) {
    if (!isPlainObject(table)) continue;
    if (isPlainObject(table.seats)) {
      const split = {};
      for (const [from, to] of Object.entries(table.seats)) {
        for (const key of SPLIT_KEYS[from] || [from]) {
          split[key] = repointTarget(to);
        }
      }
      table.seats = split;
    }
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

// Both notices are verbatim from the final design's degraded-review section
// (§8) — the design, not any other copy of this text, is its authority.
const DEGRADED_REVIEW_NOTICE =
  'No cross-family reviewer is available, so this work was reviewed on the ' +
  "degraded path: a fresh-context Claude reviewer with no access to the author's " +
  'transcript, on a different Claude model than the author. This is NOT ' +
  'cross-family review — author and reviewer share one model family and may share ' +
  'blind spots. The verdict is recorded as review.independence "degraded-path" ' +
  'and is never counted as independent cross-family approval.';

const DEGRADED_REVIEW_FALLBACK_NOTICE =
  'No cross-family reviewer is available, and the preferred cross-model ' +
  'degraded reviewer was also unavailable, so this work was reviewed by a ' +
  'second fresh-context instance of the same model as the author, with no ' +
  "access to the author's transcript or session. This is NOT cross-family " +
  'review and NOT cross-model review — author and reviewer share one model and ' +
  'family and may share more blind spots than the preferred pairing would have. ' +
  'The verdict is recorded as review.independence "degraded-path" with ' +
  '`fallback_used: true`, and is never counted as independent cross-family or ' +
  'cross-model approval.';

// r2 -> r3: the degraded-review contract becomes data. Four degraded
// reviewer seats join the seats map — real entries, not just names in a
// row, so the frontmatter parity guard reaches their files — carrying only
// the fields those files declare (model, effort, family; no fallback: the
// preference ladder that sends an unavailable degraded reviewer to a
// same-model fresh instance is resolution behaviour in reviewFor, never a
// seat-level fallback profile). The degraded_review block pairs every class,
// apex included, with its tier-scaled preferred reviewer by author model —
// no ceiling field exists and no class holds by default. Row order within
// apex is preference order: the fable-authored pairing is the canonical
// apex authorship and is what an authorship-blind caller gets. The
// review_qualification table arrives in the same migration: the two blocks
// are one contract (what the degraded path is, and when a cross-family
// candidate must yield to it), and validation refuses a config carrying
// one without the other.
function migrateDegradedReview(config) {
  const out = JSON.parse(JSON.stringify(config));
  for (const table of ['seats', 'review_routing', 'degraded']) {
    if (!isPlainObject(out[table])) {
      throw new Error(`r2->r3 migration: config has no ${table} table — not a revision-2 shape`);
    }
  }
  // Same discipline as migrateSolSplit: MIGRATIONS is exported and each
  // entry is independently testable (§11), so a wrong-shaped source is
  // refused by name rather than stamped forward. The Sol split's own
  // output seats are what distinguish a revision-2 shape from revision 1 —
  // they persist into r3, so this stays idempotent at its own boundary.
  for (const required of ['reviewer-sol-expert-rev', 'reviewer-sol-apex-rev']) {
    if (!isPlainObject(out.seats[required])) {
      throw new Error(
        `r2->r3 migration: config has no seats["${required}"] — not a revision-2 shape (the r1->r2 Sol split has not been applied)`
      );
    }
  }
  Object.assign(out.seats, {
    'reviewer-degraded-opus': { model: 'opus-5', family: 'claude', effort: 'medium' },
    'reviewer-degraded-sonnet': { model: 'sonnet-5', family: 'claude', effort: 'high' },
    'reviewer-degraded-opus-apex': { model: 'opus-5', family: 'claude', effort: 'high' },
    'reviewer-degraded-fable-apex': { model: 'fable-5', family: 'claude', effort: 'low' },
  });
  // battery D10: rows map each class to a bare seat-name string per author
  // model — a shape the closed degraded_review block (checkDegradedReviewBlock
  // below) permits no third field on, so a placement here carries no
  // `status: "estimated"` marker the way tiers.classes candidates do (§13,
  // design §4/§6). That is not the same vocabulary silently dropped: every
  // bundle reviewFor resolves off this table — cross-family or degraded —
  // already carries `evidence_level: "unknown"` (design §16.2's
  // profile-outcome vocabulary), which is the honesty `status: "estimated"`
  // exists for, stated at the point the caller actually reads it rather than
  // in the row's own shape. Reconciled here rather than widening rows to
  // { seat, status } objects: that would touch this block's validator, every
  // reviewFor degraded-path read (`row[modelKey]`), and every fixture
  // constructing a row literal, for a marker the resolved bundle already
  // carries under its own name.
  out.degraded_review = {
    notice: DEGRADED_REVIEW_NOTICE,
    fallback_notice: DEGRADED_REVIEW_FALLBACK_NOTICE,
    rows: {
      recon: { 'sonnet-5': 'reviewer-degraded-opus' },
      mechanical: { 'sonnet-5': 'reviewer-degraded-opus' },
      standard: { 'sonnet-5': 'reviewer-degraded-opus' },
      expert: { 'opus-5': 'reviewer-degraded-sonnet' },
      apex: { 'fable-5': 'reviewer-degraded-opus-apex', 'opus-5': 'reviewer-degraded-fable-apex' },
    },
  };
  // Each cross-family reviewer's qualification bound — the highest class it
  // may review (design §6.1; plan amendment "the N3/N4 deferral bound was
  // false"). bans.review_floor_scale_down is a ban, not a schedule, so the
  // bound ships with r3 rather than waiting for r4's class-keyed ladders,
  // which supersede this narrower form. reviewer-gemini is standard-and-
  // below by the 2026-08-07 operator restriction; reviewer-sol-expert-rev
  // is the expert-review rung, so apex work never scales down onto it;
  // reviewer-claude carries apex because until r4 splits the claude ladder
  // it is the entire always-on floor for non-claude authors (§6.2), and
  // bounding it lower would push gpt/gemini-authored work at a degraded
  // path that is claude-scoped by design.
  out.review_qualification = {
    'reviewer-claude': 'apex',
    'reviewer-sol-expert-rev': 'expert',
    'reviewer-sol-apex-rev': 'apex',
    'reviewer-gemini': 'standard',
  };
  out.revision = 3;
  return out;
}

// r3 -> r4: the tiered Claude ladder becomes routable, and review routing
// becomes class-keyed. Six Claude seats join the table — the four author rungs
// design §4.1 pins plus the expert and apex review rungs §6.1 pins — and
// planner and convergence take the profiles their own seat files declare,
// which is what returns the frontmatter parity guard to green. review_routing
// stops being one row per author family and becomes one ladder per (family,
// class): a review floor is now read out of the data instead of inferred from
// a class-blind row. Rows name only seats this revision's table carries — the
// gpt standard rung (reviewer-terra) arrives with r5 and is inserted into
// these same rows there.
//
// The qualification bounds move onto the new seats. r3 bounded
// reviewer-claude at apex because it was the entire always-on Claude floor for
// non-claude authors (§6.2), and bounding it lower would have left gpt- and
// gemini-authored apex work with no qualified reviewer at all; the plan
// records that bound as this migration's to undo. With reviewer-claude-expert
// and reviewer-claude-apex present the monopoly ends, so reviewer-claude
// returns to its design §6.1 standard rung and the higher classes route to the
// seats that carry them — no non-claude-authored expert or apex resolution
// lands on a reviewer profile below its class rung. reviewer-gemini stays
// bounded at standard by the 2026-08-07 operator restriction: it is still
// named in the claude expert and apex rows, because §6.1 keeps gemini's row
// present at every level for roster completeness and requires resolution to
// skip it there as unqualified rather than dispatch it. The gpt rows are the
// one place that restriction is written as absence instead: §6.2 says
// expert/apex gpt-authored review stays on the claude ladder or falls to the
// degraded path, "never to gemini".
function migrateClaudeLadder(config) {
  const out = JSON.parse(JSON.stringify(config));
  // Same discipline as the two migrations before it: a wrong-shaped source is
  // refused by name rather than stamped forward (§11 — every entry is
  // independently testable). degraded_review and review_qualification are the
  // r2->r3 output that distinguishes a revision-3 shape from a revision-2 one,
  // and both persist into r4, so this stays idempotent at its own boundary.
  for (const table of ['seats', 'review_routing', 'degraded']) {
    if (!isPlainObject(out[table])) {
      throw new Error(`r3->r4 migration: config has no ${table} table — not a revision-3 shape`);
    }
  }
  for (const required of ['degraded_review', 'review_qualification']) {
    if (!isPlainObject(out[required])) {
      throw new Error(
        `r3->r4 migration: config has no ${required} block — not a revision-3 shape (the r2->r3 degraded-review migration has not been applied)`
      );
    }
  }
  for (const required of ['planner', 'convergence']) {
    if (!isPlainObject(out.seats[required])) {
      throw new Error(`r3->r4 migration: config has no seats["${required}"] to reprofile — not a revision-3 shape`);
    }
  }

  // Every fable-model seat records the opus-5 high profile it drops to when
  // Fable is unavailable or refuses (design §4.1, §6.1; §10 for the two
  // planning seats). The config is the authority for that profile and the
  // seat files mirror it, never the other way around — the frontmatter keys
  // these entries require land in the step stacked on this one, so the parity
  // guard reads red on exactly those rows until the two halves are together.
  Object.assign(out.seats, {
    'executor-claude-mech': { model: 'sonnet-5', family: 'claude', effort: 'low' },
    'executor-claude-standard': { model: 'sonnet-5', family: 'claude', effort: 'high' },
    'executor-fable-low': { model: 'fable-5', family: 'claude', effort: 'low', fallback: 'opus-5', fallback_effort: 'high' },
    'executor-fable': { model: 'fable-5', family: 'claude', effort: 'high', fallback: 'opus-5', fallback_effort: 'high' },
    'reviewer-claude-expert': { model: 'opus-5', family: 'claude', effort: 'high' },
    'reviewer-claude-apex': { model: 'fable-5', family: 'claude', effort: 'low', fallback: 'opus-5', fallback_effort: 'high' },
  });
  // The planning fallback is a real route (§10): a Fable planner that ran on
  // Opus is Opus execution, which only stays sayable if the profile it fell
  // to is recorded rather than inferred. convergence also gains the family its
  // model already determines — the standing hold from the parity-attribution
  // correction, which left this seat outside the family check for want of a
  // declared family.
  out.seats.planner = { model: 'fable-5', family: 'claude', effort: 'low', fallback: 'opus-5', fallback_effort: 'high' };
  out.seats.convergence = { ...out.seats.convergence, family: 'claude', effort: 'low', fallback_effort: 'high' };

  out.review_routing = {
    claude: {
      recon: ['reviewer-gemini'],
      mechanical: ['reviewer-gemini'],
      standard: ['reviewer-gemini'],
      expert: ['reviewer-sol-expert-rev', 'reviewer-gemini'],
      apex: ['reviewer-sol-apex-rev', 'reviewer-gemini'],
    },
    gpt: {
      recon: ['reviewer-claude', 'reviewer-gemini'],
      mechanical: ['reviewer-claude', 'reviewer-gemini'],
      standard: ['reviewer-claude', 'reviewer-gemini'],
      expert: ['reviewer-claude-expert'],
      apex: ['reviewer-claude-apex'],
    },
    gemini: {
      recon: ['reviewer-claude'],
      mechanical: ['reviewer-claude'],
      standard: ['reviewer-claude'],
      expert: ['reviewer-claude-expert', 'reviewer-sol-expert-rev'],
      apex: ['reviewer-claude-apex', 'reviewer-sol-apex-rev'],
    },
  };
  out.review_qualification = {
    'reviewer-claude': 'standard',
    'reviewer-claude-expert': 'expert',
    'reviewer-claude-apex': 'apex',
    'reviewer-sol-expert-rev': 'expert',
    'reviewer-sol-apex-rev': 'apex',
    'reviewer-gemini': 'standard',
  };
  // Each degraded override is the intersection filter its mode applies to the
  // base rows, class by class: what survives with that lane out. The claude
  // standard rungs empty out under gemini_down because the gpt standard rung
  // does not exist yet — with no cross-family standard reviewer left, claude
  // standard work reaches the degraded path, which is the honest r4 answer to
  // design §6.2's "gpt only" row until r5 seats reviewer-terra there.
  out.degraded.codex_down.review_routing = {
    claude: {
      recon: ['reviewer-gemini'],
      mechanical: ['reviewer-gemini'],
      standard: ['reviewer-gemini'],
      expert: ['reviewer-gemini'],
      apex: ['reviewer-gemini'],
    },
    gpt: {
      recon: ['reviewer-claude', 'reviewer-gemini'],
      mechanical: ['reviewer-claude', 'reviewer-gemini'],
      standard: ['reviewer-claude', 'reviewer-gemini'],
      expert: ['reviewer-claude-expert'],
      apex: ['reviewer-claude-apex'],
    },
    gemini: {
      recon: ['reviewer-claude'],
      mechanical: ['reviewer-claude'],
      standard: ['reviewer-claude'],
      expert: ['reviewer-claude-expert'],
      apex: ['reviewer-claude-apex'],
    },
  };
  out.degraded.gemini_down.review_routing = {
    claude: {
      recon: [],
      mechanical: [],
      standard: [],
      expert: ['reviewer-sol-expert-rev'],
      apex: ['reviewer-sol-apex-rev'],
    },
    gpt: {
      recon: ['reviewer-claude'],
      mechanical: ['reviewer-claude'],
      standard: ['reviewer-claude'],
      expert: ['reviewer-claude-expert'],
      apex: ['reviewer-claude-apex'],
    },
    gemini: {
      recon: ['reviewer-claude'],
      mechanical: ['reviewer-claude'],
      standard: ['reviewer-claude'],
      expert: ['reviewer-claude-expert', 'reviewer-sol-expert-rev'],
      apex: ['reviewer-claude-apex', 'reviewer-sol-apex-rev'],
    },
  };

  out.revision = 4;
  return out;
}

// r4 -> r5: the GPT author ladder and its tiered hosts become data. The two
// remaining author rungs design §4.2 pins (executor-luna, executor-terra) and
// the gpt standard review rung §6.1 pins (reviewer-terra) join the seat table,
// each with the host profile §5 tiers for its worker — the host is the lowest
// that can faithfully dispatch that worker, so it rises with the worker rather
// than sitting at sonnet-high for everything. The gpt lane is operator-down
// today, so nothing here routes yet; dormant is a lane state, never an
// unfinished table, and re-enabling the lane is a settings write with no code
// change behind it.
//
// reviewer-terra takes the standard-and-below rung its qualification bound
// names, which is the row design §6.2 has always specified and r4 could only
// write as absence: claude-authored recon/mechanical/standard work leads with
// the gpt lane and falls to gemini behind it, and gemini-authored work of those
// classes gains the gpt lane behind the always-on claude floor. The expert and
// apex rows are unchanged — the Sol rungs already carry them.
//
// The degraded overrides stay what they have always been: the intersection each
// mode leaves behind. codex_down needs no edit at all — every seat this
// migration adds is a gpt seat, and the gpt lane being out is exactly what that
// table already removes — while gemini_down gains reviewer-terra wherever it
// survives, which finally fills the claude standard rows r4 had to leave empty
// (§6.2's "gpt only" row) for want of a gpt standard rung.
//
// The codex_down seat substitutions carry the new author rungs onto their
// same-class Claude counterparts, and reviewer-terra onto reviewer-claude. That
// last mapping is lawful ONLY as an explicit degraded-path transition (§8): for
// claude-authored work reviewFor drops a substitute landing in the author's own
// family and takes the relabeled degraded transition instead, so the mapping can
// never quietly relabel a same-family review as cross-family.
function migrateGptLadder(config) {
  const out = JSON.parse(JSON.stringify(config));
  // Same discipline as every migration before it (§11 — each entry is
  // independently testable): a wrong-shaped source is refused by name rather
  // than stamped forward. The r3->r4 output is what distinguishes a revision-4
  // shape — the tiered Claude review rungs and the class-keyed rows — and both
  // persist into r5, so this stays idempotent at its own boundary.
  for (const table of ['seats', 'review_routing', 'degraded']) {
    if (!isPlainObject(out[table])) {
      throw new Error(`r4->r5 migration: config has no ${table} table — not a revision-4 shape`);
    }
  }
  for (const required of ['reviewer-claude-expert', 'reviewer-claude-apex']) {
    if (!isPlainObject(out.seats[required])) {
      throw new Error(
        `r4->r5 migration: config has no seats["${required}"] — not a revision-4 shape (the r3->r4 Claude ladder has not been applied)`
      );
    }
  }
  if (!isClassKeyedRouting(out.review_routing)) {
    throw new Error(
      'r4->r5 migration: config has one flat review row per author family — not a revision-4 shape (the r3->r4 class-keyed ladders have not been applied)'
    );
  }
  if (!isPlainObject(out.review_qualification)) {
    throw new Error('r4->r5 migration: config has no review_qualification table — not a revision-4 shape');
  }

  // Host profiles are design §5's tier table verbatim; worker model and effort
  // are §4.2's and §6.1's. Every seat file mirrors these values, never the
  // other way around. reviewer-terra keeps `scope: 'scoped'` for the same
  // reason its Sol siblings do: diff-scoped review is a property of what the
  // seat means, not of the tier it sits at.
  Object.assign(out.seats, {
    'executor-luna': { model: 'gpt-5.6-luna', family: 'gpt', effort: 'low', host: 'sonnet-5', host_effort: 'low' },
    'executor-terra': { model: 'gpt-5.6-terra', family: 'gpt', effort: 'medium', host: 'sonnet-5', host_effort: 'medium' },
    'reviewer-terra': { model: 'gpt-5.6-terra', family: 'gpt', effort: 'high', host: 'sonnet-5', host_effort: 'medium', scope: 'scoped' },
  });

  // The three standard-and-below classes share one review rung (§6), so the
  // insertion is the same row edit three times: gpt lane first for claude
  // authors (§6.2's "reviewer-terra → reviewer-gemini"), gpt lane second for
  // gemini authors, behind the always-on claude floor. Insertion is
  // position-preserving and skips a row that already names the seat, which is
  // what keeps this migration idempotent at its own boundary (§11) — a second
  // application over its own output must add nothing, not a duplicate rung.
  const lead = (row) => (row.includes('reviewer-terra') ? row : ['reviewer-terra', ...row]);
  const trail = (row) => (row.includes('reviewer-terra') ? row : [...row, 'reviewer-terra']);
  for (const klass of ['recon', 'mechanical', 'standard']) {
    out.review_routing.claude[klass] = lead(out.review_routing.claude[klass]);
    out.review_routing.gemini[klass] = trail(out.review_routing.gemini[klass]);
    // With gemini out, the gpt rung is what survives of the claude row — the
    // row r4 had to leave empty until this seat existed — and it joins the
    // gemini-authored row behind the claude floor that already holds it.
    out.degraded.gemini_down.review_routing.claude[klass] = ['reviewer-terra'];
    out.degraded.gemini_down.review_routing.gemini[klass] = trail(out.degraded.gemini_down.review_routing.gemini[klass]);
  }
  // Standard-and-below by the same §6.1 rung that seats it there — the bound is
  // what keeps expert and apex work off this seat, exactly as gemini's does.
  out.review_qualification['reviewer-terra'] = 'standard';

  // Same-class substitutes: a downed gpt lane sends each author rung to the
  // Claude seat of its own class (§4.1/§4.2), never up or down a tier. The
  // reviewer mapping is the §8 degraded-path transition described above.
  Object.assign(out.degraded.codex_down.seats, {
    'executor-luna': 'executor-claude-mech',
    'executor-terra': 'executor-claude-standard',
    'reviewer-terra': 'reviewer-claude',
  });

  out.revision = 5;
  return out;
}

// r5 -> r6: the author ladders become data. Until now the config could say who
// reviews a class but not who writes it, so the author pick was liaison
// judgment against a prose table. The tiers block is design §12 verbatim: a
// preference-ordered candidate array per task class, ordered over whole-topology
// cost (host included), every placement `estimated` because none of it has been
// measured yet.
//
// Three rules the design states, and which this revision carries structurally
// rather than by convention:
//
//   - No `plan_seat`, anywhere in the block (§9). Planning topology is a
//     separate resolution from implementation class, and a planning seat living
//     inside the implementation ladder is how the two silently merge.
//   - `escalation: true` entries are never reached by a fresh resolution (§10):
//     the expert escalation rung takes over work that already defeated the
//     ordinary rung, so a first dispatch that could select it would spend the
//     mission's one profile escalation before anything had failed.
//   - Alias seats are unroutable, here as everywhere: an alias exists so an old
//     name keeps validating across a migration, and routing one would dodge the
//     profile split it records.
//
// The block names seats from every revision this migration stands on — scout
// and executor-claude/executor-gemini from r1, the Sol rungs from r2, the
// tiered Claude rungs from r4, luna and terra from r5 — and validation refuses
// a candidate the seat table does not carry, so the ladder can never name a
// seat nothing can dispatch. With the gpt lane operator-down today the luna,
// terra and sol candidates are skipped by §11.2 out of this same data, and the
// claude/gemini tree falls out of it; there is no second mechanism.
function migrateTiersBlock(config) {
  const out = JSON.parse(JSON.stringify(config));
  // Same discipline as every migration before it (§11 — each entry is
  // independently testable): a wrong-shaped source is refused by name rather
  // than stamped forward. The r4->r5 output is what distinguishes a revision-5
  // shape, and those seats persist into r6, so this stays idempotent at its own
  // boundary — re-running it rewrites the same block and relabels the same
  // revision.
  for (const table of ['seats', 'review_routing', 'degraded']) {
    if (!isPlainObject(out[table])) {
      throw new Error(`r5->r6 migration: config has no ${table} table — not a revision-5 shape`);
    }
  }
  for (const required of ['executor-luna', 'executor-terra', 'reviewer-terra']) {
    if (!isPlainObject(out.seats[required])) {
      throw new Error(
        `r5->r6 migration: config has no seats["${required}"] — not a revision-5 shape (the r4->r5 GPT ladder has not been applied)`
      );
    }
  }

  out.tiers = {
    policy: 'tiered-dispatch-v2',
    calibrated: '2026-08-06',
    status: 'estimated',
    classes: {
      recon: { candidates: [{ seat: 'scout', status: 'estimated' }] },
      mechanical: {
        candidates: [
          { seat: 'executor-luna', status: 'estimated' },
          { seat: 'executor-claude-mech', status: 'estimated' },
        ],
      },
      standard: {
        candidates: [
          { seat: 'executor-terra', status: 'estimated' },
          { seat: 'executor-claude-standard', status: 'estimated' },
          { seat: 'executor-gemini', status: 'estimated' },
        ],
      },
      expert: {
        candidates: [
          { seat: 'executor-sol-expert', status: 'estimated' },
          { seat: 'executor-claude', status: 'estimated' },
          { seat: 'executor-fable-low', status: 'estimated', escalation: true },
        ],
      },
      apex: {
        candidates: [
          { seat: 'executor-fable', status: 'estimated' },
          { seat: 'executor-sol-apex', status: 'estimated' },
          { seat: 'executor-claude', status: 'estimated' },
        ],
      },
    },
  };

  out.revision = 6;
  return out;
}

// r6 -> r7: battery finding D9 — executor-gemini and reviewer-gemini declare
// a host pair but no worker-level `effort`, so every bundle routing.js
// resolves off them (reviewFor's cross-family and degraded-path reads,
// tier-for's author-side seat lookup) carries `effort: null` straight into
// route.js's non-empty-string requirement, refusing route reservation for
// the live default resolution (claude-authored standard work, reviewed by
// reviewer-gemini). A seat-table fix that lived only in buildRevision1Config
// would reach a freshly initialized tree and nothing already materialized —
// the live project tree's on-disk revision-1 config is exactly such a tree —
// so the fix ships as a migration instead, the mechanism `revise()` actually
// walks.
//
// Declared, not probed: no discovery surface in this repository, or in
// either front end's own --help, exposes a per-model thinking/effort dial
// for this family on this machine (preflight.js's model map stays 'unknown'
// with no proven efforts by design — `gemini --help` names no thinking flag,
// and antigravity is not installed here to check at all). 'high' is
// declared from the Gemini API's documented thinking_level vocabulary for
// the gemini-3.x family (`"low" | "high"`), matching each seat's own
// host_effort/job description — the same tri-state honesty preflight.js's
// 'unknown' stays unknown extends to a value nothing on this machine can
// verify.
function migrateGeminiEffort(config) {
  const out = JSON.parse(JSON.stringify(config));
  if (!isPlainObject(out.seats) || !isPlainObject(out.tiers)) {
    throw new Error('r6->r7 migration: config has no seats/tiers table — not a revision-6 shape');
  }
  for (const required of ['executor-gemini', 'reviewer-gemini']) {
    if (!isPlainObject(out.seats[required])) {
      throw new Error(`r6->r7 migration: config has no seats["${required}"] — not a revision-6 shape`);
    }
  }
  out.seats['executor-gemini'] = { ...out.seats['executor-gemini'], effort: 'high' };
  out.seats['reviewer-gemini'] = { ...out.seats['reviewer-gemini'], effort: 'high' };
  out.revision = 7;
  return out;
}

const MIGRATIONS = [migrateSolSplit, migrateDegradedReview, migrateClaudeLadder, migrateGptLadder, migrateTiersBlock, migrateGeminiEffort];

// The revision of the highest migration actually shipped — each slice that
// pushes a MIGRATIONS entry raises this in the same commit, by construction.
// The mission's end state is revision 6; pinning that number early would
// stamp init'd trees above their content and freeze them out of every later
// migration (the already-current no-op would fire forever).
const CURRENT_ROUTING_REVISION = 1 + MIGRATIONS.length;

// The current schema is the revision-1 baseline pushed through every
// shipped migration — init derives it rather than hand-maintaining a second
// table, so a fresh tree carries exactly the content its revision label
// claims and migrated trees can never diverge from init'd ones.
function buildDefaultConfig(dateStr) {
  let config = buildRevision1Config(dateStr);
  for (const migrate of MIGRATIONS) {
    config = migrate(config);
  }
  return config;
}

// --- read boundary -----------------------------------------------------------

// True of a review-routing table whose rows are class-keyed ladders (r4+)
// rather than one flat list per author family (r1..r3). Asked of the base
// table once per config and then imposed on every degraded override, because
// composition intersects the two: a config mixing the shapes would compose a
// row against something that is not one.
function isClassKeyedRouting(table) {
  return isPlainObject(table) && FAMILIES.some((family) => isPlainObject(table[family]));
}

// The reviewer ladder a resolution reads: the family's flat row before r4, the
// family's row for this task class from r4 on.
function reviewRowOf(table, family, taskClass) {
  const entry = table[family];
  return Array.isArray(entry) ? entry : entry[taskClass];
}

function checkReviewRouting(table, label, seats, degradedRowSeats, qualification, classKeyed, errors) {
  if (!isPlainObject(table)) {
    errors.push(`${label} must be an object`);
    return;
  }
  for (const family of FAMILIES) {
    if (!classKeyed) {
      checkReviewRow(table[family], `${label}.${family}`, family, seats, degradedRowSeats, qualification, errors);
      continue;
    }
    const rows = table[family];
    if (!isPlainObject(rows)) {
      errors.push(`${label}.${family} must be an object mapping each task class to its reviewer ladder`);
      continue;
    }
    for (const key of Object.keys(rows)) {
      if (!BRIEF_TIER_VALUES.has(key)) {
        errors.push(`${label}.${family}.${key} is not a known task class (${[...BRIEF_TIER_VALUES].join(', ')})`);
      }
    }
    for (const klass of BRIEF_TIER_VALUES) {
      checkReviewRow(rows[klass], `${label}.${family}.${klass}`, family, seats, degradedRowSeats, qualification, errors);
    }
  }
}

// One row — flat or class-keyed — against every rule a routed reviewer row
// carries. `family` is the author family the row answers for, which is what
// the no-laundering shape check compares against.
function checkReviewRow(list, label, family, seats, degradedRowSeats, qualification, errors) {
  if (!Array.isArray(list) || list.some((s) => typeof s !== 'string' || s === '')) {
    errors.push(`${label} must be an array of seat-name strings`);
    return;
  }
  for (const seatName of list) {
    if (!Object.prototype.hasOwnProperty.call(seats, seatName)) {
      errors.push(`${label} names unknown seat "${seatName}"`);
      continue;
    }
    const seat = seats[seatName];
    if (isPlainObject(seat) && 'alias_of' in seat) {
      // Alias seats exist only so old names keep resolving across a
      // migration — routing a review to one would dodge the profile split.
      errors.push(`${label} names alias seat "${seatName}", which is never routable`);
      continue;
    }
    // Cross-family rows carry the laundering invariant in their shape:
    // no row ever names the author family's own seat, none names a seat
    // whose family is undeclared (the invariant compares families and
    // refuses what it cannot establish), and no row ever names a
    // degraded seat — the degraded path is only ever reached as an
    // explicit, relabeled transition, never as a table entry.
    if (!isPlainObject(seat) || typeof seat.family !== 'string' || seat.family === '') {
      errors.push(`${label} names seat "${seatName}", which declares no family — a routed reviewer seat without one fails the no-laundering invariant open`);
    } else if (seat.family === family) {
      errors.push(`${label} names seat "${seatName}" of the author's own family "${family}"`);
    }
    // Membership in this config's own degraded_review.rows is
    // self-referential (a config could name a degraded seat here and
    // omit it from rows), so the reserved reviewer-degraded-* namespace
    // is refused by name as well.
    if (degradedRowSeats.has(seatName) || seatName.startsWith('reviewer-degraded-')) {
      errors.push(`${label} names degraded reviewer seat "${seatName}", which never appears in a cross-family row`);
    }
    // Where the config carries the qualification table (r3+), every seat
    // a row can route must carry a bound — an unbounded routed reviewer
    // would fail the review-floor ban open at resolution time.
    if (qualification !== null && !Object.prototype.hasOwnProperty.call(qualification, seatName)) {
      errors.push(`${label} names seat "${seatName}" with no review_qualification entry — a routed reviewer without a qualification bound would fail the review-floor ban open`);
    }
  }
}

// The degraded_review block (revision 3+) is a closed shape: two verbatim
// notices and the tier-scaled author-model→seat rows, one row per class in
// the closed vocabulary, apex included. There is deliberately no ceiling
// field to validate — a config that carries one is refused as an unknown
// field, so "no class ever holds by default" is enforced structurally.
function checkDegradedReviewBlock(block, seats, errors) {
  if (!isPlainObject(block)) {
    errors.push('degraded_review must be an object');
    return;
  }
  for (const key of Object.keys(block)) {
    if (key !== 'notice' && key !== 'fallback_notice' && key !== 'rows') {
      errors.push(`degraded_review.${key} is not a permitted field — the block carries notice, fallback_notice, and rows only (no ceiling field exists)`);
    }
  }
  // The design (§8) calls both notices verbatim and several copies of the
  // text ship; dated configs are digest-pinned, but revise validates
  // arbitrary source configs, so a hand-shaped divergence is refused here
  // rather than allowed to relabel what a degraded review claims. If a
  // later migration ever revises the design's text, this pin must become
  // revision-keyed in that same commit — already-written dated configs
  // were legal at their own revision, and rollback to them must stay
  // loadable.
  for (const [field, verbatim] of [
    ['notice', DEGRADED_REVIEW_NOTICE],
    ['fallback_notice', DEGRADED_REVIEW_FALLBACK_NOTICE],
  ]) {
    if (block[field] !== verbatim) {
      errors.push(`degraded_review.${field} must be the design's verbatim degraded-path notice text — diverging copies are refused`);
    }
  }
  if (!isPlainObject(block.rows)) {
    errors.push('degraded_review.rows must be an object');
    return;
  }
  for (const klass of BRIEF_TIER_VALUES) {
    if (!isPlainObject(block.rows[klass]) || Object.keys(block.rows[klass]).length === 0) {
      errors.push(`degraded_review.rows.${klass} must map at least one author model to a degraded reviewer seat — the degraded path is tier-scaled through every class, with no ceiling`);
    }
  }
  for (const [klass, row] of Object.entries(block.rows)) {
    if (!BRIEF_TIER_VALUES.has(klass)) {
      errors.push(`degraded_review.rows.${klass} is not a known task class (${[...BRIEF_TIER_VALUES].join(', ')})`);
      continue;
    }
    if (!isPlainObject(row)) continue; // already reported above
    for (const [authorModel, seatName] of Object.entries(row)) {
      if (typeof seatName !== 'string' || !Object.prototype.hasOwnProperty.call(seats, seatName)) {
        errors.push(`degraded_review.rows.${klass} maps "${authorModel}" to unknown seat "${seatName}"`);
        continue;
      }
      const seat = seats[seatName];
      if (isPlainObject(seat) && 'alias_of' in seat) {
        errors.push(`degraded_review.rows.${klass} maps "${authorModel}" to alias seat "${seatName}", which is never routable`);
      } else if (isPlainObject(seat) && seat.family !== 'claude') {
        errors.push(`degraded_review.rows.${klass} maps "${authorModel}" to "${seatName}" of family "${seat.family}" — the degraded path is a fresh-context Claude reviewer by definition`);
      }
    }
  }
}

// The tiers block (revision 6+) is a closed shape, for the same reason the
// degraded_review block is: the fields it does NOT carry are as load-bearing as
// the ones it does. `plan_seat` is refused by name at both levels it could
// appear, because design §9 keeps planning topology out of the implementation
// ladder and an unknown-field error would leave a reader guessing which rule
// they hit. Every candidate names a real, non-alias seat and carries a status,
// so a ladder can never offer a seat nothing can dispatch or a placement whose
// confidence is unstated; `escalation` is optional and boolean, and its absence
// means an ordinary rung.
const TIERS_KEYS = ['policy', 'calibrated', 'status', 'classes'];
const TIERS_CANDIDATE_KEYS = ['seat', 'status', 'escalation'];

function checkTiersBlock(block, seats, errors) {
  if (!isPlainObject(block)) {
    errors.push('tiers must be an object');
    return;
  }
  for (const key of Object.keys(block)) {
    if (key === 'plan_seat') {
      errors.push('tiers.plan_seat is refused — planning topology is resolved separately from implementation class, and tiers carries no planning seat');
    } else if (!TIERS_KEYS.includes(key)) {
      errors.push(`tiers.${key} is not a permitted field — the block carries ${TIERS_KEYS.join(', ')} only`);
    }
  }
  for (const field of ['policy', 'calibrated', 'status']) {
    if (typeof block[field] !== 'string' || block[field] === '') {
      errors.push(`tiers.${field} must be a non-empty string`);
    }
  }
  if (!isPlainObject(block.classes)) {
    errors.push('tiers.classes must be an object mapping each task class to its candidate ladder');
    return;
  }
  for (const key of Object.keys(block.classes)) {
    if (!BRIEF_TIER_VALUES.has(key)) {
      errors.push(`tiers.classes.${key} is not a known task class (${[...BRIEF_TIER_VALUES].join(', ')})`);
    }
  }
  for (const className of BRIEF_TIER_VALUES) {
    const klass = block.classes[className];
    if (!isPlainObject(klass)) {
      errors.push(`tiers.classes.${className} must be an object { candidates }`);
      continue;
    }
    for (const key of Object.keys(klass)) {
      if (key === 'plan_seat') {
        errors.push(`tiers.classes.${className}.plan_seat is refused — planning topology is resolved separately from implementation class`);
      } else if (key !== 'candidates') {
        errors.push(`tiers.classes.${className}.${key} is not a permitted field — a class carries candidates only`);
      }
    }
    if (!Array.isArray(klass.candidates) || klass.candidates.length === 0) {
      errors.push(`tiers.classes.${className}.candidates must be a non-empty array of { seat, status } entries`);
      continue;
    }
    const named = new Set();
    klass.candidates.forEach((candidate, i) => {
      const at = `tiers.classes.${className}.candidates[${i}]`;
      if (!isPlainObject(candidate)) {
        errors.push(`${at} must be an object { seat, status }`);
        return;
      }
      for (const key of Object.keys(candidate)) {
        if (!TIERS_CANDIDATE_KEYS.includes(key)) {
          errors.push(`${at}.${key} is not a permitted field — a candidate carries ${TIERS_CANDIDATE_KEYS.join(', ')} only`);
        }
      }
      if (typeof candidate.seat !== 'string' || candidate.seat === '') {
        errors.push(`${at}.seat must be a non-empty seat-name string`);
      } else if (!Object.prototype.hasOwnProperty.call(seats, candidate.seat)) {
        errors.push(`${at} names unknown seat "${candidate.seat}"`);
      } else if (isPlainObject(seats[candidate.seat]) && 'alias_of' in seats[candidate.seat]) {
        // Message kept as it was when this was the block's only check: an
        // alias in a candidate array is the same defect as an alias in a
        // review row, and the same sentence should name it.
        errors.push(`tiers.classes.${className} names alias seat "${candidate.seat}", which is never routable`);
      } else if (named.has(candidate.seat)) {
        errors.push(`tiers.classes.${className} names seat "${candidate.seat}" twice — a ladder rung is reached once or not at all`);
      }
      if (typeof candidate.seat === 'string') named.add(candidate.seat);
      if (typeof candidate.status !== 'string' || candidate.status === '') {
        errors.push(`${at}.status must be a non-empty string — every placement states its confidence`);
      }
      if ('escalation' in candidate && typeof candidate.escalation !== 'boolean') {
        errors.push(`${at}.escalation must be a boolean when present`);
      }
    });
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
  // itself an alias, so alias resolution is always a single hop. No read
  // path resolves an alias — a stored name that turns out to be one gets
  // refusal-by-absence, deliberately, since aliases exist only so old
  // configs keep validating across a migration.
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
  // Collected before any row check runs, so every review row — base or
  // degraded-mode override — is held to "never names a degraded seat".
  const degradedRowSeats = new Set();
  if (isPlainObject(config.degraded_review) && isPlainObject(config.degraded_review.rows)) {
    for (const row of Object.values(config.degraded_review.rows)) {
      if (!isPlainObject(row)) continue;
      for (const seatName of Object.values(row)) {
        if (typeof seatName === 'string') degradedRowSeats.add(seatName);
      }
    }
  }
  // degraded_review and review_qualification arrive together in the r2->r3
  // migration and are one contract — what the degraded path is, and when a
  // cross-family candidate must yield to it. Configs at earlier revisions
  // (including rolled-back ones) carry neither and stay valid; a config
  // carrying one without the other is hand-shaped and refused, so neither
  // fence can be stripped alone.
  const hasDegradedReview = Object.prototype.hasOwnProperty.call(config, 'degraded_review');
  const hasQualification = Object.prototype.hasOwnProperty.call(config, 'review_qualification');
  if (hasDegradedReview !== hasQualification) {
    errors.push('degraded_review and review_qualification arrive together in the r2->r3 migration — a config carrying one without the other is refused');
  }
  let qualification = null;
  if (hasQualification) {
    if (!isPlainObject(config.review_qualification)) {
      errors.push('review_qualification must be an object mapping reviewer seats to the highest class each may review');
    } else {
      qualification = config.review_qualification;
      for (const [seatName, bound] of Object.entries(qualification)) {
        if (!Object.prototype.hasOwnProperty.call(seats, seatName)) {
          errors.push(`review_qualification names unknown seat "${seatName}"`);
        } else if (isPlainObject(seats[seatName]) && 'alias_of' in seats[seatName]) {
          errors.push(`review_qualification names alias seat "${seatName}", which is never routable`);
        }
        if (!BRIEF_TIER_VALUES.has(bound)) {
          errors.push(`review_qualification.${seatName} must be one of ${[...BRIEF_TIER_VALUES].join(', ')} (got ${JSON.stringify(bound)})`);
        }
      }
    }
  }
  // One shape decides the whole config: the base table's own form is imposed
  // on every degraded override below, so a table half-migrated to class-keyed
  // rows is refused rather than composed against a row of the other kind.
  const classKeyed = isClassKeyedRouting(config.review_routing);
  checkReviewRouting(config.review_routing, 'review_routing', seats, degradedRowSeats, qualification, classKeyed, errors);
  if (hasDegradedReview) {
    checkDegradedReviewBlock(config.degraded_review, seats, errors);
  }
  // The tiers block arrives with r6; configs at earlier revisions (including
  // rolled-back ones) carry none and stay valid.
  if (Object.prototype.hasOwnProperty.call(config, 'tiers')) {
    checkTiersBlock(config.tiers, seats, errors);
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
          } else if (isPlainObject(seats[to]) && 'alias_of' in seats[to]) {
            // A substitution landing on an alias is routing an alias by a
            // different door — a live seat would resolve onto a seat that
            // is itself never routable.
            errors.push(`degraded.${modeName}.seats maps "${from}" to alias seat "${to}", which is never routable`);
          }
        }
      }
      // Preflight-driven modes feed composeReviewRouting, so their
      // review_routing override is mandatory; any other degraded table
      // that carries one is checked to the same standard — a hand-shaped
      // degraded table is a read-boundary risk like any other.
      const preflightDriven = PROVIDER_MODES.some(([, name]) => name === modeName);
      if (preflightDriven || Object.prototype.hasOwnProperty.call(table, 'review_routing')) {
        checkReviewRouting(
          table.review_routing,
          `degraded.${modeName}.review_routing`,
          seats,
          degradedRowSeats,
          qualification,
          classKeyed,
          errors
        );
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
  return { config, activeFile, digest: actualDigest };
}

// --- degraded-mode composition -----------------------------------------------

function readPreflight(treeRoot) {
  const capability = { gpt: null, gemini: null };
  const state = readJson(path.join(treeRoot, STATE_BASENAME), null);
  if (!isPlainObject(state) || !isPlainObject(state.preflight)) {
    return { recorded: false, modes: [], capability };
  }
  const perProvider = isPlainObject(state.preflight.per_provider) ? state.preflight.per_provider : {};
  const modes = [];
  for (const [provider, modeName, lane] of PROVIDER_MODES) {
    const entry = perProvider[provider];
    // Routing token discipline: only an explicit "present" keeps the
    // provider up; absent, unknown, or an unrecorded provider all route as
    // down within a recorded preflight.
    const routingToken = isPlainObject(entry) ? entry.routing : undefined;
    if (routingToken !== 'present') {
      modes.push(modeName);
    }
    // Exact model × effort capability, where preflight recorded one. Absence
    // of a models map is not a claim in either direction — only a recorded
    // entry ever excludes a candidate.
    if (isPlainObject(entry) && isPlainObject(entry.models)) {
      capability[lane] = entry.models;
    }
  }
  return { recorded: true, modes, capability };
}

// The operator lane state and the degraded-review posture, in ONE settings
// read (two reads would let a settings write between them mix two snapshots
// into one legality decision), through settings' own clamped read boundary —
// never a hand parse of settings.json. Both knobs are settings SCHEMA keys
// (Slice 3a), so they survive sanctioned writes of unrelated knobs and the
// clamped read always carries them. Both are consumed conservatively — only
// the exact tokens "operator-down" and "hold" ever change behaviour, so a
// malformed hand-edit degrades nothing and holds nothing, same as a fresh
// tree.
function readOperatorSettings(treeRoot) {
  const { settings } = readSettings(treeRoot);
  return {
    lanes: isPlainObject(settings.provider_lanes) ? settings.provider_lanes : {},
    // The hold posture is operator-selectable and never the default:
    // anything but an explicit "hold" resolves the degraded path.
    posture: settings.degraded_review === 'hold' ? 'hold' : 'degraded-path',
  };
}

// Named for what it is: an operator toggle, not a probe failure — the
// reason a reader of this notice can tell why the lane is out.
function operatorDownNotice(lane) {
  return (
    `The ${lane} lane is operator-down (settings provider_lanes.${lane} = "operator-down") — an operator ` +
    'toggle, not a probe failure: its seats are excluded from routing and run on their recorded degraded ' +
    'substitutes until the operator re-enables the lane.'
  );
}

// Effective review routing under the active degraded modes: each row survives
// filtered through every active mode's override, order preserved, and the
// composed table keeps whatever shape the config's own rows have — flat per
// family before r4, class-keyed from r4 on. With both providers down the
// claude rows go empty, which review-for answers with the explicit
// degraded-path transition, relabeled and notice-carrying, never a
// cross-family claim scaled down.
function composeReviewRouting(config, modes) {
  const classKeyed = isClassKeyedRouting(config.review_routing);
  const compose = (family, taskClass) => {
    let list = reviewRowOf(config.review_routing, family, taskClass);
    for (const modeName of modes) {
      const override = reviewRowOf(config.degraded[modeName].review_routing, family, taskClass);
      list = list.filter((seat) => override.includes(seat));
    }
    return list;
  };
  const effective = {};
  for (const family of FAMILIES) {
    if (!classKeyed) {
      effective[family] = compose(family, undefined);
      continue;
    }
    const rows = {};
    for (const klass of CLASS_ORDER) {
      rows[klass] = compose(family, klass);
    }
    effective[family] = rows;
  }
  return effective;
}

function effectiveRouting(treeRoot) {
  const { config, activeFile, digest } = loadRouting(treeRoot);
  const { recorded, modes: preflightModes, capability } = readPreflight(treeRoot);
  const { lanes, posture } = readOperatorSettings(treeRoot);
  // Effective = preflight present AND NOT operator-down: either cause
  // activates the same degraded table through the same composition — an
  // operator-down lane is never a parallel path. Each cause contributes its
  // own notice, so with both holding at once neither fact is hidden.
  const modes = [];
  const notices = [];
  for (const [, modeName, lane] of PROVIDER_MODES) {
    const probeDown = preflightModes.includes(modeName);
    const operatorDown = lanes[lane] === 'operator-down';
    if (!probeDown && !operatorDown) continue;
    modes.push(modeName);
    if (probeDown) notices.push(config.degraded[modeName].notice);
    if (operatorDown) notices.push(operatorDownNotice(lane));
  }
  const substitutions = {};
  for (const modeName of modes) {
    Object.assign(substitutions, config.degraded[modeName].seats);
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
    active_digest: digest,
    revision: config.revision,
    calibrated: config.calibrated,
    preflight_recorded: recorded,
    provider_lanes: {
      gpt: lanes.gpt === 'operator-down' ? 'operator-down' : 'auto',
      gemini: lanes.gemini === 'operator-down' ? 'operator-down' : 'auto',
    },
    degraded_modes: modes,
    notices,
    seats: config.seats,
    seat_substitutions: substitutions,
    review_routing: composeReviewRouting(config, modes),
    bans: config.bans,
    degraded_review: isPlainObject(config.degraded_review) ? config.degraded_review : null,
    review_qualification: isPlainObject(config.review_qualification) ? config.review_qualification : null,
    capability,
    // The author ladders (r6+), uncomposed on purpose: a degraded mode never
    // rewrites the tiers block the way it overrides a review row. Which rungs a
    // lane state costs this class is a per-resolution fact, recorded as skips by
    // the resolver rather than filtered away here — the ladder a reader sees is
    // always the whole ladder.
    tiers: isPlainObject(config.tiers) ? config.tiers : null,
    base_review_routing: config.review_routing,
    // Read in the same settings snapshot as provider_lanes, so one
    // resolution never mixes two settings states. Internal, like
    // base_review_routing — the CLI strips it from printed output.
    degraded_review_posture: posture,
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

// Best-effort removal of a temp only this writer can name — it never races
// another writer. Returns the basenames it could not remove, so a caller
// that is already reporting orphans can name them too.
function removeTempFile(tmpPath) {
  try {
    fs.rmSync(tmpPath, { force: true });
    return [];
  } catch (err) {
    return [path.basename(tmpPath)];
  }
}

// Writes a dated config at the first free routing-YYYY-MM-DD-N.json name
// for the day. The bytes land in an unpredictable dot-prefixed temp first
// and the dated name is claimed with linkSync, which is both atomic and
// EEXIST-exclusive: immutability rests on the filesystem, not on a
// check-then-write, and a concurrent writer that picked the same N loses
// with EEXIST and moves to the next. Creating the file at its final name
// and writing into it would claim the name just as exclusively but would
// leave a truncated file permanently occupying an immutable name whenever
// the write failed; linking a fully written temp means a dated name only
// ever appears complete, and a failed write consumes no dated name at all.
// Byte format matches atomic-json's writeJson exactly, so equal content
// always hashes to an equal digest regardless of which path wrote it.
// Rollback/re-upgrade cycles therefore accumulate byte-identical dated
// files under successive N — the growth immutability demands, by design.
function writeDatedConfigExclusive(dir, dateStr, value) {
  const serialized = JSON.stringify(value, null, 2) + '\n';
  const tmpPath = path.join(
    dir,
    `.routing-${dateStr}.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`
  );
  let claimed = null;
  try {
    const fd = fs.openSync(tmpPath, 'wx');
    try {
      fs.writeSync(fd, serialized);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    for (let n = 1; claimed === null; n++) {
      const filename = `routing-${dateStr}-${n}.json`;
      const configPath = path.join(dir, filename);
      try {
        fs.linkSync(tmpPath, configPath);
        claimed = { filename, configPath };
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
      }
    }
  } catch (err) {
    // Nothing was linked, so the temp is unreachable except through this
    // name. If even removing it fails it is a genuine leftover, and the
    // orphan report has to say so rather than let it drop off the record.
    err.orphanFiles = removeTempFile(tmpPath);
    throw err;
  }
  // The dated name now holds these exact bytes; the temp is a second link
  // to them that nothing else refers to.
  removeTempFile(tmpPath);
  return claimed;
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
      const { filename, configPath } = writeDatedConfigExclusive(dir, dateStr, next);
      // Digest from the exact bytes on disk, same discipline as init: the
      // pointer will certify the file as-written, not the in-memory value.
      const digest = sha256Of(fs.readFileSync(configPath));
      steps.push({ file: filename, revision: revision + 1, digest });
      current = next;
      revision += 1;
    }
  } catch (err) {
    // Dated files already written, plus anything a failed write could not
    // clean up — §11 requires the orphan report to name whatever survives.
    const orphans = steps.map((s) => s.file).concat(err.orphanFiles || []);
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
  try {
    writeJson(path.join(dir, ACTIVE_BASENAME), {
      schema_version: SCHEMA_VERSION,
      active_config: last.file,
      digest: last.digest,
    });
  } catch (err) {
    // A failed repoint leaves the old pointer intact — the invariant holds —
    // but the dated files already written deserve the same orphan report a
    // mid-loop failure produces.
    throw new Error(
      `routing: revise migrated to revision ${last.revision} but repointing ${ACTIVE_BASENAME} failed: ${err.message} — ` +
        `active.json still points at "${activeFile}", which stays authoritative; orphan dated file(s) written but never ` +
        `activated: ${steps.map((s) => s.file).join(', ')}`
    );
  }
  return {
    from,
    to: last.revision,
    current: last.revision === CURRENT_ROUTING_REVISION,
    steps,
    active_config: last.file,
    digest: last.digest,
  };
}

// The no-laundering invariant, checked after every substitution and every
// fallback re-check — never once at the end: a resolution claiming
// cross-family independence with a reviewer of the author's own family is
// refused outright. A same-family reviewer is lawful only under the
// explicit degraded-path label.
function refuseLaundering(independence, reviewerFamily, authorFamily) {
  // A guard that cannot establish the fact it guards has not established
  // it: a reviewer seat with no declared family must refuse, never fail
  // open through `undefined !== authorFamily`.
  if (independence === 'cross-family' && (typeof reviewerFamily !== 'string' || reviewerFamily === '')) {
    throw new Error(
      'routing: resolved reviewer seat declares no family while claiming cross-family independence — the ' +
        'no-laundering invariant compares author and reviewer families and refuses what it cannot establish'
    );
  }
  if (independence === 'cross-family' && reviewerFamily === authorFamily) {
    throw new Error(
      `routing: resolved reviewer family "${reviewerFamily}" equals the author family while claiming ` +
        'cross-family independence — family laundering is refused; a same-family reviewer is lawful only ' +
        'as an explicit degraded-path transition, relabeled accordingly'
    );
  }
}

// The closed class vocabulary in ascending capability order — its own
// declaration order in validators.js. A qualification bound names the
// highest class a reviewer seat may review; recon and mechanical share
// standard-review (design §6), so a "standard" bound covers all three.
const CLASS_ORDER = [...BRIEF_TIER_VALUES];

// True only when the bound is a known class at or above the task class: an
// absent or malformed bound is never rounded up, so a seat the table does
// not cover fails closed out of the cross-family path.
function classWithinBound(taskClass, bound) {
  return CLASS_ORDER.indexOf(taskClass) <= CLASS_ORDER.indexOf(bound);
}

// Design §11.1: exact model × effort capability, never guessed from a model
// name. Where preflight wrote a models map for a candidate's provider, that
// map is the claim, and the candidate is usable only if the map RECORDS it
// usable: the model tracked and "present" (unknown routes as unavailable and
// is never rounded up), and the seat's exact effort among the efforts
// recorded for it. A model the map does not name, and an entry with no
// recorded efforts, are both things the map does not record — skipped, not
// guessed up, which is the same discipline that keeps `unknown` from being
// rounded to `present`.
//
// The one thing that is not a claim in either direction is the absence of the
// map itself: a provider preflight never probed has been measured in no
// direction at all, and lane state — not this function — is what decides
// whether such a lane routes. Claude seats never enter here: Claude is the
// runtime, and no probe represents it.
function capabilityUnavailable(seat, capability) {
  if (typeof seat.model !== 'string') return false;
  const models = capability[seat.family];
  if (!isPlainObject(models)) return false;
  const entry = models[seat.model];
  if (!isPlainObject(entry)) return true;
  if (entry.status !== 'present') return true;
  return typeof seat.effort === 'string' && !(Array.isArray(entry.efforts) && entry.efforts.includes(seat.effort));
}

// Author-aware, class-aware reviewer resolution (execution-plan.md §8): read
// the author family, enumerate the class candidates, drop the
// lane-or-capability-unavailable, drop the author's own effective family,
// take the first remaining cross-family candidate, and otherwise fall to
// the explicit degraded path, tier-scaled through every class including
// apex — or throw for an operator-requested hold. Returns a bundle carrying
// independence "cross-family" or "degraded-path"; nothing in between.
//
// authorModel is optional and only consulted on the degraded path, where
// the class row pairs reviewers by author model (the apex row carries the
// full heavy-model pairing). Omitted, the row's first pairing — the class's
// canonical authorship — is used, and the bundle's author_model names the
// key actually applied so the selection is never silent.
function reviewFor(treeRoot, authorFamily, taskClass, authorModel) {
  if (!FAMILIES.includes(authorFamily)) {
    throw new Error(`routing: author family must be one of ${FAMILIES.join(', ')} (got "${authorFamily}")`);
  }
  if (!BRIEF_TIER_VALUES.has(taskClass)) {
    throw new Error(
      `routing: task class must be one of ${[...BRIEF_TIER_VALUES].join(', ')} (got ${JSON.stringify(taskClass)})`
    );
  }
  if (authorModel !== undefined && (typeof authorModel !== 'string' || authorModel === '')) {
    throw new Error('routing: author model, when given, must be a non-empty model-name string');
  }

  const effective = effectiveRouting(treeRoot);
  const seats = effective.seats;
  const subs = effective.seat_substitutions;
  const base = reviewRowOf(effective.base_review_routing, authorFamily, taskClass);
  const classRow = reviewRowOf(effective.review_routing, authorFamily, taskClass);

  // Availability skips, in the route record's own vocabulary (route.js
  // SKIP_REASONS): a candidate this class's base ladder named and that could
  // not be tried because its lane is out or the capability map does not record
  // it. Recorded from the BASE row, since the effective row is where the
  // lane-out candidates have already been filtered away — a resolution taken
  // with a lane down has to be able to say which rungs that cost it, and a
  // skipped seat is the opposite of a requested one: route.js refuses a route
  // whose requested seat also appears here.
  //
  // Deliberately only these two: a candidate dropped for sharing the author's
  // family, or for a qualification bound below the class, was available and
  // refused by law. Those are not availability facts, they have no reason token
  // in the closed enum, and recording them there would report a live lane as
  // absent.
  const candidatesSkipped = [];
  for (const candidate of base) {
    if (!classRow.includes(candidate)) {
      candidatesSkipped.push({ seat: candidate, reason: 'lane-down' });
      continue;
    }
    const resolved = Object.prototype.hasOwnProperty.call(subs, candidate) ? subs[candidate] : candidate;
    const seat = seats[resolved];
    if (isPlainObject(seat) && capabilityUnavailable(seat, effective.capability)) {
      candidatesSkipped.push({ seat: candidate, reason: 'capability-absent' });
    }
  }

  const shared = {
    class: taskClass,
    routing_config: effective.active_config,
    routing_digest: effective.active_digest,
    candidates_skipped: candidatesSkipped,
    // Design §16.2's profile-outcome vocabulary, on both paths. A resolution
    // is a request and nothing more — no dispatch has run, so nothing has been
    // observed — and the closed evidence_level enum has an exact token for
    // that state. The field ships now, at its honest value, so the record a
    // hosted route carries has the shape §5 requires from the start; the
    // machinery that would raise it to host-observed or runtime-reported
    // belongs to the telemetry slice and is deliberately not invented here.
    evidence_level: 'unknown',
  };

  // The host pair a hosted seat dispatches through (§5, §10): null for native
  // Claude work, both set for a hosted one, which is exactly the shape
  // route.js's reviewer_host_model/reviewer_host_effort pair requires. Read off
  // the resolved seat so a substituted reviewer reports the host it will
  // actually run on, never the one the row named.
  const hostOf = (seat) => ({
    host_model: isPlainObject(seat) && typeof seat.host === 'string' ? seat.host : null,
    host_effort: isPlainObject(seat) && typeof seat.host_effort === 'string' ? seat.host_effort : null,
  });

  // Class-aware twice over from r4: the row itself is the ladder for this
  // task class, and every seat that row can route carries a
  // review_qualification bound the class may not exceed. A candidate whose
  // bound the class exceeds is refused from this path rather than the floor
  // scaled down — bans.review_floor_scale_down is a ban, not a schedule — so
  // gemini, bounded at standard by the operator restriction, is skipped in the
  // expert and apex rows that name it and claude-authored work there falls to
  // the explicit degraded transition below. Configs from before the bounds
  // (r1/r2) carry no filter, and configs before the class-keyed rows (r3) read
  // one flat row per family: honest to what each revision's law actually was.
  const qualification = effective.review_qualification;
  for (const candidate of classRow) {
    const resolved = Object.prototype.hasOwnProperty.call(subs, candidate) ? subs[candidate] : candidate;
    const seat = seats[resolved];
    if (!isPlainObject(seat) || 'alias_of' in seat) continue; // never routable; validation refuses configs that ship this
    if (capabilityUnavailable(seat, effective.capability)) continue;
    // Family establishment precedes every later filter: a resolved seat
    // whose family cannot be established refuses outright (N5) instead of
    // slipping into the qualification skip below and resolving as a
    // lawful-looking degraded transition.
    if (typeof seat.family !== 'string' || seat.family === '') {
      refuseLaundering('cross-family', seat.family, authorFamily);
    }
    // Post-substitution family re-check: a candidate whose resolved seat
    // lands in the author's own family can never serve the cross-family
    // path. It is dropped here; the explicit degraded transition below is
    // the only door through which this work meets a same-family reviewer.
    if (seat.family === authorFamily) continue;
    // The qualification refusal: post-substitution, so a substitute seat is
    // held to the same bound the row seat would have been.
    if (qualification !== null && !classWithinBound(taskClass, qualification[resolved])) continue;
    const bundle = {
      seat: resolved,
      requested_seat: candidate,
      substituted: resolved !== candidate,
      family: seat.family,
      model: seat.model,
      effort: typeof seat.effort === 'string' ? seat.effort : null,
      ...hostOf(seat),
      independence: 'cross-family',
      // The pairing key is a degraded-path concept and is not consulted on
      // this path; null states that outright, so a caller passing an
      // author model can tell it was accepted but had no bearing here.
      author_model: null,
      ...shared,
      rerouted: resolved !== base[0],
      notices: effective.notices,
    };
    refuseLaundering(bundle.independence, bundle.family, authorFamily);
    return bundle;
  }

  // No cross-family candidate survives: the explicit degraded transition —
  // relabeled, never a quiet mapping onto a same-family seat. The design
  // (§8) scopes that transition to claude-authored work: the claude
  // reviewer row is the always-on floor for gpt- and gemini-authored work
  // (§6.2), so reaching this point as a non-claude author means the
  // routing table itself is malformed — resolving a Claude reviewer here
  // would record a notice asserting author and reviewer share a family,
  // which would be false. Refuse rather than write a false record.
  if (authorFamily !== 'claude') {
    throw new Error(
      `routing: no cross-family reviewer is effectively available for ${authorFamily}-authored ${taskClass} ` +
        'work, and the degraded path is scoped to claude-authored work — the claude reviewer row is the ' +
        'always-on floor for non-claude authors, so this state is a malformed routing table, not a degraded one'
    );
  }
  if (effective.degraded_review_posture === 'hold') {
    throw new Error(
      `routing: no cross-family reviewer is effectively available for ${authorFamily}-authored ${taskClass} ` +
        'work and settings degraded_review is "hold" — the operator-selected hold posture refuses the degraded ' +
        'path; re-enable a lane or set degraded_review to "degraded-path"'
    );
  }
  const block = effective.degraded_review;
  if (!isPlainObject(block) || !isPlainObject(block.rows)) {
    throw new Error(
      `routing: no cross-family reviewer is effectively available for ${authorFamily}-authored ${taskClass} ` +
        `work and the active config (revision ${effective.revision}) carries no degraded_review block — ` +
        'run routing.js revise before routing degraded review'
    );
  }
  const row = block.rows[taskClass];
  const pairedModels = isPlainObject(row) ? Object.keys(row) : [];
  if (pairedModels.length === 0) {
    throw new Error(`routing: degraded_review.rows.${taskClass} pairs no author model — the active config is incomplete`);
  }
  let modelKey;
  if (authorModel === undefined) {
    modelKey = pairedModels[0];
  } else if (Object.prototype.hasOwnProperty.call(row, authorModel)) {
    modelKey = authorModel;
  } else {
    throw new Error(
      `routing: degraded_review.rows.${taskClass} pairs author model(s) ${pairedModels.join(', ')} and has no ` +
        `pairing for author model "${authorModel}"`
    );
  }
  const seatName = row[modelKey];
  const seat = seats[seatName];
  const bundle = {
    seat: seatName,
    // Same shape as the cross-family bundle (plan §7 wants substitution
    // status in the review-phase route record): the degraded seat is
    // selected directly from its row, so it is its own requested seat and
    // nothing was substituted — consumers never branch on independence to
    // learn which fields exist.
    requested_seat: seatName,
    substituted: false,
    family: seat.family,
    model: seat.model,
    effort: typeof seat.effort === 'string' ? seat.effort : null,
    // Native by definition — the degraded path is a fresh-context Claude
    // reviewer, which validation enforces on every row of the block — so the
    // pair is null here for the same reason it is null for any native seat,
    // and the field is present for the same reason every other one is: a
    // consumer never branches on independence to learn which fields exist.
    ...hostOf(seat),
    independence: 'degraded-path',
    author_model: modelKey,
    // Preference ladder, not a hard requirement: when this preferred seat's
    // model is unavailable at spawn time, a second fresh-context instance of
    // the author's own model reviews instead at high effort, recorded with
    // fallback_used/fallback_reason by the caller. Resolution behaviour of
    // this module — deliberately not a seat-level fallback profile.
    fallback: {
      model: modelKey,
      effort: 'high',
      fresh_instance: true,
      notice: block.fallback_notice,
    },
    ...shared,
    rerouted: true,
    notices: effective.notices.concat([block.notice]),
  };
  // Fallback re-check: composed after the fallback profile, same invariant,
  // same refusal — degraded-path labeling is what makes this bundle lawful.
  refuseLaundering(bundle.independence, bundle.family, authorFamily);
  return bundle;
}

// --- author-and-reviewer topology --------------------------------------------

// The brief is the input and the whole input: tier-for resolves a topology from
// a validated eight-field contract on disk, never from arguments, so the class
// that decides the seat is the same class the worker will be held to. An
// unreadable, unparseable or invalid brief is refused by name — a topology
// resolved from a malformed contract is work nobody asked for.
function readBriefForRouting(briefPath) {
  if (typeof briefPath !== 'string' || briefPath === '') {
    throw new Error('routing: tier-for requires a brief path');
  }
  const missing = Symbol('missing');
  // readJson throws its own shaped error on unparseable JSON, which is already
  // the refusal this wants; only absence needs a message of its own.
  const brief = readJson(briefPath, missing);
  if (brief === missing) {
    throw new Error(`routing: no brief at ${briefPath} — tier-for resolves a topology from a brief on disk`);
  }
  const { ok, errors } = validateBrief(brief);
  if (!ok) {
    throw new Error(`routing: the brief at ${briefPath} is not a valid eight-field brief, so no topology is resolved from it: ${errors.join('; ')}`);
  }
  return brief;
}

// One brief in, one whole dispatch topology out — the author seat with its
// profile and host pair, the review capacity reserved behind it, the rungs this
// lane state cost, and the config revision both halves resolved under.
//
// Two things this deliberately does NOT do. It never re-implements review
// resolution: `reviewFor` carries the author-family drop, the qualification
// bounds, the degraded transition and the laundering refusal, and a second copy
// of that law would drift from it, so the review half is one call into the same
// function `review-for` exposes. And it never judges an `escalated` request:
// §9's state machine lives in route.js, which refuses an escalation profile on a
// route with no predecessor to escalate from. The flag is convenience input
// here, never authority — tier-for resolves what was asked and route.js refuses
// it if the ledger does not support it.
//
// What it does own is the refusal to emit at all. A topology whose review
// cannot resolve — no qualified cross-family candidate and no lawful degraded
// path, or an operator-selected hold — is not a topology: the author it names
// could run to completion and still have nothing that could lawfully land it.
// Discovering that here costs one call; discovering it at close costs the whole
// run and leaves work that cannot land, so the refusal is the point of the
// command rather than a guard on the end of it.
//
// Escalation, both directions. A fresh resolution walks the ordinary rungs only:
// design §12 states an escalation entry is never selected on fresh dispatch,
// because §10 reaches that rung by superseding a route the ordinary rung already
// defeated, and a first dispatch selecting it would spend the mission's one
// profile escalation before anything had failed. An escalated resolution is the
// mirror of that, not a widening of it: it walks the escalation rungs, because
// what an escalation asks for is precisely the profile the ordinary ladder does
// not offer — §10's expert row is "escalate opus-high → fable-low", and a walk
// that could answer it with the defeated opus rung again would answer a
// within-class-profile-escalation with a route that changes no profile, which
// route.js refuses on the same grounds.
function tierFor(treeRoot, briefPath, escalated) {
  const wantEscalation = escalated === true;
  const brief = readBriefForRouting(briefPath);
  const taskClass = brief.tier;

  const effective = effectiveRouting(treeRoot);
  if (!isPlainObject(effective.tiers) || !isPlainObject(effective.tiers.classes)) {
    throw new Error(
      `routing: the active config (revision ${effective.revision}) carries no tiers block, so no author ladder exists — ` +
        'run routing.js revise before resolving a topology'
    );
  }
  const klass = effective.tiers.classes[taskClass];
  if (!isPlainObject(klass) || !Array.isArray(klass.candidates) || klass.candidates.length === 0) {
    throw new Error(`routing: tiers.classes.${taskClass} names no candidate ladder — the active config is incomplete`);
  }

  const isEscalationRung = (candidate) => candidate.escalation === true;
  const ladder = klass.candidates.filter((candidate) => isEscalationRung(candidate) === wantEscalation);
  // Named, never silently dropped: a fresh resolution that had an escalation
  // rung it did not reach is a different fact from a class that has none, and a
  // liaison deciding whether escalation is even possible for this class reads it
  // here. It is deliberately NOT a candidates_skipped entry — that vocabulary is
  // route.js's closed availability enum, and a rung withheld by law was
  // available, not absent.
  const escalationWithheld = wantEscalation ? [] : klass.candidates.filter(isEscalationRung).map((c) => c.seat);

  // The same two availability facts reviewFor records, from the same data: a
  // seat carrying a degraded substitution is a seat whose lane is out, and the
  // capability map excludes a model × effort it does not record as present. The
  // author side answers a lane-out rung by walking to the next one rather than
  // by taking the substitute — the ladder is preference-ordered over the whole
  // topology and already names the substitute's own class-mate — which is also
  // what keeps this a lawful fresh route: route.js (§7 correction 9) refuses a
  // fresh route claiming substituted:true, because an ineligible candidate is
  // recorded as a skip, never as a requested-then-substituted pair.
  const candidatesSkipped = [];
  let chosen = null;
  for (const candidate of ladder) {
    const seat = effective.seats[candidate.seat];
    if (Object.prototype.hasOwnProperty.call(effective.seat_substitutions, candidate.seat)) {
      candidatesSkipped.push({ seat: candidate.seat, reason: 'lane-down' });
      continue;
    }
    if (capabilityUnavailable(seat, effective.capability)) {
      candidatesSkipped.push({ seat: candidate.seat, reason: 'capability-absent' });
      continue;
    }
    chosen = { candidate, seat };
    break;
  }

  if (chosen === null) {
    const cost = candidatesSkipped.map((s) => `${s.seat} (${s.reason})`).join(', ');
    if (wantEscalation && ladder.length === 0) {
      throw new Error(
        `routing: the ${taskClass} ladder carries no escalation rung — an escalated resolution of this class has ` +
          'nothing to select; §10 escalates it by class or sends it to convergence instead'
      );
    }
    throw new Error(
      `routing: no ${wantEscalation ? 'escalation ' : ''}author seat is available for ${taskClass} work — ` +
        `every candidate was skipped: ${cost}`
    );
  }

  const seatName = chosen.candidate.seat;
  const seat = chosen.seat;
  const authorFamily = seat.family;

  // The review half through the one resolver that owns it. Its refusals become
  // this command's refusal, unchanged and quoted: tier-for does not decide WHY a
  // review is unresolvable — reviewFor's law does — it decides that an
  // unresolvable review means no topology is emitted at all.
  let review;
  try {
    review = reviewFor(treeRoot, authorFamily, taskClass, typeof seat.model === 'string' ? seat.model : undefined);
  } catch (err) {
    throw new Error(
      `routing: refusing to emit a topology that could not lawfully close — ${authorFamily}-authored ${taskClass} ` +
        `work on seat "${seatName}" has no resolvable review: ${err.message}`
    );
  }
  // Both halves must have resolved against one config. reviewFor loads the
  // active pointer itself, so a repoint (or a rollback) landing between the two
  // reads would pair an author from one revision with a reviewer from another
  // and record a single revision over both.
  if (review.routing_config !== effective.active_config || review.routing_digest !== effective.active_digest) {
    throw new Error(
      `routing: the author half resolved against "${effective.active_config}" and the review half against ` +
        `"${review.routing_config}" — the active routing pointer moved mid-resolution; re-run tier-for`
    );
  }

  // A fallback profile is a pair or it is nothing: route.js records it as
  // { model, effort }, and half a profile would name a model at an effort
  // nobody chose.
  const fallbackProfile =
    typeof seat.fallback === 'string' && typeof seat.fallback_effort === 'string'
      ? { model: seat.fallback, effort: seat.fallback_effort }
      : null;

  // Union, order-preserving: the lane notices this resolution ran under, plus
  // whatever the review half added (the degraded-path notice, when it took that
  // transition). A notice appearing on both sides is one fact, not two.
  const notices = effective.notices.concat(review.notices.filter((n) => !effective.notices.includes(n)));

  return {
    schema_version: SCHEMA_VERSION,
    class: taskClass,
    escalated: wantEscalation,
    seat: seatName,
    // A fresh resolution resolves the seat it requested, by construction: the
    // walk above skips what it cannot use and never substitutes.
    requested_seat: seatName,
    substituted: false,
    status: chosen.candidate.status,
    escalation_profile: chosen.candidate.escalation === true,
    author_family: authorFamily,
    worker_model: typeof seat.model === 'string' ? seat.model : null,
    worker_effort: typeof seat.effort === 'string' ? seat.effort : null,
    // Both set for a hosted seat, both null for a native one — §5's shape, and
    // the pair route.js's host_model/host_effort validation requires.
    host_model: typeof seat.host === 'string' ? seat.host : null,
    host_effort: typeof seat.host_effort === 'string' ? seat.host_effort : null,
    fallback_profile: fallbackProfile,
    candidates_skipped: candidatesSkipped,
    escalation_withheld: escalationWithheld,
    // Exactly route.js's reserved_review shape (§13.1): the capacity this author
    // is reserved against, resolved before the author is spawned rather than
    // after it has produced work.
    review: {
      seat: review.seat,
      family: review.family,
      model: review.model,
      effort: review.effort,
      independence: review.independence,
    },
    routing_config: effective.active_config,
    routing_digest: effective.active_digest,
    routing_revision: effective.revision,
    lane_state: effective.provider_lanes,
    degraded_modes: effective.degraded_modes,
    notices,
  };
}

// --- CLI --------------------------------------------------------------------

const HELP = `routing.js — maestro seat routing (sole writer of routing/*)

usage:
  routing.js init <treeRoot>
  routing.js revise <treeRoot>
  routing.js active <treeRoot>
  routing.js review-for <treeRoot> <author_family> [class] [author_model] [--json]
  routing.js tier-for <treeRoot> <briefPath> [--escalated]

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
              state.json.preflight provider modes AND settings
              provider_lanes (a provider routes as up only when its routing
              token is exactly "present" and its lane is not operator-down;
              no recorded preflight applies no probe-driven degradation),
              and prints the effective routing JSON: seats,
              seat_substitutions, review_routing, bans, degraded_modes,
              notices, provider_lanes, capability, degraded_review,
              review_qualification.
  review-for  resolves the reviewer for work authored by <author_family>
              (claude | gpt | gemini) at [class] (recon | mechanical |
              standard | expert | apex; defaults to standard), author- and
              class-aware: the candidates are that class's own ladder in
              review_routing (one ladder per author family and class from
              revision 4 on, one flat row per family before it),
              lane-or-capability-unavailable candidates,
              candidates of the author's own effective family, and
              candidates whose review_qualification bound the class exceeds
              (the review floor is never scaled down) are dropped, the first
              remaining cross-family candidate wins, and otherwise the
              resolution falls to the explicit degraded path — tier-scaled
              through every class, apex included, labeled independence
              "degraded-path" and never "cross-family" — unless settings
              degraded_review is "hold" (operator-selected, never the
              default), which refuses instead. [author_model] selects the
              degraded row's pairing by the model that authored the work
              (the apex row pairs fable-5 and opus-5); omitted, the row's
              first pairing — the class's canonical authorship — applies,
              and the bundle's author_model field names the key actually
              used. Default output prints the seat name, with each
              applicable notice on stderr when the choice was rerouted;
              --json prints the full resolution bundle (seat,
              requested_seat, substituted, family, model, effort,
              host_model/host_effort — both set for a hosted seat, both null
              for a native one — independence, author_model — the degraded
              pairing key actually applied, null on the cross-family path
              where the argument has no bearing — class, routing_config,
              routing_digest, candidates_skipped — the ladder rungs this
              class could not try, each with reason lane-down or
              capability-absent — evidence_level (always "unknown": a
              resolution is a request, nothing has executed yet), notices,
              and on the degraded path the same-model fallback).
  tier-for    resolves the WHOLE dispatch topology for the validated
              eight-field brief at <briefPath> — author and reviewer in one
              call — and prints it as one JSON object. The brief is
              validated first and an invalid one is refused, listing the
              validator's own errors. brief.tier selects the class ladder in
              the config's tiers block, which is walked in preference order:
              a candidate whose lane is out, or whose exact model x effort
              the capability map does not record as present, is skipped with
              that reason (lane-down | capability-absent) and the next rung
              is tried — the author side answers an unavailable rung by
              walking the ladder, never by substituting, so the resolved
              seat is always the requested one. The review half is resolved
              by the same review-for resolver, against the author seat's own
              family, class and model. Escalation rungs are unreachable
              here: a fresh resolution walks the ordinary rungs and names
              the withheld ones in escalation_withheld, and --escalated
              walks the escalation rungs instead — the flag is convenience
              input, and route.js refuses an escalation profile on a route
              with no predecessor to escalate from.
              IT REFUSES rather than emitting when the route could not
              lawfully close: when no review resolves at all (including the
              operator-selected degraded_review "hold" posture), and when no
              candidate in the class is available. Output fields: class,
              escalated, seat, requested_seat, substituted, status,
              escalation_profile, author_family, worker_model,
              worker_effort, host_model/host_effort (both set for a hosted
              seat, both null for a native one), fallback_profile,
              candidates_skipped, escalation_withheld, review {seat, family,
              model, effort, independence}, routing_config, routing_digest,
              routing_revision, lane_state, degraded_modes, notices. The
              notices are the routing layer's verbatim text; route.js's own
              route-record notices field is a short single-line summary
              field, so a caller composes that from these rather than
              passing them through.

Exits 0 on success; every refusal prints to stderr and exits 1.
`;

const COMMAND_ARITY = { init: [0, 0], revise: [0, 0], active: [0, 0], 'review-for': [1, 3], 'tier-for': [1, 1] };

function parseArgv(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    return { help: true };
  }
  const json = argv.includes('--json');
  const escalated = argv.includes('--escalated');
  const [command, treeRoot, ...rest] = argv.filter((arg) => arg !== '--json' && arg !== '--escalated');
  if (command === undefined) {
    return { error: 'a command is required' };
  }
  if (!Object.prototype.hasOwnProperty.call(COMMAND_ARITY, command)) {
    return { error: `unknown command "${command}"` };
  }
  if (json && command !== 'review-for') {
    return { error: `--json is only accepted by review-for` };
  }
  if (escalated && command !== 'tier-for') {
    return { error: `--escalated is only accepted by tier-for` };
  }
  if (typeof treeRoot !== 'string' || treeRoot === '') {
    return { error: `${command} requires a <treeRoot> argument` };
  }
  const [min, max] = COMMAND_ARITY[command];
  if (rest.length < min) {
    return { error: `${command} is missing required argument(s)` };
  }
  if (rest.length > max) {
    return { error: `unexpected extra argument(s): ${rest.slice(max).join(' ')}` };
  }
  return { command, treeRoot, args: rest, json, escalated };
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
      delete effective.degraded_review_posture; // internal to reviewFor's settings-snapshot atomicity, same status
      process.stdout.write(JSON.stringify(effective, null, 2) + '\n');
    } else if (command === 'review-for') {
      // Class defaults to standard for the back-compat one-line form; the
      // bundle's own class field always names what was actually resolved.
      // The author model rides through so every degraded row pairing is
      // resolvable from the CLI, not only the row's first entry.
      const bundle = reviewFor(treeRoot, args[0], args[1] === undefined ? 'standard' : args[1], args[2]);
      if (parsed.json) {
        process.stdout.write(JSON.stringify(bundle, null, 2) + '\n');
      } else {
        if (bundle.rerouted) {
          for (const notice of bundle.notices) {
            process.stderr.write(`routing.js: ${notice}\n`);
          }
        }
        process.stdout.write(bundle.seat + '\n');
      }
    } else if (command === 'tier-for') {
      // Always JSON: a topology is a structure, and the one-line form that
      // exists for review-for's back-compat would have to pick one field of
      // a dozen to be the answer.
      process.stdout.write(JSON.stringify(tierFor(treeRoot, args[0], parsed.escalated), null, 2) + '\n');
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
  tierFor,
  validateRoutingConfig,
  buildDefaultConfig,
  buildRevision1Config,
  CURRENT_ROUTING_REVISION,
  MIGRATIONS,
  DATED_CONFIG_RE,
  ACTIVE_BASENAME,
  ROUTING_DIRNAME,
  FAMILIES,
};
