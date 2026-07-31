'use strict';

// maestro machine layer — symlink-containment library.
//
// The tree's ONE containment mechanism ("symlink-containment before
// mutation"): every writer that mutates a path under .maestro/ validates
// that path here BEFORE its first mutation, so a pre-planted symlink — at
// the target itself or at any parent directory component — can never
// redirect a write outside the tree. Pure validation, no mutation: a
// refusal throws with everything on disk untouched.

const fs = require('node:fs');
const path = require('node:path');

// Resolves the longest existing prefix of p through realpath and reattaches
// the missing tail literally, so containment can be judged even before the
// target file exists.
function realpathOfPossiblyMissing(p) {
  const abs = path.resolve(p);
  const suffix = [];
  let existing = abs;
  while (!fs.existsSync(existing)) {
    suffix.unshift(path.basename(existing));
    const parent = path.dirname(existing);
    if (parent === existing) break; // reached the filesystem root
    existing = parent;
  }
  const realExisting = fs.realpathSync(existing);
  return suffix.length > 0 ? path.join(realExisting, ...suffix) : realExisting;
}

// Refuses (throws) if targetPath already exists as a symlink, or if its
// symlink-resolved location falls outside treeRoot's own real path. label is
// the calling script's name, prefixed onto the refusal message.
function assertContained(treeRoot, targetPath, label) {
  let lst;
  try {
    lst = fs.lstatSync(targetPath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    lst = null;
  }
  if (lst && lst.isSymbolicLink()) {
    throw new Error(`${label}: refusing to write through a symlinked target ("${targetPath}")`);
  }
  const treeRootReal = fs.realpathSync(treeRoot);
  const targetReal = realpathOfPossiblyMissing(targetPath);
  const rel = path.relative(treeRootReal, targetReal);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`${label}: target "${targetPath}" resolves outside treeRoot (via a symlinked parent)`);
  }
}

const HELP = `contain.js — maestro symlink-containment library (not a CLI)

Require it from another machine-layer script:

  const { assertContained, realpathOfPossiblyMissing } = require('./contain.js');

  assertContained(treeRoot, targetPath, label)
                          throws if targetPath is a symlink or resolves
                          (through any symlinked parent) outside treeRoot;
                          run BEFORE the first mutation so a refusal leaves
                          everything untouched
  realpathOfPossiblyMissing(p)
                          realpath of the longest existing prefix with the
                          missing tail reattached literally
`;

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  process.stderr.write('contain.js is a library, not a CLI. Run with --help for its exports.\n');
  process.exit(1);
}

module.exports = { assertContained, realpathOfPossiblyMissing };
