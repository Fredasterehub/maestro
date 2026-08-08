'use strict';

// maestro machine layer — capability preflight. Reporting, not gating: it
// probes the environment, records what it observed, and exits 0 whatever it
// found. Sole writer of ledger `kind:"preflight"` records and of
// state.json's `preflight` block.
//
// Every capability travels as a PAIR:
//   routing:  present | absent            (what the routing tables key off)
//   observed: present | absent | unknown  (what the probe actually measured)
// A probe that errors unexpectedly (timeout, signal, a binary that exists
// but crashes on --version) records observed:"unknown" and routes as absent
// — degraded routing, but the measured fact is never rounded down to a
// clean "absent" silently.

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { readJson, updateJson } = require('./atomic-json.js');
const { appendRecord } = require('./jsonl.js');

const MISSING_STATE = Symbol('preflight.missing-state');
const PROBE_TIMEOUT_MS = 15000;
// The live lane probe actually reaches the provider, so it gets its own,
// longer budget: a cold CLI start plus one trivial round trip.
const LANE_PROBE_TIMEOUT_MS = 60000;

// The lane classification vocabulary. Only "available" routes a lane up;
// the other three are all "that lane is down", distinguished so a reader
// (and the handoff) can tell a quota wall from a broken install.
const LANE_STATES = ['available', 'quota-limited', 'absent', 'failing'];

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Probes run argv-style (no shell): nothing here needs pipes, and skipping
// the shell makes "command not found" a clean ENOENT instead of an exit-127
// convention to decode.
function execProbe(bin, args) {
  const out = spawnSync(bin, args, { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS });
  const firstLine = typeof out.stdout === 'string' ? out.stdout.split('\n', 1)[0].trim() : '';
  return {
    cmd: [bin, ...args].join(' '),
    exit: out.status === null ? null : out.status,
    errorCode: out.error ? out.error.code || 'EUNKNOWN' : null,
    firstLine: firstLine.slice(0, 60),
  };
}

// Presence probe (e.g. `codex --version`): exit 0 is present, a missing
// binary is absent, and any OTHER outcome — nonzero exit, timeout, signal —
// is an installed-but-misbehaving tool: observed "unknown".
function observePresence(probe) {
  if (probe.errorCode === 'ENOENT') return 'absent';
  if (probe.errorCode !== null || probe.exit === null) return 'unknown';
  if (probe.exit === 0) return 'present';
  return 'unknown';
}

// Semantic probe (`codex login status`, `gh auth status`, `git rev-parse`):
// the exit code IS the check, so a clean nonzero exit is a measured "absent"
// (not authenticated / not a repo), not an unknown. Only a probe that could
// not run to a verdict (missing binary aside: timeout, signal, spawn error)
// is unknown.
function observeSemantic(probe) {
  if (probe.errorCode === 'ENOENT') return 'absent';
  if (probe.errorCode !== null || probe.exit === null) return 'unknown';
  return probe.exit === 0 ? 'present' : 'absent';
}

// The live probe needs the whole error text (that is where a quota wall
// announces itself), so it captures stdout+stderr rather than execProbe's
// one truncated line.
function execLaneProbe(bin, args) {
  const out = spawnSync(bin, args, { encoding: 'utf8', timeout: LANE_PROBE_TIMEOUT_MS });
  const text = `${typeof out.stdout === 'string' ? out.stdout : ''}\n${typeof out.stderr === 'string' ? out.stderr : ''}`.trim();
  return {
    cmd: [bin, ...args].join(' '),
    exit: out.status === null ? null : out.status,
    errorCode: out.error ? out.error.code || 'EUNKNOWN' : null,
    text,
  };
}

// A quota wall is a lane that exists and answers — it just refuses to work
// right now — so it must never be confused with a broken install. Every
// provider phrases it differently; these are the shapes seen in the wild
// plus the transport-level ones (HTTP 429, gRPC RESOURCE_EXHAUSTED).
const QUOTA_PATTERNS = [
  /usage limit/i,
  /\bquota\b/i,
  /rate[ -]?limit/i,
  /\b429\b/,
  /resource[_ ]exhausted/i,
  /too many requests/i,
];

