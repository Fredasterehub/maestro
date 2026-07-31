'use strict';

// maestro machine layer — genesis scaffolder, the one sanctioned home for
// `.maestro/` tree-shape knowledge. Every other module treats paths as
// parameters; the SHAPE of the genesis skeleton lives here and nowhere else.
//
// Sole writer of ledger/holds `kind:"genesis"` records, state.json genesis,
// and handoff.md's genesis stub; routing/ and settings.json genesis run
// through their own sole writers (routing.js init, settings.js write).
// Streams are genesis-seeded so "never ran" (file absent) stays
// distinguishable from "ran and empty" (file present, one genesis record).
//
// Genesis is ATOMIC: the whole tree is built in a temp sibling directory and
// renamed into place in one step, so a crash mid-scaffold can never leave a
// half-tree that later runs mistake for a real one. Re-scaffolding an
// existing tree is refused (prints "exists", exit 0) — never clobbers.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { appendRecord } = require('./jsonl.js');
const { writeJson } = require('./atomic-json.js');
const { writeText } = require('./atomic-text.js');
// routing.js is the sole writer of routing/* and settings.js of
// settings.json; genesis delegates both rather than keeping second copies
// of the default table or the knob schema here.
const routing = require('./routing.js');
const settings = require('./settings.js');

const GENESIS_HANDOFF =
  '# Handoff\n' +
  '\n' +
  'No stop has been recorded yet. This file is a mechanical projection of\n' +
  'recorded events — no event, no line — rewritten by the stop recorder at\n' +
  "every recorded stop; the first real render happens at this project's\n" +
  'first stop.\n';

