// Start the actual server in an isolated directory, without account credentials.
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net');
const { spawn } = require('child_process');
const assert = require('assert');
const root = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trading-startup-'));
let child, output = '';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  try {
    for (const item of ['server.js', 'src', 'public', 'cb/dist', 'scalp-gate-validation.json']) {
      fs.cpSync(path.join(root, item), path.join(tmp, item), { recursive: true });
    }
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(tmp, 'node_modules'), 'junction');
    if (fs.existsSync(path.join(root, 'cb/node_modules'))) {
      fs.symlinkSync(path.join(root, 'cb/node_modules'), path.join(tmp, 'cb/node_modules'), 'junction');
    }
    const socket = net.createServer();
    await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
    const port = socket.address().port;
    await new Promise(resolve => socket.close(resolve));
    const env = {};
    for (const key of ['SystemRoot', 'WINDIR', 'ComSpec', 'PATH', 'Path', 'PATHEXT', 'TEMP', 'TMP']) {
      if (process.env[key]) env[key] = process.env[key];
    }
    Object.assign(env, { HOST: '127.0.0.1', PORT: String(port), DEPLOY_KEY: 'startup-test-key' });
    fs.writeFileSync(path.join(tmp, 'settings.json'), '{}');
    const at = Math.floor(Date.now() / 3600000) * 3600000;
    const trades = Array.from({ length: 60 }, (_, i) => ({
      id: 'test-' + i, coin: 'TEST', pair: 'TEST-USD', entry: 100,
      at: at - (Math.floor(i / 2) + 2) * 3600000, rule: 'fall3',
      done60: true, done3d: true, v2: true, v3: true, outcomeVersion: 4,
      dayFall: 4, spreadPct: 0.1, pullback: 2, chg24: -4, recHour: 84,
      control: i % 2 === 1, cv: i % 2 === 1 ? 2 : undefined,
      m60: i % 2 === 1 ? -0.1 : 0.15, hit60: null, hitKnown60: true, hourComplete: true,
    }));
    fs.writeFileSync(path.join(tmp, 'entry-paper.json'), JSON.stringify({ trades, rule: 'fall3', startedAt: at }));
    child = spawn(process.execPath, [path.join(tmp, 'server.js')], { cwd: tmp, env, windowsHide: true });
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    const base = 'http://127.0.0.1:' + port;
    let ready = false;
    for (let i = 0; i < 40; i++) {
      try { ready = (await fetch(base, { signal: AbortSignal.timeout(1000) })).ok; } catch { }
      if (ready) break;
      await pause(250);
    }
    assert(ready, 'server failed to start: ' + output.slice(-2500));
    for (const endpoint of ['/api/lab', '/api/scalp-scan', '/api/entry-paper']) {
      const response = await fetch(base + endpoint);
      assert(response.ok, endpoint);
      assert((await response.json()).success, endpoint);
    }
    assert.equal((await fetch(base + '/api/entry-paper?audit=1')).status, 403);
    const journal = await (await fetch(base + '/api/entry-paper?audit=1', {
      headers: { 'X-Deploy-Key': 'startup-test-key' },
    })).json();
    assert.equal(journal.auditTrades.length, 60);
    assert.equal(journal.comparison.diff, 0.25);
    assert.equal(journal.comparison.hours, 30);
    assert.equal(journal.decision.state, 'ждём');
    for (const endpoint of ['/', '/mobile/index.html']) {
      assert((await (await fetch(base + endpoint)).text()).includes('src="/js/recovery-journal.js"'));
    }
    assert((await fetch(base + '/js/recovery-journal.js')).ok);
    assert(!/CRASH PREVENTED|ReferenceError|SyntaxError/.test(output), output.slice(-2500));
    console.log('Actual server startup, warm-up APIs, journal calculation/export and both layouts: OK');
  } finally {
    if (child && child.exitCode == null) {
      const closed = new Promise(resolve => child.once('exit', resolve));
      child.kill();
      await closed;
    }
    assert.equal(path.dirname(path.resolve(tmp)), path.resolve(os.tmpdir()));
    // Remove junctions first: cleanup must never recurse into shared dependencies.
    for (const item of ['node_modules', 'cb/node_modules']) {
      const link = path.join(tmp, item);
      if (fs.existsSync(link) && fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