// Best-effort only: providers state the reset in prose, in whatever format
// they like, and a wrong guess here is worse than no answer. The captured
// text is returned verbatim (never reformatted into a timestamp we cannot
// actually verify), and null means "the error named no reset time".
const RESET_PATTERNS = [
  /try again (?:at|after|on)\s+([^.\n]+)/i,
  /resets?\s+(?:at|on|in)\s+([^.\n]+)/i,
  /retry[ -]?after[:\s]+([^.\n]+)/i,
  /available again (?:at|on)\s+([^.\n]+)/i,
];

function parseQuotaReset(text) {
  for (const pattern of RESET_PATTERNS) {
    const match = pattern.exec(text);
    if (match) return match[1].trim().slice(0, 80);
  }
  return null;
}

// Classifies one live probe result. Exit 0 is the only route to
// "available": a lane is up when it actually completed a trivial job, not
// when its binary exists. ENOENT is "absent", quota text in any failing
// outcome is "quota-limited", and everything else — nonzero exit, timeout,
// signal, spawn error — is "failing".
function classifyLaneProbe(probe) {
  if (probe.errorCode === 'ENOENT') {
    return { state: 'absent', reset_at: null, detail: 'binary not found on PATH' };
  }
  if (probe.errorCode === null && probe.exit === 0) {
    return { state: 'available', reset_at: null, detail: null };
  }
  const text = probe.text || '';
  if (QUOTA_PATTERNS.some((pattern) => pattern.test(text))) {
    return { state: 'quota-limited', reset_at: parseQuotaReset(text), detail: text.slice(0, 200) };
  }
  const detail =
    probe.errorCode === 'ETIMEDOUT'
      ? `probe timed out after ${LANE_PROBE_TIMEOUT_MS / 1000}s`
      : probe.errorCode !== null
        ? `spawn error ${probe.errorCode}`
        : `exit ${probe.exit}${text === '' ? '' : `: ${text.slice(0, 200)}`}`;
  return { state: 'failing', reset_at: null, detail };
}

