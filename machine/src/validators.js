'use strict';

// maestro machine layer — contract validators (library + CLI).
//
// Pure boundary validation: nothing here writes any record. Every public
// validator returns { ok, errors: [...] } and NEVER throws, whatever the
// input — malformed shapes, hostile prototypes, throwing getters, toJSON
// tricks all land as { ok: false }.

const fs = require('node:fs');

const { LINE_CEILING, ISO_8601_UTC_RE } = require('./jsonl.js');

// --- shared helpers ---------------------------------------------------------

// Ordinary data objects only: a custom-prototype instance (or one carrying a
// toJSON) can present plausible enumerable fields while JSON.stringify
// serializes something else entirely, letting the field checks and the byte
// check validate two different shapes.
function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  if (typeof value.toJSON === 'function') return false;
  return true;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

const SINGLE_LINE_RE = /^[^\r\n]*$/;

function countWords(text) {
  const trimmed = text.trim();
  if (trimmed === '') return 0;
  return trimmed.split(/\s+/).length;
}

function checkExactKeys(obj, requiredKeys, label, errors) {
  for (const key of Object.keys(obj)) {
    if (!requiredKeys.includes(key)) {
      errors.push(`${label} has unexpected extra key "${key}"`);
    }
  }
  for (const key of requiredKeys) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) {
      errors.push(`${label} is missing required key "${key}"`);
    }
  }
}

// --- envelope ---------------------------------------------------------------

const ENVELOPE_KEYS = ['state', 'result', 'evidence', 'risks', 'artifact', 'question'];
const ENVELOPE_STATES = new Set(['done', 'partial', 'blocked']);
const ENVELOPE_STRING_KEYS = ['result', 'evidence', 'risks', 'artifact', 'question'];
const ENVELOPE_WORD_KEYS = ['result', 'evidence', 'risks', 'question'];
const ENVELOPE_WORD_CEILING = 300;

function validateEnvelope(env) {
  try {
    return validateEnvelopeChecked(env);
  } catch (err) {
    return { ok: false, errors: [`envelope could not be inspected: ${err.message}`] };
  }
}

function validateEnvelopeChecked(env) {
  if (!isPlainObject(env)) {
    return { ok: false, errors: ['envelope must be a plain object'] };
  }
  const errors = [];
  checkExactKeys(env, ENVELOPE_KEYS, 'envelope', errors);

  if (Object.prototype.hasOwnProperty.call(env, 'state')) {
    if (typeof env.state !== 'string') {
      errors.push('envelope field "state" must be a string');
    } else if (!ENVELOPE_STATES.has(env.state)) {
      errors.push(`envelope field "state" must be one of done, partial, blocked (got "${env.state}")`);
    }
  }

  for (const key of ENVELOPE_STRING_KEYS) {
    if (Object.prototype.hasOwnProperty.call(env, key) && typeof env[key] !== 'string') {
      errors.push(`envelope field "${key}" must be a string`);
    }
  }

  // question is non-empty IFF state is "blocked" — a blocked worker owes the
  // operator its question, and a non-blocked one may not smuggle one in.
  if (
    typeof env.state === 'string' &&
    ENVELOPE_STATES.has(env.state) &&
    typeof env.question === 'string'
  ) {
    const hasQuestion = env.question.trim() !== '';
    if (env.state === 'blocked' && !hasQuestion) {
      errors.push('envelope field "question" must be non-empty when state is "blocked"');
    } else if (env.state !== 'blocked' && hasQuestion) {
      errors.push(`envelope field "question" must be empty when state is "${env.state}"`);
    }
  }

  if (ENVELOPE_WORD_KEYS.every((key) => typeof env[key] === 'string')) {
    const totalWords = ENVELOPE_WORD_KEYS.reduce((sum, key) => sum + countWords(env[key]), 0);
    if (totalWords > ENVELOPE_WORD_CEILING) {
      errors.push(
        `envelope word count across result+evidence+risks+question is ${totalWords}, exceeding the ${ENVELOPE_WORD_CEILING}-word ceiling`
      );
    }
  }

  // +1 for the trailing newline jsonl.appendRecord writes: LINE_CEILING is
  // the full line including it, so the check here must leave that byte free.
  let serializedByteLength;
  try {
    serializedByteLength = Buffer.byteLength(JSON.stringify(env), 'utf8') + 1;
  } catch {
    serializedByteLength = Infinity;
  }
  if (serializedByteLength > LINE_CEILING) {
    errors.push(
      `envelope serialized line is ${serializedByteLength} bytes, exceeding the ${LINE_CEILING}-byte ceiling`
    );
  }

  return { ok: errors.length === 0, errors };
}

