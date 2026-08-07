'use strict';

// A routed seat the liaison cannot spawn is a dead route: the config resolves
// it, the dispatch fails, and nothing in the machine says so until someone
// reads the two files side by side. That gap has now appeared four times in
// one mission — the four degraded reviewer seats, the six tiered Claude seats,
// the four Sol-ladder seats, and the operator decision that first named it —
// and each time a reviewer caught it rather than the system. Prose did not
// hold it, so this does.
//
// The required list is READ OUT OF THE CONFIG, never written down here: a seat
// a later revision adds without a grant entry fails this test on the day it
// lands, which is the only property that makes it a mechanism rather than a
// fifth reminder.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { buildDefaultConfig, validateRoutingConfig } = require(path.join(__dirname, '..', 'src', 'routing.js'));

const AGENTS_DIR = path.join(__dirname, '..', '..', 'agents');

// The `tools:` line of an agent file's frontmatter, and the seats its
// `Agent(<plugin>:<seat>)` entries name. Frontmatter only — a seat named in
// prose is documentation, not a capability.
function grantedSeats(agentName) {
  const text = fs.readFileSync(path.join(AGENTS_DIR, `${agentName}.md`), 'utf8');
  const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(frontmatter, `agents/${agentName}.md has no frontmatter block`);
  const tools = frontmatter[1].split(/\r?\n/).find((line) => line.startsWith('tools:'));
  assert.ok(tools, `agents/${agentName}.md declares no tools: line`);
  return new Set([...tools.matchAll(/Agent\([^:)]+:([^)]+)\)/g)].map((m) => m[1]));
}

const config = buildDefaultConfig('2026-08-07'); // date is cosmetic; content is what matters
{
  const { ok, errors } = validateRoutingConfig(config);
  assert.strictEqual(ok, true, `active routing config fails its own shape validation: ${errors.join('; ')}`);
}

// Two seats are exempt, and each exemption is checked rather than asserted.
//
// `maestro` is the grant's owner: the liaison is that seat, launched as an
// identity and never spawned as a subagent, and bans.liaison_implements is the
// standing rule that it delegates instead of working. A self-grant would be the
// one entry that means nothing.
//
// `plan-counterpart` is spawned by `convergence`, not by the liaison — the plan
// moment's second family is convergence's own counterpart — so its grant
// belongs on that seat's file. The exemption holds only while that is true,
// which is why it is asserted below rather than taken on faith.
const SPAWNED_ELSEWHERE = { 'plan-counterpart': 'convergence' };
const LIAISON = 'maestro';

const granted = grantedSeats(LIAISON);

const missing = [];
for (const [seatName, seat] of Object.entries(config.seats)) {
  // An alias exists only so an older config keeps validating; no read path
  // resolves one, so no dispatch can ever name it. Granted or not, it is
  // outside what "can resolve" means — the entries the two live aliases still
  // carry are harmless, and leave with them.
  if ('alias_of' in seat) continue;
  if (seatName === LIAISON) continue;
  if (Object.prototype.hasOwnProperty.call(SPAWNED_ELSEWHERE, seatName)) {
    const spawner = SPAWNED_ELSEWHERE[seatName];
    assert.ok(
      grantedSeats(spawner).has(seatName),
      `seat "${seatName}" is exempt from the liaison's grant only because "${spawner}" spawns it — and agents/${spawner}.md does not grant it either, so nothing can`
    );
    continue;
  }
  if (!granted.has(seatName)) missing.push(seatName);
}

assert.deepStrictEqual(
  missing,
  [],
  `the routing config can resolve ${missing.length} seat(s) the maestro grant cannot spawn: ${missing.join(', ')} — ` +
    'add Agent(maestro:<seat>) to the tools: line of agents/maestro.md in the same change that seats them'
);

// The other direction is a weaker but real defect: an entry naming a seat with
// no file grants nothing, and a typo in a seat name would otherwise sit there
// looking like coverage.
for (const seatName of granted) {
  assert.ok(
    fs.existsSync(path.join(AGENTS_DIR, `${seatName}.md`)),
    `the maestro grant names "${seatName}", which has no agents/${seatName}.md to spawn`
  );
}

console.log('test-grant: OK');