// The one live probe, shared by both external lanes: a minimal, cheap,
// read-only job whose only question is "does this lane do work right now".
// It never throws — an unreachable lane is a classification, not an error,
// and preflight as a whole must still exit 0.
const LANE_PROBES = {
  codex: ['codex', ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', 'ok']],
  gemini: ['gemini', ['-p', 'ok']],
};

function probeLane(laneKey) {
  const [bin, args] = LANE_PROBES[laneKey];
  let probe;
  try {
    probe = execLaneProbe(bin, args);
  } catch (err) {
    probe = { cmd: [bin, ...args].join(' '), exit: null, errorCode: err.code || 'EUNKNOWN', text: '' };
  }
  return { ...classifyLaneProbe(probe), cmd: probe.cmd };
}

function pairFrom(observed) {
  // unknown routes as absent but is reported as unknown, never rounded down.
  return { routing: observed === 'present' ? 'present' : 'absent', observed };
}

// Design §11.1: exact model x effort capability, per provider. Keys are the
// model ids this repository's own roster already names for that provider
// (design §6.1/§11.1) — used only as map keys, never as evidence of status.
// `status` is 'present'/'absent' only when a current authenticated
// discovery surface this repository already supports actually reported it;
// it is never inferred from a model name, from the provider CLI being
// installed or authenticated, or from this very roster. No such per-model
// discovery surface exists in this repository today (the codex/gemini/
// antigravity probes above measure CLI presence and, for codex, login
// status — never a model catalog), so every entry below stays 'unknown'
// with no proven efforts until one is added; that is a passing, honest
// result for this step, not a gap. `unknown` extends the same tri-state
// discipline as the routing/observed pair: it routes as unavailable but is
// never rewritten to 'absent' or 'present'.
const PROVIDER_MODEL_IDS = {
  codex: ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol'],
  gemini: ['gemini-3.1-pro-preview'],
  antigravity: [],
};

function buildModelsMap(providerKey) {
  const models = {};
  for (const modelId of PROVIDER_MODEL_IDS[providerKey] || []) {
    models[modelId] = { status: 'unknown', efforts: [] };
  }
  return models;
}

function probeNode() {
  const version = execProbe('node', ['--version']);
  const observed = observePresence(version);
  return { ...pairFrom(observed), version: observed === 'present' ? version.firstLine : null, checks: { version } };
}

// The lane a presence probe never got far enough to test: a missing binary
// is an absent lane, and an installed binary that misbehaved is a failing
// one. Recorded rather than probed, so the state is always populated.
function laneFromPresence(observed, why) {
  return observed === 'absent'
    ? { state: 'absent', reset_at: null, detail: why, cmd: null }
    : { state: 'failing', reset_at: null, detail: why, cmd: null };
}

// The lane state IS the routing token for a probed lane: anything but
// "available" routes as down. `observed` keeps measuring what the presence
// probes saw, so an installed, authenticated, quota-walled CLI still reads
// "present" as a measurement while routing away from it.
function lanePair(lane, observed) {
  return { routing: lane.state === 'available' ? 'present' : 'absent', observed };
}

function probeCodex() {
  const version = execProbe('codex', ['--version']);
  const versionObserved = observePresence(version);
  const models = buildModelsMap('codex');
  if (versionObserved !== 'present') {
    // auth: null means NOT COMPUTED — the auth check never ran, which is a
    // different recorded fact from "ran and failed".
    const lane = laneFromPresence(versionObserved, 'codex --version did not report a working CLI');
    return { ...lanePair(lane, versionObserved), version: null, checks: { version, auth: null }, lane, models };
  }
  const auth = execProbe('codex', ['login', 'status']);
  const observed = observeSemantic(auth);
  const lane = observed === 'present' ? probeLane('codex') : laneFromPresence('failing', 'codex login status reported not authenticated');
  return { ...lanePair(lane, observed), version: version.firstLine, checks: { version, auth }, lane, models };
}

function probeGemini() {
  const version = execProbe('gemini', ['--version']);
  const observed = observePresence(version);
  const lane = observed === 'present' ? probeLane('gemini') : laneFromPresence(observed, 'gemini --version did not report a working CLI');
  return {
    ...lanePair(lane, observed),
    version: observed === 'present' ? version.firstLine : null,
    checks: { version },
    lane,
    models: buildModelsMap('gemini'),
  };
}

// Antigravity is its own capability pair, probed the same presence-only way
// as gemini — it is not folded into the gemini pair, so a gemini/antigravity
// split (one present, the other not) is never rounded away.
function probeAntigravity() {
  const version = execProbe('antigravity', ['--version']);
  const observed = observePresence(version);
  return {
    ...pairFrom(observed),
    version: observed === 'present' ? version.firstLine : null,
    checks: { version },
    models: buildModelsMap('antigravity'),
  };
}

function probeGit(projectDir) {
  const repo = execProbe('git', ['-C', projectDir, 'rev-parse', '--is-inside-work-tree']);
  const observed = observeSemantic(repo);
  return { ...pairFrom(observed), checks: { repo } };
}

function probeGh() {
  const auth = execProbe('gh', ['auth', 'status']);
  const observed = observeSemantic(auth);
  return { ...pairFrom(observed), checks: { auth } };
}

// run(treeRoot) — treeRoot is the `.maestro` directory of an already
// scaffolded tree. Probes, appends the ledger evidence record, then updates
// state.json.preflight inside the state file's own lock. Returns the
// preflight block written.
function run(treeRoot) {
  if (typeof treeRoot !== 'string' || treeRoot === '') {
    throw new TypeError('preflight: treeRoot must be a non-empty string');
  }
  const root = path.resolve(treeRoot);
  const statePath = path.join(root, 'state.json');
  const ledgerPath = path.join(root, 'ledger.jsonl');

  // Advisory precheck only — the read that decides what gets written happens
  // fresh inside updateJson's lock below.
  const precheck = readJson(statePath, MISSING_STATE);
  if (precheck === MISSING_STATE) {
    throw new Error(`preflight: no state.json at ${statePath} — scaffold the tree first`);
  }
  if (!isPlainObject(precheck)) {
    throw new Error(`preflight: state at ${statePath} must be a JSON object`);
  }

  const codex = probeCodex();
  const gemini = probeGemini();
  const antigravity = probeAntigravity();
  const block = {
    checked_ts: new Date().toISOString(),
    node: probeNode(),
    providers: { codex, gemini, antigravity },
    // The bare routing surface routing.js keys degraded modes off — the
    // same pairs as providers.*, without the probe detail, plus the exact
    // model x effort map (design §11.1) so a future consumer never has to
    // distinguish "no map" from "empty map" for any probed provider.
    per_provider: {
      codex: { routing: codex.routing, observed: codex.observed, lane: codex.lane, models: codex.models },
      gemini: { routing: gemini.routing, observed: gemini.observed, lane: gemini.lane, models: gemini.models },
      antigravity: { routing: antigravity.routing, observed: antigravity.observed, models: antigravity.models },
    },
    // The project is the tree root's parent.
    git: probeGit(path.dirname(root)),
    gh: probeGh(),
  };

  // Ledger first (evidence), state second (pointer): a crash between the two
  // leaves evidence without a pointer, never a pointer without evidence.
  const summarize = (p) => ({ routing: p.routing, observed: p.observed });
  // A lane's classification and its reset time are the two facts a reader of
  // the ledger needs to explain a rerouted dispatch, so they travel with the
  // pair rather than only in state.json.
  const summarizeLane = (p) => ({ ...summarize(p), lane: p.lane.state, lane_reset_at: p.lane.reset_at });
  appendRecord(ledgerPath, {
    kind: 'preflight',
    payload: {
      node: summarize(block.node),
      codex: summarizeLane(block.providers.codex),
      gemini: summarizeLane(block.providers.gemini),
      antigravity: summarize(block.providers.antigravity),
      git: summarize(block.git),
      gh: summarize(block.gh),
    },
    correlation_id: 'preflight',
  });

  updateJson(
    statePath,
    (state) => {
      if (state === MISSING_STATE || !isPlainObject(state)) {
        throw new Error(`preflight: state at ${statePath} must be a JSON object`);
      }
      return { ...state, preflight: block };
    },
    MISSING_STATE
  );

  return block;
}

function describe(name, cap, extra) {
  const measured =
    cap.observed === cap.routing || cap.observed === 'present'
      ? cap.observed
      : `${cap.observed} (routes as ${cap.routing})`;
  return `  ${name.padEnd(7)} ${measured}${extra ? ` — ${extra}` : ''}\n`;
}

// One line per tracked model id, e.g. "gpt-5.6-luna:unknown[]" — printed
// even when every entry is unknown, so the exact-capability shape is visible
// in the human-readable summary the same way it is in state.json, and an
// empty map (a provider with no tracked model id) prints its own explicit
// marker rather than silently vanishing.
function describeModels(models) {
  const entries = Object.entries(models);
  if (entries.length === 0) return '(no tracked models)';
  return entries.map(([id, m]) => `${id}:${m.status}[${m.efforts.join(',')}]`).join(', ');
}

function describeLane(lane) {
  const parts = [lane.reset_at === null ? null : `resets ${lane.reset_at}`, lane.detail].filter((p) => p !== null && p !== '');
  return `    lane: ${lane.state}${parts.length === 0 ? '' : ` — ${parts.join('; ')}`}\n`;
}

function renderSummary(block) {
  let out = `preflight @ ${block.checked_ts}\n`;
  out += describe('node', block.node, block.node.version);
  const codex = block.providers.codex;
  const codexExtra =
    codex.observed === 'present'
      ? `${codex.version}, authenticated`
      : codex.checks.auth === null
        ? null
        : codex.observed === 'absent'
          ? 'CLI present, not authenticated'
          : 'CLI present, auth check inconclusive';
  out += describe('codex', codex, codexExtra);
  out += describeLane(codex.lane);
  out += `    models: ${describeModels(codex.models)}\n`;
  const antigravity = block.providers.antigravity;
  // The gemini seat's routing prefers antigravity over the gemini CLI when
  // antigravity's routing token reads "present" — recorded here so the
  // preference is visible without gating anything; the actual CLI selection
  // is made in the agent's own prose.
  const geminiExtra = [
    block.providers.gemini.version,
    antigravity.routing === 'present' ? 'gemini seat routing prefers antigravity' : null,
  ]
    .filter((part) => part !== null)
    .join(', ');
  out += describe('gemini', block.providers.gemini, geminiExtra === '' ? null : geminiExtra);
  out += describeLane(block.providers.gemini.lane);
  out += `    models: ${describeModels(block.providers.gemini.models)}\n`;
  out += describe('antigravity', antigravity, antigravity.version);
  out += `    models: ${describeModels(antigravity.models)}\n`;
  out += describe('git', block.git, block.git.observed === 'present' ? 'inside a work tree' : null);
  out += describe('gh', block.gh, block.gh.observed === 'present' ? 'authenticated' : null);
  return out;
}

const HELP = `preflight.js — maestro capability preflight

usage: preflight.js run <treeRoot>

<treeRoot> is the .maestro directory of an already scaffolded tree.

Probes (argv-style subprocesses, ${PROBE_TIMEOUT_MS / 1000}s timeout each):
  node         node --version
  codex        codex --version, then codex login status (exit code IS the check),
               then the LIVE lane probe below
  gemini       gemini --version, then the LIVE lane probe below
  antigravity  antigravity --version — its own capability pair, never folded
               into gemini's; the gemini seat's routing prefers antigravity
               over the gemini CLI when antigravity's token reads "present"
               (recorded in the printed summary; the actual CLI selection is
               made in the agent's own prose, not here)
  git          git -C <project> rev-parse --is-inside-work-tree
  gh           gh auth status

Each capability is recorded as the pair { routing: present|absent,
observed: present|absent|unknown }: a probe that errors unexpectedly
(timeout, signal, crash) is observed "unknown" and routes as absent —
degraded, but never silently rounded down to a measured absence.

codex and gemini additionally carry a LIVE lane probe: one minimal, cheap,
read-only job (codex exec --skip-git-repo-check --sandbox read-only, gemini
-p) with a ${LANE_PROBE_TIMEOUT_MS / 1000}s timeout, recorded as
lane: { state, reset_at, detail, cmd } with state one of
${LANE_STATES.join(' | ')}. Only "available" — the probe actually completed
a trivial job — routes the lane up; a quota wall reads "quota-limited" and
carries the reset time when the provider's error text states one (best
effort, verbatim, null when it does not); a missing binary is "absent"; and
any other outcome (nonzero exit, timeout, signal) is "failing". The lane
state IS the routing token: routing reads "present" only for "available",
so an installed, authenticated, quota-walled CLI still measures
observed "present" while routing away from it. An unreachable lane is a
classification, never an error — it can never fail preflight as a whole.

codex, gemini, and antigravity additionally carry an exact model x effort
capability map: models: { <model-id>: { status: present|absent|unknown,
efforts: [...] } }, one entry per model id this repository's own roster
tracks for that provider (empty map for a provider with no tracked model
id — never absent as a key, so a consumer never has to tell "no map" apart
from "empty map"). status is present/absent only when a current
authenticated discovery surface this repository already supports actually
reported it — never inferred from a model name, an installed CLI, or the
roster itself. No such per-model discovery surface exists in this repository
today, so every entry ships "unknown" with efforts: [] — unknown extends the
same tri-state discipline as routing/observed: it routes as unavailable but
is never rewritten to "absent" or "present".

Writes state.json.preflight { checked_ts, node,
providers: { codex, gemini, antigravity } (each with checks, version, and
models), per_provider (the bare routing pairs routing.js keys degraded modes
off, plus models), git, gh } and appends one ledger record of kind
"preflight" (this script is the sole writer of both). Prints a
human-readable summary, including each tracked model's status and efforts.

Exit 0 always when the tree exists — preflight reports, it does not gate.
Exit 1 only for usage errors or a missing/unscaffolded tree.
`;

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  const [command, treeRoot, ...rest] = argv;
  if (command !== 'run' || !treeRoot || rest.length > 0) {
    const reason =
      rest.length > 0
        ? `unexpected extra argument(s): ${rest.join(' ')}`
        : command !== 'run'
          ? `unknown command ${JSON.stringify(command)} (expected run)`
          : '<treeRoot> is required';
    process.stderr.write(`preflight.js: ${reason}\n${HELP}`);
    process.exit(1);
  }
  try {
    const block = run(treeRoot);
    process.stdout.write(renderSummary(block));
    process.exit(0);
  } catch (err) {
    process.stderr.write(`preflight.js: ${err.message}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = { run, PROBE_TIMEOUT_MS, LANE_PROBE_TIMEOUT_MS, LANE_STATES, classifyLaneProbe, parseQuotaReset, PROVIDER_MODEL_IDS };