// --- brief ------------------------------------------------------------------

const BRIEF_KEYS = [
  'outcome',
  'scope',
  'anchors',
  'acceptance',
  'freshness',
  'tier',
  'return_format',
  'stop_condition',
];
const BRIEF_STRING_KEYS = BRIEF_KEYS.filter((key) => key !== 'anchors');
// Closed task-class vocabulary (tiered-dispatch-final-design.md §3): the
// five-value brief.tier enum this module enforces. routing.js and roster.js
// do not yet consume it — that lands in a later slice. A legacy free-form
// label is a validation failure, not a value to tolerate.
const BRIEF_TIER_VALUES = new Set(['recon', 'mechanical', 'standard', 'expert', 'apex']);

function validateBrief(brief) {
  try {
    return validateBriefChecked(brief);
  } catch (err) {
    return { ok: false, errors: [`brief could not be inspected: ${err.message}`] };
  }
}

function validateBriefChecked(brief) {
  if (!isPlainObject(brief)) {
    return { ok: false, errors: ['brief must be a plain object'] };
  }
  const errors = [];
  checkExactKeys(brief, BRIEF_KEYS, 'brief', errors);

  for (const key of BRIEF_STRING_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(brief, key)) continue;
    if (!isNonEmptyString(brief[key])) {
      errors.push(`brief field "${key}" must be a non-empty string`);
    }
  }

  if (Object.prototype.hasOwnProperty.call(brief, 'anchors')) {
    const anchors = brief.anchors;
    if (!Array.isArray(anchors) || anchors.length === 0) {
      errors.push('brief field "anchors" must be a non-empty array of non-empty strings');
    } else if (anchors.some((entry) => !isNonEmptyString(entry))) {
      errors.push('brief field "anchors" must contain only non-empty strings');
    }
  }

  // Guarded to isNonEmptyString first: a non-string/empty tier already earns
  // its "must be a non-empty string" error from the BRIEF_STRING_KEYS loop
  // above, and this membership check must not pile a second error onto it.
  if (
    Object.prototype.hasOwnProperty.call(brief, 'tier') &&
    isNonEmptyString(brief.tier) &&
    !BRIEF_TIER_VALUES.has(brief.tier)
  ) {
    errors.push(
      `brief field "tier" must be one of ${[...BRIEF_TIER_VALUES].join(', ')} (got ${JSON.stringify(brief.tier)})`
    );
  }

  return { ok: errors.length === 0, errors };
}

// --- deviation --------------------------------------------------------------

// Deliberately narrow, and deliberately severity-free: a deviation is an
// audit fact about a gap between instruction and reality, independent of
// whether it also became a blocker — that separate question owns S1/S2/S3.
const DEVIATION_KEYS = ['reported_by', 'expected', 'actual', 'summary'];
// Reporter-identity floor: an audit fact with no attributable reporter
// behind it is not a deviation report.
const FORBIDDEN_REPORTED_BY = new Set(['system', 'unknown']);

function validateDeviation(deviation) {
  try {
    return validateDeviationChecked(deviation);
  } catch (err) {
    return { ok: false, errors: [`deviation could not be inspected: ${err.message}`] };
  }
}

