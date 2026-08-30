---
name: deploy
description: Deploy the trading app to the Kamatera server and verify it came back healthy. Use when asked to deploy, push to the server, "обновить на сервере", or to check whether the running server matches the code.
---

# Deploy and verify

Production: `http://103.90.162.77:3847`. Node/Express + a vanilla-JS SPA, kept
alive by pm2. There is no build step — the server serves `public/` directly.

## How a deploy actually works

`POST /api/deploy?key=trading-deploy-2026` makes the server run `git pull` and
then `process.exit(0)`; pm2 restarts it. So **the server pulls from GitHub** —
a local commit that has not been pushed will not deploy. Push first, always.

The endpoint snapshots the live-data files before the pull and writes them back
after, because the repository holds stale copies of several of them:

    settings.json  profit-history.json  favorites.json
    selected-orders.json  selected-coin.json
    notified-fills.json   score-history.json

Never commit those. If one of them shows up in `git status`, untrack it rather
than committing it — a single commit touching `settings.json` would replace the
live Telegram token with the empty one in the repo.

## Steps

1. Check the working copy is clean and on `master`.
2. Commit only what the task changed. Push to `origin master`.
3. `curl -s -X POST "http://103.90.162.77:3847/api/deploy?key=trading-deploy-2026" --max-time 40`
   A good response has `"success":true`, the `git pull` output, and
   `"protectedRestored"` listing the seven files above.
4. Verify — see below. Do not report success on the deploy response alone; it
   only proves the pull happened, not that the app came back up.

## Verification

Run both scripts. They talk to production over HTTP and place no orders.

    node scripts/audit-live.js     # 38 assertions across scanner, regime, lab, alerts
    node scripts/verify-score.js   # recomputes every score independently of the server

`verify-score.js` mirrors the scoring formula by hand. **When the gate changes,
this script has to change with it**, or it reports failures that are its own.
It cannot see two `+5` terms the server does not expose, so it checks a range.

Then confirm the live surface:

    curl -s http://103.90.162.77:3847/api/scalp-scan   # 9 gate conditions, scanned == total
    curl -s http://103.90.162.77:3847/get-settings     # telegramToken non-empty
    curl -s http://103.90.162.77:3847/api/lab          # lab enabled

Nine conditions: seven per coin, plus two regime checks the scanner adds (BTC
hourly above EMA20, BTC 7-day return positive).

For UI changes, fetch `/` and `/mobile/` and grep for the new symbol — the SPA
is one large file per layout and a stale pm2 process is the usual reason a
change "did not deploy".

## When the pull is refused

The deploy handler already retries once, discarding local changes and unlinking
untracked blockers. If it still fails, the message is in the response `error`.
The usual cause is a protected file that got committed; fix it in the repo with
`git rm --cached <file>` and redeploy.
