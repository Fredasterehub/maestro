'use strict';

// maestro machine layer — bounded projections. `project.js views <treeRoot>`
// renders the four views/ files that are the ONLY surfaces the liaison
// reads: fleet.md, missions.md, holds.md, recent.md. Sole writer of views/.
//
// Every view is capped at 60 lines; anything cut is noted with counts, so a
// truncated view never masquerades as a complete one. Malformed inputs
// (missing files, unparseable records, unexpected shapes) are noted inside
// the view, never thrown — a projection must always render.

const fs = require('node:fs');
const path = require('node:path');

const { readRecords } = require('./jsonl.js');
const { readJson } = require('./atomic-json.js');
const { writeText } = require('./atomic-text.js');
const { openHolds } = require('./hold.js');

const VIEW_LINE_CEILING = 60;
const RECENT_EVENT_COUNT = 15;
const MISSING = Symbol('project.missing');

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// One display line: no newlines (a record must never forge extra view
// lines), bounded length so views stay byte-bounded, not just line-bounded.
function oneLine(text, max = 160) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// Assembles a view from header lines + entry lines under the 60-line
// ceiling. When entries overflow the budget, the tail is cut and the last
// line states exactly how many of how many are shown.
function renderCapped(headerLines, entryLines, noun) {
  const budget = VIEW_LINE_CEILING - headerLines.length;
  if (entryLines.length <= budget) {
    return [...headerLines, ...entryLines].join('\n') + '\n';
  }
  const shown = entryLines.slice(0, budget - 1);
  const note = `(truncated: showing ${shown.length} of ${entryLines.length} ${noun})`;
  return [...headerLines, ...shown, note].join('\n') + '\n';
}

// --- fleet.md ---------------------------------------------------------------

const ROSTER_STATUS_ORDER = ['alive', 'zombie', 'dead', 'finished'];

function rosterEntries(roster) {
  if (Array.isArray(roster)) return { entries: roster, note: null };
  if (isPlainObject(roster)) {
    for (const key of ['entries', 'seats', 'fleet']) {
      if (Array.isArray(roster[key])) return { entries: roster[key], note: null };
    }
  }
  return { entries: [], note: 'roster.json has an unrecognized shape; nothing to render.' };
}

function renderFleet(treeRoot, nowIso) {
  const roster = readJson(path.join(treeRoot, 'roster.json'), MISSING);
  const header = ['# Fleet', '', `Roster by status, rendered ${nowIso} from roster.json.`, ''];

  if (roster === MISSING) {
    return [...header, 'No roster recorded.'].join('\n') + '\n';
  }
  const { entries, note } = rosterEntries(roster);
  if (note) {
    return [...header, note].join('\n') + '\n';
  }
  if (entries.length === 0) {
    return [...header, 'Roster is empty.'].join('\n') + '\n';
  }

  const byStatus = new Map();
  for (const entry of entries) {
    const status = isPlainObject(entry) && typeof entry.status === 'string' ? entry.status : 'unknown';
    if (!byStatus.has(status)) byStatus.set(status, []);
    byStatus.get(status).push(entry);
  }
  const statuses = [
    ...ROSTER_STATUS_ORDER.filter((s) => byStatus.has(s)),
    ...[...byStatus.keys()].filter((s) => !ROSTER_STATUS_ORDER.includes(s)).sort(),
  ];

  const lines = [];
  for (const status of statuses) {
    const group = byStatus.get(status);
    lines.push(`## ${status} (${group.length})`);
    for (const entry of group) {
      if (!isPlainObject(entry)) {
        lines.push(oneLine(`- (malformed roster entry: ${JSON.stringify(entry)})`));
        continue;
      }
      const parts = [`- ${entry.seat || '(unnamed seat)'}`];
      if (entry.family) parts.push(`family=${entry.family}`);
      if (entry.task_id) parts.push(`task=${entry.task_id}`);
      if (entry.last_seen) parts.push(`last_seen=${entry.last_seen}`);
      lines.push(oneLine(parts.join('  ')));
    }
  }
  return renderCapped(header, lines, 'roster lines');
}

// --- missions.md ------------------------------------------------------------

function lastCheckpointStep(treeRoot, missionId) {
  const file = path.join(treeRoot, 'missions', missionId, 'progress.jsonl');
  let records;
  try {
    records = readRecords(file).records;
  } catch {
    return null;
  }
  for (let i = records.length - 1; i >= 0; i--) {
    const rec = records[i];
    if (isPlainObject(rec) && rec.kind !== 'genesis' && typeof rec.step === 'string' && rec.step !== '') {
      return rec.step;
    }
  }
  return null;
}

