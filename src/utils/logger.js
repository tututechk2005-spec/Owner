'use strict';
const db = require('../db');

async function log(level, scope, message) {
  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] [${scope}] ${message}`;
  if (level === 'error') console.error(line);
  else console.log(line);
  try {
    await db.run('INSERT INTO logs (level, scope, message) VALUES (?, ?, ?)', [level, scope, message]);
  } catch (e) {
    // Don't crash on log failures
  }
}

module.exports = {
  info: (scope, msg) => log('info', scope, msg),
  warn: (scope, msg) => log('warn', scope, msg),
  error: (scope, msg) => log('error', scope, msg),
};
