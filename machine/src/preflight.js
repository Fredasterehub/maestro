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

function probeNode() {
  const version = execProbe('node', ['--version']);
  const observed = observePresence(version);
  return { ...pairFrom(observed), version: observed === 'present' ? version.firstLine : null, checks: { version } };
}

function probeCodex() {
  const version = execProbe('codex', ['--version']);
  const versionObserved = observePresence(version);
  if (versionObserved !== 'present') {
    // auth: null means NOT COMPUTED — the auth check never ran, which is a
    // different recorded fact from "ran and failed".
    return { ...pairFrom(versionObserved), version: null, checks: { version, auth: null } };
  }
  const auth = execProbe('codex', ['login', 'status']);
  const observed = observeSemantic(auth);
  return { ...pairFrom(observed), version: version.firstLine, checks: { version, auth } };
}

function probeGemini() {
  const version = execProbe('gemini', ['--version']);
  const observed = observePresence(version);
  return { ...pairFrom(observed), version: observed === 'present' ? version.firstLine : null, checks: { version } };
}

// Antigravity is its own capability pair, probed the same presence-only way
// as gemini — it is not folded into the gemini pair, so a gemini/antigravity
// split (one present, the other not) is never rounded away.
function probeAntigravity() {
  const version = execProbe('antigravity', ['--version']);
  const observed = observePresence(version);
  return { ...pairFrom(observed), version: observed === 'present' ? version.firstLine : null, checks: { version } };
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
    // same pairs as providers.*, without the probe detail.
    per_provider: {
      codex: { routing: codex.routing, observed: codex.observed },
      gemini: { routing: gemini.routing, observed: gemini.observed },
      antigravity: { routing: antigravity.routing, observed: antigravity.observed },
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
  out += describe('antigravity', antigravity, antigravity.version);
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

Writes state.json.preflight { checked_ts, node,
providers: { codex, gemini, antigravity },
per_provider (the bare routing pairs routing.js keys degraded modes off),
git, gh } and appends one ledger record of kind "preflight" (this script is
the sole writer of both). Prints a human-readable summary.

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

module.exports = { run, PROBE_TIMEOUT_MS };