function envelopeCount(treeRoot, missionId) {
  try {
    return fs.readdirSync(path.join(treeRoot, 'missions', missionId, 'envelopes')).length;
  } catch {
    return 0;
  }
}

function renderMissions(treeRoot, nowIso) {
  const state = readJson(path.join(treeRoot, 'state.json'), MISSING);
  const header = ['# Missions', '', `Open missions, rendered ${nowIso} from state.json.`, ''];

  if (state === MISSING || !isPlainObject(state)) {
    return [...header, 'state.json is missing or unreadable.'].join('\n') + '\n';
  }
  const missions = isPlainObject(state.missions) ? state.missions : {};
  const open = Object.entries(missions).filter(
    ([, m]) => !isPlainObject(m) || m.status !== 'done'
  );
  if (open.length === 0) {
    return [...header, 'No open missions.'].join('\n') + '\n';
  }

  const lines = open.map(([id, m]) => {
    const status = isPlainObject(m) && typeof m.status === 'string' ? m.status : 'unknown';
    const nextAction = isPlainObject(m) && typeof m.next_action === 'string' ? m.next_action : '(none)';
    const step = lastCheckpointStep(treeRoot, id);
    const active = state.active_mission === id ? ' *active*' : '';
    return oneLine(
      `- ${id} [${status}]${active}  next: ${nextAction}  |  last checkpoint: ${step || '(none)'}  |  envelopes: ${envelopeCount(treeRoot, id)}`
    );
  });
  return renderCapped(header, lines, 'open missions');
}

// --- holds.md ---------------------------------------------------------------

// "Open" is hold.js's openHolds() — the one shared definition (a park
// record no resolve record's park_seq references), so this view can never
// disagree with the stream's own writer about what is still open.
function renderHolds(treeRoot, nowIso) {
  const header = ['# Holds', '', `Open holds, oldest first, rendered ${nowIso} from holds.jsonl.`, ''];
  let open;
  let readErrors = 0;
  try {
    open = openHolds(treeRoot);
    readErrors = readRecords(path.join(treeRoot, 'holds.jsonl')).errors.length;
  } catch (err) {
    return [...header, `holds.jsonl is unreadable: ${oneLine(err.message)}`].join('\n') + '\n';
  }

  const footnotes = [];
  if (readErrors > 0) footnotes.push(`(${readErrors} unparseable line(s) skipped)`);

  if (open.length === 0) {
    return [...header, 'No open holds.', ...footnotes].join('\n') + '\n';
  }

  const lines = open.map((p) => {
    const parts = [`- seq=${p.seq}`];
    if (p.severity) parts.push(String(p.severity));
    parts.push(typeof p.summary === 'string' && p.summary !== '' ? p.summary : '(no summary)');
    if (p.owner_mission) parts.push(`mission=${p.owner_mission}`);
    if (p.ts) parts.push(`parked=${p.ts}`);
    return oneLine(parts.join('  '));
  });
  return renderCapped(header, [...lines, ...footnotes], 'open holds');
}

// --- recent.md --------------------------------------------------------------

function summarizeEvent(rec) {
  if (!isPlainObject(rec)) return '(unparseable record)';
  const kind = typeof rec.kind === 'string' ? rec.kind : '(no kind)';
  switch (kind) {
    case 'genesis':
      return 'stream established';
    case 'gate':
      return `gate_id=${rec.gate_id ?? '?'} exit=${rec.exit_code ?? '?'}`;
    case 'preflight': {
      const caps = ['node', 'codex', 'gemini', 'git', 'gh']
        .filter((k) => isPlainObject(rec[k]))
        .map((k) => `${k}=${rec[k].observed}`);
      return caps.length > 0 ? caps.join(' ') : 'environment probed';
    }
    case 'stop':
      return `${rec.stop_state ?? '?'} by ${rec.reporter ?? '?'}`;
    case 'deviation':
      return `${rec.reported_by ?? '?'}: ${rec.summary ?? ''}`;
    default: {
      // Generic fallback: the payload minus the common header, compactly.
      const payload = {};
      for (const [key, value] of Object.entries(rec)) {
        if (!['schema_version', 'seq', 'kind', 'ts', 'correlation_id'].includes(key)) {
          payload[key] = value;
        }
      }
      const keys = Object.keys(payload);
      if (keys.length === 0) return rec.correlation_id ? `re: ${rec.correlation_id}` : '(no payload)';
      try {
        return JSON.stringify(payload);
      } catch {
        return `fields: ${keys.join(', ')}`;
      }
    }
  }
}

