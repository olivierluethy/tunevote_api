# TuneVote — Deployment troubleshooting

Companion to [`DEPLOYMENT.md`](DEPLOYMENT.md). **If a deploy goes wrong, read this
first.** Each entry is a real failure mode for TuneVote's stack (single VPS: nginx
+ PM2 Node backend + Dockerised MySQL), with the symptom, the cause, and the fix.

The `vps '<cmd>'` shorthand and credential handling are defined in DEPLOYMENT.md §1.

---

## #1 — API is down after deploy (PM2 `errored`)

**Symptom:** `https://api.tunevote.com` returns 502/503; `pm2 status` shows
`tunevote_api` as `errored` or constantly restarting.

**Diagnose:**

```bash
vps 'pm2 logs tunevote_api --lines 60 --nostream'
```

**Common causes & fixes:**

- **A required env var is missing.** `email.js` throws at import time if
  `EMAIL_USER` / `EMAIL_PASSWORD` are unset, and `services/mailer.js` verifies
  Gmail credentials at startup — either can crash the process on boot. Check the
  server `.env` has every key from `.env.example`:

  ```bash
  vps 'cd /var/www/tunevote_api && for k in DB_HOST DB_USER DB_PASSWORD DB_NAME JWT_SECRET GMAIL_USER GMAIL_APP_PASSWORD EMAIL_USER EMAIL_PASSWORD; do grep -q "^$k=" .env && echo "$k ok" || echo "$k MISSING"; done'
  ```

  This is the archive's problem #12: `.env` is git-ignored and does **not** travel
  with `git pull`, so a newly-added variable is absent on prod until added by hand.

- **Database unreachable.** The MySQL container isn't up, or `DB_HOST`/`DB_PORT`
  are wrong. Confirm the container and connectivity:

  ```bash
  vps 'docker ps | grep mysql || echo "mysql container NOT running"'
  vps 'set -a; . /var/www/tunevote_api/.env; set +a
    docker exec mysql mysql -u"$DB_USER" -p"$DB_PASSWORD" -e "SELECT 1;" "$DB_NAME" 2>/dev/null && echo "DB reachable" || echo "DB connection FAILED"'
  ```

  If the container is down: `vps 'cd /var/www/tunevote_api && docker compose up -d'`.

- **Port 4000 already held** by an orphaned process:

  ```bash
  vps 'sudo lsof -i :4000'      # then kill the stray PID if it is not the current pm2 app
  ```

**Recover:** once fixed, `vps 'pm2 restart tunevote_api && pm2 status'`. If it
still won't start, roll the code back (DEPLOYMENT.md §9).

---

## #2 — Never leave a DB dump or code archive in a web root

**Symptom / risk:** a file like `tunevote_backup_*.sql`, `api.zip`, or an exposed
`.env` sits under a directory nginx serves — making your **database password or
full data publicly downloadable**.

**Check nothing sensitive is served:**

```bash
for f in .env tunevote_backup.sql init.sql db.js; do
  printf "%-24s %s\n" "$f" "$(curl -s -o /dev/null -w '%{http_code}' https://api.tunevote.com/$f)"
done   # each should be 403 or 404, never 200
```

**Fix:** keep backups in `~/tunevote-backups/` (outside `/var/www`), and ensure
nginx never serves dotfiles or `.sql`. The API is a reverse-proxied Node app, so
nginx should proxy to `:4000` and not serve the repo directory as static files at
all — verify the `location` block does `proxy_pass`, not `root`/`try_files` on the
repo. Related: the repo's 24 MB `tunevote_backup_*.sql` is now git-ignored (see
README), and the committed YouTube keys must be rotated in Google Cloud.

---

## #3 — Migration fails or schema drifts

