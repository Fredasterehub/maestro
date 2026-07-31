'use strict';

// maestro machine layer — schema-clamped settings (sole writer of
// settings.json).
//
// The knob set is CLOSED: five adjustable knobs plus one locked key. The
// write path fails closed — an unknown key, a value outside an enum, a
// non-integer ceiling, or any attempt to change the locked review_floor
// refuses the whole write. The read path clamps forward — a hand-edited
// file (which bypasses this module entirely) is re-clamped on every read,
// with each correction reported through the clamps channel, so a bad
// hand-edit can never leak into effective settings. Deleted-not-falsed: a
// hand-edited review_floor value is discarded and the locked value
// re-applied; the bad value itself never lands anywhere.

const fs = require('node:fs');
const path = require('node:path');

const { readJson, updateJson } = require('./atomic-json.js');

const SETTINGS_BASENAME = 'settings.json';

const REVIEW_FLOOR_LOCKED_VALUE = 'cross-family';
const REVIEW_FLOOR_LOCKED_MESSAGE =
  'review_floor is locked at "cross-family" — review_floor_scale_down is banned in every mode';

// The closed knob schema. Rule kinds: enum (closed string set), integer
// (with floor/ceiling clamps), locked (single permitted value, ever).
const SCHEMA = {
  delegation: { kind: 'enum', values: ['strict', 'balanced'], default: 'strict' },
  fleet_ceiling: { kind: 'integer', floor: 1, ceiling: 12, default: 6 },
  landing: { kind: 'enum', values: ['review-then-merge', 'pr', 'report-only'], default: 'review-then-merge' },
  escalation: { kind: 'enum', values: ['auto_remedy', 'advise_me'], default: 'auto_remedy' },
  plan_rigor: { kind: 'enum', values: ['ask', 'standard', 'full'], default: 'ask' },
  review_floor: { kind: 'locked', value: REVIEW_FLOOR_LOCKED_VALUE, message: REVIEW_FLOOR_LOCKED_MESSAGE },
};

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function settingsPath(treeRoot) {
  return path.join(treeRoot, SETTINGS_BASENAME);
}

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

// Read-side clamping: forgiving by design (a read must always yield
// effective settings), but every correction is reported. Returns
// { settings, clamps }.
function clampDoc(input) {
  const doc = isPlainObject(input) ? input : {};
  const settings = {};
  const clamps = [];

  for (const key of Object.keys(doc)) {
    if (!Object.prototype.hasOwnProperty.call(SCHEMA, key)) {
      // Closed knob set: an unknown hand-edited key is dropped, never
      // carried forward.
      clamps.push({ key, from: doc[key], to: null, rule: 'unknown' });
    }
  }

  for (const [key, rule] of Object.entries(SCHEMA)) {
    const present = Object.prototype.hasOwnProperty.call(doc, key) && doc[key] !== undefined;
    const value = doc[key];

    if (rule.kind === 'locked') {
      settings[key] = rule.value;
      if (present && value !== rule.value) {
        clamps.push({ key, from: value, to: rule.value, rule: 'locked', message: rule.message });
      }
      continue;
    }

    if (!present) {
      settings[key] = rule.default;
      clamps.push({ key, from: undefined, to: rule.default, rule: 'default' });
      continue;
    }

    if (rule.kind === 'enum') {
      if (rule.values.includes(value)) {
        settings[key] = value;
      } else {
        settings[key] = rule.default;
        clamps.push({ key, from: value, to: rule.default, rule: 'enum' });
      }
      continue;
    }

    // rule.kind === 'integer'
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      settings[key] = rule.default;
      clamps.push({ key, from: value, to: rule.default, rule: 'invalid-type' });
    } else if (value < rule.floor) {
      settings[key] = rule.floor;
      clamps.push({ key, from: value, to: rule.floor, rule: 'floor' });
    } else if (value > rule.ceiling) {
      settings[key] = rule.ceiling;
      clamps.push({ key, from: value, to: rule.ceiling, rule: 'ceiling' });
    } else {
      settings[key] = value;
    }
  }

  return { settings, clamps };
}

// Write-side validation: fail closed. A patch reaching the disk must be
// unambiguous — the only silent-ish correction permitted is the documented
// numeric range clamp, and even that is reported. Returns an error list;
// empty means the patch is admissible.
function validatePatch(patch) {
  if (!isPlainObject(patch)) {
    return ['settings patch must be a JSON object'];
  }
  const errors = [];
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.prototype.hasOwnProperty.call(SCHEMA, key)) {
      errors.push(`unknown settings key "${key}" — the knob set is closed (${Object.keys(SCHEMA).join(', ')})`);
      continue;
    }
    const rule = SCHEMA[key];
    if (rule.kind === 'locked') {
      // The locked value itself is admissible (a no-op); anything else is
      // an attempted change and refuses the whole write.
      if (value !== rule.value) {
        errors.push(rule.message);
      }
    } else if (rule.kind === 'enum') {
      if (!rule.values.includes(value)) {
        errors.push(`"${key}" must be one of ${rule.values.map((v) => `"${v}"`).join(', ')}`);
      }
    } else if (rule.kind === 'integer') {
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        errors.push(`"${key}" must be an integer between ${rule.floor} and ${rule.ceiling}`);
      }
    }
  }
  return errors;
}