function renderRecent(treeRoot, nowIso) {
  const header = [
    '# Recent events',
    '',
    'Event history, not current state — read state.json (via the digest) for where things stand.',
    '',
  ];
  let read;
  try {
    read = readRecords(path.join(treeRoot, 'ledger.jsonl'));
  } catch (err) {
    return [...header, `ledger.jsonl is unreadable: ${oneLine(err.message)}`].join('\n') + '\n';
  }

  const total = read.records.length;
  if (total === 0) {
    return [...header, 'Ledger has no records — the tree was never scaffolded correctly.'].join('\n') + '\n';
  }
  const tail = read.records.slice(-RECENT_EVENT_COUNT);
  const lines = [`Last ${tail.length} of ${total} ledger record(s), rendered ${nowIso}:`, ''];
  for (const rec of tail) {
    const seq = isPlainObject(rec) && Number.isSafeInteger(rec.seq) ? rec.seq : '?';
    const kind = isPlainObject(rec) && typeof rec.kind === 'string' ? rec.kind : '?';
    const ts = isPlainObject(rec) && typeof rec.ts === 'string' ? rec.ts : '?';
    lines.push(oneLine(`- ${seq}  ${kind}  ${ts}  ${summarizeEvent(rec)}`));
  }
  if (read.errors.length > 0) {
    lines.push(`(${read.errors.length} unparseable ledger line(s) skipped)`);
  }
  return renderCapped(header, lines, 'event lines');
}

// --- entry ------------------------------------------------------------------

// renderViews(treeRoot) — writes the four views atomically and returns their
// paths. Requires a scaffolded tree (state.json present).
function renderViews(treeRoot) {
  if (typeof treeRoot !== 'string' || treeRoot === '') {
    throw new TypeError('project: treeRoot must be a non-empty string');
  }
  const root = path.resolve(treeRoot);
  if (readJson(path.join(root, 'state.json'), MISSING) === MISSING) {
    throw new Error(`project: no state.json at ${path.join(root, 'state.json')} — scaffold the tree first`);
  }

  const nowIso = new Date().toISOString();
  const views = {
    'fleet.md': renderFleet(root, nowIso),
    'missions.md': renderMissions(root, nowIso),
    'holds.md': renderHolds(root, nowIso),
    'recent.md': renderRecent(root, nowIso),
  };

  const written = [];
  for (const [name, content] of Object.entries(views)) {
    const file = path.join(root, 'views', name);
    writeText(file, content);
    written.push(file);
  }
  return { written };
}

const HELP = `project.js — maestro bounded projections

usage: project.js views <treeRoot>

<treeRoot> is the .maestro directory of an already scaffolded tree.

Renders the four bounded views into <treeRoot>/views/ — the ONLY surfaces
the liaison reads (this script is views/'s sole writer):

  fleet.md      roster by status, one line per seat
  missions.md   open missions: status, next_action, last checkpoint step,
                envelope count
  holds.md      open (unresolved) holds, oldest first
  recent.md     last ${RECENT_EVENT_COUNT} ledger events — explicitly event history, not
                current state

Every view is capped at ${VIEW_LINE_CEILING} lines; truncation is noted with shown/total
counts. Malformed inputs are noted inside the view, never thrown.
`;

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  const [command, treeRoot, ...rest] = argv;
  if (command !== 'views' || !treeRoot || rest.length > 0) {
    const reason =
      rest.length > 0
        ? `unexpected extra argument(s): ${rest.join(' ')}`
        : command !== 'views'
          ? `unknown command ${JSON.stringify(command)} (expected views)`
          : '<treeRoot> is required';
    process.stderr.write(`project.js: ${reason}\n${HELP}`);
    process.exit(1);
  }
  try {
    const { written } = renderViews(treeRoot);
    for (const file of written) process.stdout.write(`${file}\n`);
  } catch (err) {
    process.stderr.write(`project.js: ${err.message}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = { renderViews, VIEW_LINE_CEILING, RECENT_EVENT_COUNT };