// ensureGitignore(projectRoot, treeBasename) — after genesis, the project's
// .gitignore ignores the tree (DECISIONS.md: mission state is local
// operational data; versioning it is an explicit opt-in). Append-if-missing,
// never duplicated; runs only on genesis, so a line the operator later
// removes deliberately stays removed. Returns { action, path } with action
// "created" | "appended" | "present".
function ensureGitignore(projectRoot, treeBasename) {
  const file = path.join(projectRoot, '.gitignore');
  const line = `${treeBasename}/`;

  let current = null;
  try {
    current = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  if (current === null) {
    writeText(file, `${line}\n`);
    return { action: 'created', path: file };
  }

  const covered = current.split('\n').some((l) => {
    const t = l.trim();
    return t === line || t === treeBasename;
  });
  if (covered) return { action: 'present', path: file };

  const sep = current === '' || current.endsWith('\n') ? '' : '\n';
  writeText(file, `${current}${sep}${line}\n`);
  return { action: 'appended', path: file };
}

// scaffoldTree(treeRoot) — treeRoot is the `.maestro` directory itself
// (e.g. /my/project/.maestro). Returns { exists: true } when the tree is
// already there, else { created: [paths relative to treeRoot], gitignore }.
function scaffoldTree(treeRoot) {
  if (typeof treeRoot !== 'string' || treeRoot === '') {
    throw new TypeError('scaffold: treeRoot must be a non-empty string');
  }
  const root = path.resolve(treeRoot);

  let existing = null;
  try {
    existing = fs.lstatSync(root);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (existing !== null) {
    if (!existing.isDirectory()) {
      throw new Error(`scaffold: ${root} exists and is not a directory`);
    }
    return { exists: true };
  }

  const parent = path.dirname(root);
  fs.mkdirSync(parent, { recursive: true });

  // Build the full tree in a temp sibling, then rename into place: genesis
  // either fully happens or leaves nothing behind.
  const stage = path.join(
    parent,
    `.${path.basename(root)}.genesis-${process.pid}-${crypto.randomBytes(8).toString('hex')}`
  );
  fs.mkdirSync(stage);

  const created = [];
  const track = (rel) => created.push(rel);

  try {
    for (const dir of ['missions', 'routing', 'views']) {
      fs.mkdirSync(path.join(stage, dir));
      track(dir);
    }

    const now = new Date();

    // state.json — THE resume pointer. Missions are a flat concurrent set;
    // no phase field by design.
    writeJson(path.join(stage, 'state.json'), {
      schema_version: 1,
      created_ts: now.toISOString(),
      missions: {},
      active_mission: null,
      preflight: null,
      last_stop: null,
    });
    track('state.json');

    // Genesis-seeded streams: one kind:"genesis" record each.
    appendRecord(path.join(stage, 'ledger.jsonl'), { kind: 'genesis', payload: {}, correlation_id: null });
    track('ledger.jsonl');
    appendRecord(path.join(stage, 'holds.jsonl'), { kind: 'genesis', payload: {}, correlation_id: null });
    track('holds.jsonl');

    // Empty patch through settings.js's own write path = the schema's pure
    // defaults, clamped by their sole sanctioned writer.
    settings.write(stage, {});
    track('settings.json');

    // routing/ — routing.js writes the immutable dated default config and
    // its digest pointer (rollback later is repoint-elsewhere, never
    // rewrite; routing.js owns every routing/ write from here on).
    const { active_config } = routing.init(stage);
    track(path.join('routing', active_config));
    track(path.join('routing', 'active.json'));

    writeText(path.join(stage, 'handoff.md'), GENESIS_HANDOFF);
    track('handoff.md');

    try {
      fs.renameSync(stage, root);
    } catch (err) {
      // Another scaffold won the race between our existence check and this
      // rename; the tree that exists is theirs, untouched.
      if (err.code === 'ENOTEMPTY' || err.code === 'EEXIST' || err.code === 'EPERM') {
        let nowThere = null;
        try {
          nowThere = fs.lstatSync(root);
        } catch {
          nowThere = null;
        }
        if (nowThere !== null && nowThere.isDirectory()) {
          return { exists: true };
        }
      }
      throw err;
    }
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }

  return { created, gitignore: ensureGitignore(parent, path.basename(root)) };
}

const HELP = `scaffold.js — maestro genesis scaffolder

usage: scaffold.js <treeRoot>

<treeRoot> is the .maestro directory itself (e.g. /my/project/.maestro).

Creates the genesis tree atomically (staged in a temp sibling directory,
renamed into place):

  state.json      resume pointer: { schema_version: 1, created_ts,
                  missions: {}, active_mission: null, preflight: null,
                  last_stop: null }
  ledger.jsonl    genesis-seeded evidence stream (one kind:"genesis" record,
                  so "never ran" stays distinguishable from "ran and empty")
  holds.jsonl     genesis-seeded decision-hold stream
  settings.json   schema defaults (seeded via settings.js, its sole writer)
  routing/        dated immutable routing config + active.json digest
                  pointer (seeded via routing.js init, its sole writer)
  missions/       empty
  views/          empty (project.js renders projections here)
  handoff.md      mechanical genesis stub (no event, no line)

After genesis it also makes the project's .gitignore (in <treeRoot>'s parent)
ignore the tree: appends ".maestro/" when the line is missing, creates
.gitignore when the project has none, never duplicates an existing line
(".maestro" and ".maestro/" both count as present). Mission state is local
operational data; versioning it is an explicit opt-in.

Idempotent: if <treeRoot> already exists, prints "exists" and exits 0 —
an existing tree is never clobbered. Exits 1 only on a real error (e.g.
<treeRoot> exists but is a file).

This script is the sole writer of the genesis records and files above.
`;

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  const [treeRoot, ...rest] = argv;
  if (!treeRoot || rest.length > 0) {
    process.stderr.write(
      rest.length > 0
        ? `scaffold.js: unexpected extra argument(s): ${rest.join(' ')}\n${HELP}`
        : `scaffold.js: <treeRoot> is required\n${HELP}`
    );
    process.exit(1);
  }
  try {
    const result = scaffoldTree(treeRoot);
    if (result.exists) {
      process.stdout.write('exists\n');
      process.exit(0);
    }
    for (const rel of result.created) {
      process.stdout.write(`${path.join(path.resolve(treeRoot), rel)}\n`);
    }
    if (result.gitignore.action !== 'present') {
      process.stdout.write(`${result.gitignore.path}\n`);
    }
  } catch (err) {
    process.stderr.write(`scaffold.js: ${err.message}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = { scaffoldTree };
