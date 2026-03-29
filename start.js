/**
 * Auto-restart wrapper for server.js
 * Automatically restarts the server if it crashes.
 * Usage: node start.js
 */
const { spawn } = require('child_process');
const path = require('path');

const SERVER_FILE = path.join(__dirname, 'server.js');
const RESTART_DELAY = 2000; // 2 seconds before restart
const MAX_RAPID_RESTARTS = 5; // max restarts within the window
const RAPID_RESTART_WINDOW = 30000; // 30 second window

let restartTimes = [];
let child = null;

function startServer() {
  // Clean up old restart times outside the window
  const now = Date.now();
  restartTimes = restartTimes.filter(t => now - t < RAPID_RESTART_WINDOW);

  // Check for crash loop
  if (restartTimes.length >= MAX_RAPID_RESTARTS) {
    console.error(`[WATCHDOG] Server crashed ${MAX_RAPID_RESTARTS} times in ${RAPID_RESTART_WINDOW / 1000}s. Waiting 30s before retry...`);
    setTimeout(() => {
      restartTimes = [];
      startServer();
    }, 30000);
    return;
  }

  console.log(`[WATCHDOG] Starting server... (${new Date().toLocaleTimeString()})`);

  child = spawn('node', [SERVER_FILE], {
    stdio: 'inherit',
    env: process.env,
    cwd: __dirname
  });

  child.on('exit', (code, signal) => {
    if (signal === 'SIGINT' || signal === 'SIGTERM') {
      console.log('[WATCHDOG] Server stopped by user.');
      process.exit(0);
    }

    if (code !== 0 && code !== null) {
      console.error(`[WATCHDOG] Server crashed with code ${code}. Restarting in ${RESTART_DELAY / 1000}s...`);
      restartTimes.push(Date.now());
      setTimeout(startServer, RESTART_DELAY);
    } else {
      console.log('[WATCHDOG] Server exited cleanly.');
    }
  });

  child.on('error', (err) => {
    console.error('[WATCHDOG] Failed to start server:', err.message);
    restartTimes.push(Date.now());
    setTimeout(startServer, RESTART_DELAY);
  });
}

// Forward signals to child
process.on('SIGINT', () => {
  if (child) child.kill('SIGINT');
  else process.exit(0);
});
process.on('SIGTERM', () => {
  if (child) child.kill('SIGTERM');
  else process.exit(0);
});

startServer();
