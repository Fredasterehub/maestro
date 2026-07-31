'use strict';

// maestro machine layer — plain-text sibling of atomic-json.js.
//
// Same temp-in-same-dir + fsync + rename mechanism, for the markdown/prose
// surfaces this tree writes atomically (handoff.md, views/*.md).
// atomic-json.js stays JSON-only rather than growing a second
// responsibility; this module is the one place plain-text atomic writes live.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function writeText(file, text) {
  if (typeof file !== 'string' || file === '') {
    throw new TypeError('atomic-text: file must be a non-empty string');
  }
  if (typeof text !== 'string') {
    throw new TypeError(`atomic-text: value for ${file} must be a string`);
  }

  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });

  // Unpredictable temp name opened 'wx', for the same reasons atomic-json.js
  // documents: a guessable temp path invites symlink redirection, a pid-only
  // suffix collides across threads sharing a pid.
  const tmpFile = path.join(
    dir,
    `.${path.basename(file)}.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`
  );
  const fd = fs.openSync(tmpFile, 'wx');
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  try {
    fs.renameSync(tmpFile, file);
  } catch (err) {
    fs.rmSync(tmpFile, { force: true });
    throw err;
  }
}

const HELP = `atomic-text.js — maestro atomic plain-text library (not a CLI)

Require it from another machine-layer script:

  const { writeText } = require('./atomic-text.js');

  writeText(file, text)   atomic replacement of a text file: temp file in the
                          same directory + fsync + rename
`;

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  process.stderr.write('atomic-text.js is a library, not a CLI. Run with --help for its exports.\n');
  process.exit(1);
}

module.exports = { writeText };
