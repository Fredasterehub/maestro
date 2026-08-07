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

function probeCodex() {
  const version = execProbe('codex', ['--version']);
  const versionObserved = observePresence(version);
  const models = buildModelsMap('codex');
  if (versionObserved !== 'present') {
    // auth: null means NOT COMPUTED — the auth check never ran, which is a
    // different recorded fact from "ran and failed".
    return { ...pairFrom(versionObserved), version: null, checks: { version, auth: null }, models };
  }
  const auth = execProbe('codex', ['login', 'status']);
  const observed = observeSemantic(auth);
  return { ...pairFrom(observed), version: version.firstLine, checks: { version, auth }, models };
}

function probeGemini() {
  const version = execProbe('gemini', ['--version']);
  const observed = observePresence(version);
  return {
    ...pairFrom(observed),
    version: observed === 'present' ? version.firstLine : null,
    checks: { version },
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
      codex: { routing: codex.routing, observed: codex.observed, models: codex.models },
      gemini: { routing: gemini.routing, observed: gemini.observed, models: gemini.models },
      antigravity: { routing: antigravity.routing, observed: antigravity.observed, models: antigravity.models },
    },
    // The project is the tree root's parent.
    git: probeGit(path.dirname(root)),
    gh: probeGh(),
  };

  // Ledger first (evidence), state second (pointer): a crash between the two
  // leaves evidence without a pointer, never a pointer without evidence.
  const summarize = (p) => ({ routing: p.routing, observed: p.observed });
  appendRecord(ledgerPath, {
    kind: 'preflight',
    payload: {
      node: summarize(block.node),
      codex: summarize(block.providers.codex),
      gemini: summarize(block.providers.gemini),
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
  codex        codex --version, then codex login status (exit code IS the check)
  gemini       gemini --version
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

module.exports = { run, PROBE_TIMEOUT_MS, PROVIDER_MODEL_IDS };
