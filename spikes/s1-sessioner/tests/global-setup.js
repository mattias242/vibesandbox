'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Rensa resultatkatalogen före körning. Varje test appendar rader (jsonl).
module.exports = async () => {
  const dir = path.join(__dirname, '..', 'results');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
};