function validateDeviationChecked(deviation) {
  if (!isPlainObject(deviation)) {
    return { ok: false, errors: ['deviation must be a plain object'] };
  }
  const errors = [];
  checkExactKeys(deviation, DEVIATION_KEYS, 'deviation', errors);

  for (const key of DEVIATION_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(deviation, key)) continue;
    if (!isNonEmptyString(deviation[key])) {
      errors.push(`deviation field "${key}" must be a non-empty string`);
    }
  }
  if (isNonEmptyString(deviation.reported_by) && FORBIDDEN_REPORTED_BY.has(deviation.reported_by)) {
    errors.push(
      `deviation field "reported_by" must name a real reporting agent, never "${deviation.reported_by}"`
    );
  }

  return { ok: errors.length === 0, errors };
}

// --- friction ----------------------------------------------------------------

// friction.js's sole shape: the closed vocabulary of the three real-time
// events (DECISIONS.md "Visibility") plus revise-verdict, the one non-rare
// event still worth a ledger record because the revise cap and the audit
// pattern (revise-cap hit rate) both need per-mission counts of it. `seat` is
// the only optional field — not every friction kind names one (ladder
// engagement and revise-verdict are mission-scoped, not seat-scoped).
// The tiered-dispatch kinds (final design §16.4) join the same closed set:
// the profile ladder's own engagement, the reservation a review lost, the
// receipt-driven mismatch that stays dormant until receipts exist, and the
// four reroute causes. Recording and aggregation pick them up from this set
// alone, and the infrastructure kinds among them — provider, quota, safety
// and runtime reroutes — are exactly the events §9 forbids counting toward
// quality escalation, which is why they are named apart from the quality
// ones rather than folded into a single "rerouted".
const FRICTION_KINDS = new Set([
  'ladder-engaged',
  'seat-degraded',
  'worker-died',
  'revise-verdict',
  'profile-escalated',
  'review-reservation-lost',
  'runtime-profile-mismatch',
  'provider-rerouted',
  'quota-rerouted',
  'safety-refusal-rerouted',
  'runtime-retried',
]);
const FRICTION_REQUIRED_KEYS = ['kind', 'mission_id', 'detail'];
const FRICTION_KEYS = ['kind', 'mission_id', 'seat', 'detail'];
const FRICTION_DETAIL_CEILING = 200;

function validateFriction(friction) {
  try {
    return validateFrictionChecked(friction);
  } catch (err) {
    return { ok: false, errors: [`friction could not be inspected: ${err.message}`] };
  }
}

function validateFrictionChecked(friction) {
  if (!isPlainObject(friction)) {
    return { ok: false, errors: ['friction must be a plain object'] };
  }
  const errors = [];
  for (const key of Object.keys(friction)) {
    if (!FRICTION_KEYS.includes(key)) {
      errors.push(`friction has unexpected extra key "${key}"`);
    }
  }
  for (const key of FRICTION_REQUIRED_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(friction, key)) {
      errors.push(`friction is missing required key "${key}"`);
    }
  }

  if (Object.prototype.hasOwnProperty.call(friction, 'kind')) {
    if (!isNonEmptyString(friction.kind) || !FRICTION_KINDS.has(friction.kind)) {
      errors.push(
        `friction field "kind" must be one of ${[...FRICTION_KINDS].join(', ')} (got ${JSON.stringify(friction.kind)})`
      );
    }
  }
  if (Object.prototype.hasOwnProperty.call(friction, 'mission_id') && !isNonEmptyString(friction.mission_id)) {
    errors.push('friction field "mission_id" must be a non-empty string');
  }
  if (Object.prototype.hasOwnProperty.call(friction, 'seat') && !isNonEmptyString(friction.seat)) {
    errors.push('friction field "seat" must be a non-empty string when present');
  }
  if (Object.prototype.hasOwnProperty.call(friction, 'detail')) {
    if (!isNonEmptyString(friction.detail)) {
      errors.push('friction field "detail" must be a non-empty string');
    } else if (!SINGLE_LINE_RE.test(friction.detail)) {
      errors.push('friction field "detail" must not contain a newline or carriage return');
    } else if (friction.detail.length > FRICTION_DETAIL_CEILING) {
      errors.push(
        `friction field "detail" must be at most ${FRICTION_DETAIL_CEILING} characters (got ${friction.detail.length})`
      );
    }
  }

  return { ok: errors.length === 0, errors };
}