function read(treeRoot) {
  requireTreeRoot(treeRoot);
  const missing = Symbol('missing');
  const raw = readJson(settingsPath(treeRoot), missing);
  const source = raw === missing ? 'defaults' : 'file';
  const { settings, clamps } = clampDoc(raw === missing ? {} : raw);
  return { settings, clamps, source };
}

function write(treeRoot, patch) {
  requireTreeRoot(treeRoot);
  const errors = validatePatch(patch);
  if (errors.length > 0) {
    throw new Error(`invalid settings patch: ${errors.join('; ')}`);
  }

  let report;
  updateJson(
    settingsPath(treeRoot),
    (current) => {
      // Re-clamp what is on disk first (hand-edits bypass this module, so
      // the write transaction is the other place they get caught), then lay
      // the validated patch over it with the range clamp applied.
      const { settings: base, clamps } = clampDoc(current);
      const merged = { ...base };
      for (const [key, value] of Object.entries(patch)) {
        const rule = SCHEMA[key];
        if (rule.kind === 'locked') {
          continue; // validated equal to the locked value; base already carries it
        }
        if (rule.kind === 'integer') {
          if (value < rule.floor) {
            merged[key] = rule.floor;
            clamps.push({ key, from: value, to: rule.floor, rule: 'floor' });
          } else if (value > rule.ceiling) {
            merged[key] = rule.ceiling;
            clamps.push({ key, from: value, to: rule.ceiling, rule: 'ceiling' });
          } else {
            merged[key] = value;
          }
        } else {
          merged[key] = value;
        }
      }
      report = { settings: merged, clamps };
      return merged;
    },
    {}
  );
  return report;
}

// --- CLI --------------------------------------------------------------------

const HELP = `settings.js — maestro schema-clamped settings (sole writer of settings.json)

usage:
  settings.js read <treeRoot>
  settings.js write <treeRoot>          patch JSON piped via stdin

knobs (closed set):
  delegation      "strict" | "balanced"                    default "strict"
  fleet_ceiling   integer 1..12 (out-of-range clamps)      default 6
  landing         "review-then-merge" | "pr" |
                  "report-only"                            default "review-then-merge"
  escalation      "auto_remedy" | "advise_me"              default "auto_remedy"
  plan_rigor      "ask" | "standard" | "full"               default "ask"
  review_floor    locked at "cross-family" — any attempt to change it
                  refuses the whole write; a hand-edited value is discarded
                  on read and the locked value re-applied (deleted, never
                  carried forward as a false setting)

commands:
  read    prints { settings, clamps, source } — the on-disk document with
          every schema clamp re-applied. Hand-edited unknown keys are
          dropped (rule "unknown"), invalid values fall back with a report,
          and missing keys fill from defaults (rule "default"); the file
          itself is not modified.
  write   stdin: a patch touching any subset of the knobs. Fails closed:
          unknown keys, out-of-enum values, non-integer fleet_ceiling, or a
          review_floor change refuse the whole write (exit 1, nothing
          written). An integer merely out of range is clamped to the floor
          or ceiling and reported. Prints { settings, clamps } for exactly
          what landed on disk.

Exits 0 on success; refusals print to stderr and exit 1.
`;

const COMMAND_ARITY = { read: 0, write: 0 };

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
  if (rest.length > 0) {
    return { error: `unexpected extra argument(s): ${rest.join(' ')}` };
  }
  return { command, treeRoot };
}

function main(argv) {
  const parsed = parseArgv(argv);
  if (parsed.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  if (parsed.error) {
    process.stderr.write(`settings.js: ${parsed.error}\n${HELP}`);
    process.exit(1);
  }

  try {
    let result;
    if (parsed.command === 'read') {
      result = read(parsed.treeRoot);
    } else {
      const text = fs.readFileSync(0, 'utf8');
      let patch;
      try {
        patch = JSON.parse(text);
      } catch (err) {
        throw new Error(`stdin did not carry valid JSON for the settings patch: ${err.message}`);
      }
      result = write(parsed.treeRoot, patch);
    }
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exit(0);
  } catch (err) {
    process.stderr.write(`settings.js: ${err.message}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = {
  read,
  write,
  clampDoc,
  validatePatch,
  SCHEMA,
  SETTINGS_BASENAME,
  REVIEW_FLOOR_LOCKED_VALUE,
};