**Symptom:** `npm run migrate:latest` errors, or `npm run verify-schema` exits
non-zero (live DB doesn't match canonical `init.sql`).

**Fixes:**

- **You took the backup first (DEPLOYMENT.md §6.2), right?** If a migration
  half-applied and left the DB inconsistent, restore the pre-migration dump:

  ```bash
  vps 'set -a; . /var/www/tunevote_api/.env; set +a
    gunzip -c ~/tunevote-backups/<pre-migrate-dump>.sql.gz | docker exec -i mysql mysql -u"$DB_USER" -p"$DB_PASSWORD" "$DB_NAME"'
  ```

- **"Already applied" / partial state:** migrations are idempotent and recorded in
  `knex_migrations`. Check what Knex thinks ran:

  ```bash
  vps 'cd /var/www/tunevote_api && npm run migrate:status'
  ```

- **Privilege errors during backup/migrate** (app user lacks rights): use root via
  `DEPLOY_DB_ROOT_PASSWORD` for the `mysqldump`/`mysql` calls.

- **Never** hand-edit the schema on prod to "make it match." Fix the migration or
  `init.sql`, commit, redeploy. `init.sql` is the single source of truth.

---

## #4 — Frontend shows the old build, or deep links 404

**Symptoms & fixes:**

- **Old bundle still served.** Browsers and the server may hold stale hashed
  chunks. Confirm the live HTML references the hash you just built, and that the
  upload used `--delete` so orphaned chunks were removed:

  ```bash
  curl -s https://app.tunevote.com/ | grep -o 'assets/index-[A-Za-z0-9_-]*\.js' | head -1
  ls ~/Documents/tunevote_frontend/dist/assets/ | grep -o 'index-[A-Za-z0-9_-]*\.js' | head -1
  ```

  If they differ, re-run DEPLOYMENT.md §7 (rsync with `--delete`).

- **Deep links (e.g. `/session/abc`) 404.** The SPA fallback is missing — nginx
  must serve `index.html` for unknown paths:

  ```
  location / { try_files $uri $uri/ /index.html; }
  ```

  Reload nginx after fixing: `vps 'sudo nginx -t && sudo systemctl reload nginx'`.

- **PWA caches an old version.** `vite-plugin-pwa` uses `registerType:
  autoUpdate`; a hard refresh (or bumping the build) clears a stuck service worker.

---

## #5 — Frontend points at the wrong backend

**Symptom:** the live dashboard calls `localhost:4000`, or a local dev build calls
prod.

**Cause:** the README's known caveat — several frontend files still **hardcode**
`https://api.tunevote.com/` while others use `VITE_API_URL`. A production build
must be built with `.env` → `VITE_API_URL=https://api.tunevote.com/`; verify before
uploading:

```bash
grep -o 'https://api.tunevote.com' ~/Documents/tunevote_frontend/dist/assets/*.js | head -1
```

If it prints nothing, you built a dev bundle — do not deploy it. Long-term fix:
route every call through `VITE_API_URL` so local and prod differ only by `.env`
value (archive problem #5).

---

## #6 — Real-time (Socket.IO) doesn't connect in production

**Symptom:** playback sync, live participant counts, and voting-phase updates work
locally but not on prod (WebSocket connection fails / falls back to polling).

**Cause:** nginx isn't upgrading the WebSocket connection for the API host.

**Fix:** the `api.tunevote.com` server block needs the upgrade headers:

```
location / {
    proxy_pass http://127.0.0.1:4000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
}
```

Then `vps 'sudo nginx -t && sudo systemctl reload nginx'`.

---

## #7 — YouTube search stops working (quota)

**Symptom:** song search returns nothing / errors for everyone.

**Cause:** the YouTube Data API daily quota is exhausted (archive block F). Every
uncached search costs quota.

**Fixes / checks:**

- The cache (`youtube_video_cache`) should absorb most lookups; confirm it's
  populating (`GET/POST /youtube-cache`). A cold cache burns quota fast.
- Quota resets daily (Pacific midnight). Google quota-increase requests are
  effectively never granted — do not rely on that.
- The key must be valid and referrer-restrictions must allow the server. Note the
  keys committed in git history are burned and must be rotated.

---

## #8 — Database backup dump is empty or wrong-sized

**Symptom:** `mysqldump` output is 0 bytes or has far fewer `CREATE TABLE` lines
than expected.

**Cause:** wrong credentials, wrong DB name, or the app user lacking privileges
(so `--single-transaction --routines` fails silently under `2>/dev/null`).

**Fix:** drop the `2>/dev/null` to see the real error, or dump as root:

```bash
vps 'docker exec mysql mysqldump -uroot -p"$DEPLOY_DB_ROOT_PASSWORD" --single-transaction --routines tunevote | head -50'
```

**Do not run a migration until you have a verified, non-empty backup** (archive
problem #2 — the `youtube_video_cache` table was lost exactly this way).

---

## #9 — SSH output buried in locale warnings

**Symptom:** every command prints walls of `perl: warning: Setting locale failed`.

**Cause:** the server lacks the locale your client forwards. Harmless, but noisy.

**Fix:** filter it:

```bash
vps '<command>' 2>&1 | grep -viE "perl:|locale|LC_|LANG|are supported"
```

---

## #10 — A secret got committed / leaked

**Symptom:** credentials appear in a tracked file (e.g. pasted into `.env.example`
instead of `.env`), or in git history.

**Immediate steps:**

1. Move the value into the git-ignored `.env`; reset the tracked file to
   placeholders (do this **before** committing).
2. If it was already committed/pushed, treat the secret as **burned** and rotate
   it at the source (SSH password/key, DB password, API key) — history rewriting is
   cosmetic; rotation is the real fix.
3. Confirm nothing sensitive remains tracked:

   ```bash
   git grep -nE 'password|secret|ghp_|AIza|DEPLOY_SSH' -- ':!*.example' ':!*.md'
   ```

See the archive's chapter 0 for the full compromised-credentials checklist.

---

## Deployment rollback

Full rollback steps (code, frontend, database) live in **DEPLOYMENT.md §9**. The
one rule worth repeating: if new code depends on a new schema, roll the **code and
the database back together** — never one without the other.