// --- stop -------------------------------------------------------------------

// Closed five-value stop vocabulary; a closed field set PER stop kind, not a
// shared bag every kind may reach into. Every stop field is single-line:
// stop.js interpolates each onto its own handoff.md line, and an embedded
// newline could forge a second, unattributed field line below the real one.
const STOP_STATES = new Set(['DONE', 'BLOCKED-OPERATOR', 'QUOTA-WAIT', 'BUDGET-CEILING', 'EXHAUSTED']);
const STOP_BASE_KEYS = ['stop_state', 'reporter'];
const STOP_CONDITIONAL_KEYS = ['question', 'earliest_resume'];
const STOP_ALL_KEYS = [...STOP_BASE_KEYS, ...STOP_CONDITIONAL_KEYS];
// DONE, BUDGET-CEILING, and EXHAUSTED require neither conditional field and
// permit neither.
const STOP_REQUIRED_BY_STATE = {
  'BLOCKED-OPERATOR': ['question'],
  'QUOTA-WAIT': ['earliest_resume'],
};

function validateStop(stop) {
  try {
    return validateStopChecked(stop);
  } catch (err) {
    return { ok: false, errors: [`stop could not be inspected: ${err.message}`] };
  }
}

function validateStopChecked(stop) {
  if (!isPlainObject(stop)) {
    return { ok: false, errors: ['stop must be a plain object'] };
  }
  const errors = [];

  const stopStateOk = isNonEmptyString(stop.stop_state) && STOP_STATES.has(stop.stop_state);
  if (!stopStateOk) {
    errors.push(`stop field "stop_state" must be one of ${[...STOP_STATES].join(', ')}`);
  }
  if (!isNonEmptyString(stop.reporter)) {
    errors.push('stop field "reporter" must be a non-empty string');
  } else if (!SINGLE_LINE_RE.test(stop.reporter)) {
    errors.push('stop field "reporter" must not contain a newline or carriage return');
  }

  // Conditional fields are judged only against a recognized stop_state; an
  // already-invalid state gets no second, confusing layer of field errors.
  const requiredExtra = stopStateOk ? STOP_REQUIRED_BY_STATE[stop.stop_state] || [] : [];
  for (const field of STOP_CONDITIONAL_KEYS) {
    const present = Object.prototype.hasOwnProperty.call(stop, field);
    if (requiredExtra.includes(field)) {
      if (field === 'earliest_resume') {
        if (
          !isNonEmptyString(stop.earliest_resume) ||
          !ISO_8601_UTC_RE.test(stop.earliest_resume) ||
          Number.isNaN(Date.parse(stop.earliest_resume))
        ) {
          errors.push(
            'stop field "earliest_resume" must be an ISO-8601 UTC ("Z") timestamp when stop_state is "QUOTA-WAIT"'
          );
        }
      } else if (!isNonEmptyString(stop[field])) {
        errors.push(`stop field "${field}" must be a non-empty string when stop_state is "${stop.stop_state}"`);
      } else if (!SINGLE_LINE_RE.test(stop[field])) {
        errors.push(`stop field "${field}" must not contain a newline or carriage return`);
      }
    } else if (stopStateOk && present) {
      errors.push(`stop field "${field}" is not permitted when stop_state is "${stop.stop_state}"`);
    }
  }

  for (const key of Object.keys(stop)) {
    if (!STOP_ALL_KEYS.includes(key)) {
      errors.push(`stop has unexpected extra key "${key}"`);
    }
  }

  return { ok: errors.length === 0, errors };
}

// --- CLI --------------------------------------------------------------------

const COMMANDS = {
  'validate-brief': validateBrief,
  'validate-envelope': validateEnvelope,
  'validate-deviation': validateDeviation,
  'validate-friction': validateFriction,
  'validate-stop': validateStop,
};

const HELP = `validators.js — maestro contract validators

usage: validators.js <command>   (document JSON piped via stdin)

commands:
  validate-envelope    six-field worker report: state/result/evidence/risks/
                       artifact/question; state in {done, partial, blocked};
                       <=${ENVELOPE_WORD_CEILING} words across result+evidence+risks+question;
                       <=${LINE_CEILING}-byte serialized line; question non-empty
                       exactly when state is "blocked"
  validate-brief       eight-field dispatch brief: outcome/scope/anchors/
                       acceptance/freshness/tier/return_format/stop_condition;
                       anchors a non-empty array of non-empty strings; tier
                       one of ${[...BRIEF_TIER_VALUES].join(', ')}
  validate-deviation   { reported_by, expected, actual, summary } — all
                       non-empty; reported_by never "system" or "unknown"
  validate-friction    { kind, mission_id, seat?, detail } — kind one of
                       ${[...FRICTION_KINDS].join(', ')};
                       mission_id and detail non-empty; detail single-line,
                       <=${FRICTION_DETAIL_CEILING} chars; seat non-empty when present
  validate-stop        { stop_state, reporter } plus the one field its kind
                       requires: BLOCKED-OPERATOR -> question, QUOTA-WAIT ->
                       earliest_resume (ISO-8601 UTC "Z"); DONE,
                       BUDGET-CEILING, EXHAUSTED carry neither

Prints { ok, errors } to stdout; exits 0 when ok, 1 otherwise. Never throws:
malformed stdin JSON is itself reported as { ok: false }.
`;

// Fail-closed argv parsing: every token must be accounted for — a surplus
// positional or an unknown flag is a refusal, never silently ignored.
function parseArgv(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    return { help: true };
  }
  const [command, ...rest] = argv;
  if (rest.length > 0) {
    return { error: `unexpected extra argument(s): ${rest.join(' ')}` };
  }
  if (!Object.prototype.hasOwnProperty.call(COMMANDS, command)) {
    return { error: command === undefined ? 'a command is required' : `unknown command "${command}"` };
  }
  return { command };
}

function main(argv) {
  const parsed = parseArgv(argv);
  if (parsed.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  if (parsed.error) {
    process.stderr.write(`validators.js: ${parsed.error}\n${HELP}`);
    process.exit(1);
  }

  let result;
  try {
    const inputText = fs.readFileSync(0, 'utf8'); // fd 0 = stdin
    let input;
    try {
      input = JSON.parse(inputText);
    } catch (err) {
      result = { ok: false, errors: [`stdin did not carry valid JSON: ${err.message}`] };
    }
    if (result === undefined) {
      result = COMMANDS[parsed.command](input);
    }
  } catch (err) {
    // Even an stdin read failure honors the never-throws surface.
    result = { ok: false, errors: [`input could not be read: ${err.message}`] };
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(result.ok ? 0 : 1);
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = {
  validateEnvelope,
  validateBrief,
  validateDeviation,
  validateFriction,
  validateStop,
  ENVELOPE_KEYS,
  ENVELOPE_WORD_CEILING,
  BRIEF_KEYS,
  BRIEF_TIER_VALUES,
  DEVIATION_KEYS,
  FRICTION_KEYS,
  FRICTION_KINDS,
  FRICTION_DETAIL_CEILING,
  STOP_STATES,
};
