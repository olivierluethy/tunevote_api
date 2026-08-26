# TuneVote — Deployment runbook

This is the single procedure for shipping a TuneVote change to production. It is
written so **Claude can run the whole thing over SSH** — when you say
*"deploy per DEPLOYMENT.md"*, this is the file to follow, top to bottom, for the
part(s) that changed.

Unlike the old manual process (see [`TUNEVOTE_ARCHIV.md`](TUNEVOTE_ARCHIV.md)),
everything here is driven from committed code and environment variables — no
hand-editing URLs before a push, no building on the server, no typing the DB
password on a command line.

**If anything goes wrong, read [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) first** —
it lists TuneVote's real failure modes (API down after deploy, migration/schema
drift, stale frontend build, Socket.IO not connecting, YouTube quota) with fixes.

> **Scope of "testing" in this document.** This runbook only verifies that the
> deploy itself *mechanically succeeded*: the process is back online, the
> endpoints answer, the migration is recorded. **Functional / feature testing is
> the user's job, done after the deploy.** Do not add or run feature tests here —
> implement, deploy, hand it back for testing.

> As of the **July 2026 split-hosting migration**, frontend and backend live on
> **two different hosts** (see §0). Paths below are verified against the live boxes.

---

## 0. What you are deploying to — a split setup

The backend stays on the **VPS**; the frontend is static-hosted on a **GoDaddy
cPanel** account. They deploy independently.

### Backend — VPS (`api.tunevote.com`)

| | |
|---|---|
| Host / IP | `$DEPLOY_SSH_HOST` (from `.env`, currently `72.167.49.141`) |
| SSH user | `$DEPLOY_SSH_USER` (from `.env`, `salade`) — code dir & PM2 are **root-owned, so use `sudo`** (same password) |
| Domain | `https://api.tunevote.com` (nginx → Node on `:4000`) |
| Process | PM2 app **`tunevote_api`**, running under **root** |
| Code dir | `/var/www/tunevote_api` |
| Database | MySQL 8 in Docker, container **`mysql`**, database **`tunevote`** |
| Also on box | phpMyAdmin — **private, not publicly exposed**: gated behind the compose `admin` profile and bound to `127.0.0.1:8080`, reachable only via SSH tunnel. **No frontend here anymore.** |
| DB & admin security | MySQL binds to `127.0.0.1:3306` only; there is **no** public `phpmyadmin.tunevote.com`. See [`docs/2026-08-26-database-security-architecture.md`](docs/2026-08-26-database-security-architecture.md). |
| Backups | `~/tunevote-backups/` |

### Frontend — GoDaddy cPanel (`app.tunevote.com`)

| | |
|---|---|
| Host / IP | `132.148.178.39` (shared cPanel `p3plzcpnl506305.prod.phx3.secureserver.net`) |
| cPanel user | `gr41l1kzrrhf` |
| Access | **SSH key** `~/.ssh/id_ed25519_tunevote_cpanel` (GoDaddy blocks password SSH, FTP, and cPanel-password API auth) |
| Domain | `https://app.tunevote.com` (Apache **addon domain**, AutoSSL) |
| Document root | `~/public_html/app.tunevote.com` |
| Serving | static Vite build + `.htaccess` SPA fallback — **no build step, no process, no nginx** |

> **DNS:** `api.tunevote.com` → the VPS; `app.tunevote.com` → the cPanel IP
> `132.148.178.39`. The shared cPanel hosts other sites — **only ever touch
> `~/public_html/app.tunevote.com`.**
>
> ⚠️ **Creating the cPanel domain/SSL is a one-time cPanel-UI step** (Domains →
> Create A Domain, docroot `public_html/app.tunevote.com`), *not* scriptable from
> here: GoDaddy's jailed shell lacks the domain API modules and rejects
> cPanel-password API auth (401). Only **file deploys** are automatable (over the
> SSH key). See [`cPanel-Create-Subdomain-Guide.md`]; to script domain ops later,
> create a cPanel **API token**.

---

## 1. Credentials — read from `.env`, never hard-coded

SSH and deploy secrets live in the **API repo's `.env`** (git-ignored, never
committed). Add these keys (placeholders are in
[`.env.example`](.env.example)):

```env
# --- Deployment (SSH to the VPS) ---
DEPLOY_SSH_HOST=            # the VPS IP address ("the number")
DEPLOY_SSH_USER=            # SSH username
DEPLOY_SSH_PASSWORD=        # SSH password (or leave blank and use a key, see below)
DEPLOY_SSH_PORT=22
DEPLOY_DB_ROOT_PASSWORD=    # MySQL root password, for backups/migrations if needed
```

Load them into the shell for a deploy session (run from the API repo root):

```bash
set -a; . ./.env; set +a
```

### VPS — password auth via SSH's askpass

`sshpass` can't be installed here (no interactive `sudo`), so use OpenSSH's
built-in askpass. Define a `vps` helper once per session:

```bash
cat > /tmp/askpass.sh <<'EOF'
#!/bin/bash
echo "$SSH_PW"
EOF
chmod +x /tmp/askpass.sh

vps() { SSH_PW="$DEPLOY_SSH_PASSWORD" SSH_ASKPASS_REQUIRE=force SSH_ASKPASS=/tmp/askpass.sh \
  setsid -w ssh -o StrictHostKeyChecking=accept-new \
  -o PreferredAuthentications=password -o PubkeyAuthentication=no \
  "$DEPLOY_SSH_USER@$DEPLOY_SSH_HOST" "$1"; }

vps 'echo connected as $(whoami)'
```

**`sudo` on the VPS uses the same password:** `echo "$DEPLOY_SSH_PASSWORD" | sudo -S <cmd>`.
For multi-line root scripts, base64-encode to avoid quoting hell:
`B64=$(printf '%s' "$SCRIPT" | base64 -w0); vps "echo $B64 | base64 -d > /tmp/s.sh && echo '$DEPLOY_SSH_PASSWORD' | sudo -S bash /tmp/s.sh; rm -f /tmp/s.sh"`.

### cPanel — SSH key (frontend host)

Password/FTP/API-token auth are all blocked by GoDaddy; the authorized **SSH key**
is the only programmatic access. Define a `cpanel` helper:

```bash
cpanel() { ssh -i ~/.ssh/id_ed25519_tunevote_cpanel -o StrictHostKeyChecking=accept-new \
  gr41l1kzrrhf@132.148.178.39 "export TERM=dumb; $1"; }

cpanel 'echo connected as $(whoami)'
```

> In the commands below, `vps '<cmd>'` runs on the backend VPS; `cpanel '<cmd>'`
> runs on the frontend cPanel host.

---

## 2. Local = production (no per-environment code differences)

The same code runs locally and in prod; only `.env` **values** differ, never the
variable **names**. To bring a fresh checkout up locally:

**Backend** (`tunevote_api`):

```bash
cp .env.example .env          # fill in local values (DB_HOST=localhost, MYSQL_* etc.)
docker compose up -d          # MySQL 8 only (bound to 127.0.0.1:3306, never public)
# phpMyAdmin is NOT started by default — it lives behind the "admin" profile and
# binds to loopback. Bring it up only when you need it, then reach it via tunnel:
#   docker compose --profile admin up -d phpmyadmin   # then ssh -L 8080:127.0.0.1:8080 …
# load the canonical schema once, then apply migrations:
#   import init.sql into the `tunevote` database, then:
npm ci
npm run migrate:latest
node index.js                 # API on http://localhost:4000
```

**Frontend** (`tunevote_frontend`):

```bash
npm ci
npm run dev                   # http://localhost:5173
```

> All API calls now go through `VITE_API_URL` (no hardcoded URLs). `vite dev`
> auto-loads `.env.development` (`VITE_API_URL=http://localhost:4000`) while
> `vite build` uses `.env` (`https://api.tunevote.com`) — so local and prod are
> the same code, no manual switching. **No trailing slash** on `VITE_API_URL`
> (some pages build `${API_URL}/path`, which would otherwise double-slash).

**Workflow:** implement a feature → run it locally → hand it to the user to test
→ once they confirm, deploy with the steps below.

---

## 3. Which parts changed?

Pick the path that matches the change. Always start with §4.

| Change | Do |
|---|---|
| Backend code only | §4 → §5 → §8 |
| Backend + DB schema | §4 → §5 → **§6** → §8 |
| Frontend only | §4 → §7 → §8 |
| Both | §4 → §5 → (§6 if schema) → §7 → §8 |

---

## 4. Pre-deploy — commit & push first

The server deploys from `origin/main`. Nothing ships that isn't committed.

```bash
# in whichever repo changed:
git add -A && git commit -m "<what changed>"
git push origin main
```

---

## 5. Deploy the API (backend)

The Node process must be **restarted** to pick up new code — copying files is not
enough. Sync the server working tree to `origin/main` cleanly, reinstall deps,
restart PM2.

> If this deploy includes schema changes, **do §6 (backup + migrate) BETWEEN the
> code sync and the PM2 restart** — new code must not serve requests against the
> old schema for longer than necessary.

`/var/www/tunevote_api` is root-owned and PM2 runs under root, so everything here
goes through `sudo` (same password):

```bash
vps 'echo "$DEPLOY_SSH_PASSWORD" | sudo -S bash -c "
  cd /var/www/tunevote_api &&
  git fetch origin &&
  git reset --hard origin/main &&
  npm ci --omit=dev"'
```

Then (after §6 if applicable) restart and persist (root's PM2):

```bash
vps 'echo "$DEPLOY_SSH_PASSWORD" | sudo -S pm2 restart tunevote_api'
vps 'echo "$DEPLOY_SSH_PASSWORD" | sudo -S pm2 save'
vps 'echo "$DEPLOY_SSH_PASSWORD" | sudo -S pm2 status'
```

`pm2 status` must show `tunevote_api` as **online**. If it's `errored`, read the
logs immediately:

```bash
vps 'echo "$DEPLOY_SSH_PASSWORD" | sudo -S pm2 logs tunevote_api --lines 40 --nostream'
```

---

## 6. Database migrations — only when the schema changed

**Back up before touching the schema. This is not optional** — the archive
records the `youtube_video_cache` table being lost to un-backed-up overwrites
(problem #2).

> All §6 commands run **as root** (`sudo`): the app `.env` is root-owned and the
> `mysql` Docker container needs root. Prefix with `echo "$DEPLOY_SSH_PASSWORD" |
> sudo -S bash -c "…"` (base64-wrap multi-line scripts, see §1).

### 6.1 Record row counts (proof nothing is lost)

```bash
vps 'set -a; . /var/www/tunevote_api/.env; set +a
  docker exec mysql mysql -u"$DB_USER" -p"$DB_PASSWORD" "$DB_NAME" -e "
    SELECT (SELECT COUNT(*) FROM users) users,
           (SELECT COUNT(*) FROM sessions) sessions,
           (SELECT COUNT(*) FROM queue_items) queue_items,
           (SELECT COUNT(*) FROM votes) votes;" 2>/dev/null'
```

### 6.2 Back up the database

```bash
vps 'set -a; . /var/www/tunevote_api/.env; set +a
  mkdir -p ~/tunevote-backups
  OUT=~/tunevote-backups/tunevote-pre-migrate-$(date +%Y%m%d-%H%M%S).sql
  docker exec mysql mysqldump -u"$DB_USER" -p"$DB_PASSWORD" \
    --default-character-set=utf8mb4 --single-transaction --routines "$DB_NAME" > "$OUT" 2>/dev/null
  gzip -k "$OUT"
  ls -lh "$OUT"*
  grep -c "^CREATE TABLE" "$OUT"'
```

> If `$DB_USER` lacks privileges for `--routines`/locking, use root instead:
> `docker exec mysql mysqldump -uroot -p"$DEPLOY_DB_ROOT_PASSWORD" ...`
> **Do not continue if the dump is empty or the table count looks wrong.**
>
> **Encoding:** always dump/restore with `--default-character-set=utf8mb4`, and
> never restore a pre-2026-07-28 dump (it holds the old mojibake). The MySQL
> server also forces utf8mb4 on every connection
> (`--skip-character-set-client-handshake`). See
> [`docs/encoding-repair.md`](docs/encoding-repair.md) §3a.

### 6.3 Review, then apply (Knex)

```bash
vps 'echo "$DEPLOY_SSH_PASSWORD" | sudo -S bash -c "cd /var/www/tunevote_api && npm run migrate:status"'   # dry
vps 'echo "$DEPLOY_SSH_PASSWORD" | sudo -S bash -c "cd /var/www/tunevote_api && npm run migrate:latest"'   # apply
```

Migrations are idempotent (INFORMATION_SCHEMA-guarded); re-running is safe.

### 6.4 Verify the schema matches the canonical source

```bash
vps 'echo "$DEPLOY_SSH_PASSWORD" | sudo -S bash -c "cd /var/www/tunevote_api && npm run verify-schema"'    # exit 0 = OK
```

Then re-run the §6.1 count query and confirm existing rows are unchanged.

---

## 7. Deploy the frontend — to cPanel

Build **locally**, upload the static `dist/` to the cPanel docroot over the SSH
key. There is no build step, process, or nginx on the frontend host — it's plain
Apache static hosting.

```bash
cd ~/Documents/tunevote_frontend
npm ci
npm run build                 # dist/ — uses .env (VITE_API_URL=https://api.tunevote.com)
grep -o 'https://api.tunevote.com' dist/assets/*.js | head -1   # must print the prod URL
test -f dist/.htaccess && echo ".htaccess present"              # SPA fallback (from public/.htaccess)
```

Upload the **contents** of `dist/` (including the dotfile `.htaccess`) with
`--delete` so stale hashed chunks are removed:

```bash
rsync -az --delete -e "ssh -i ~/.ssh/id_ed25519_tunevote_cpanel -o StrictHostKeyChecking=accept-new" \
  dist/ gr41l1kzrrhf@132.148.178.39:~/public_html/app.tunevote.com/
```

> If `rsync` isn't available, zip and extract instead:
> `cd dist && zip -qr /tmp/fe.zip . && scp -i ~/.ssh/id_ed25519_tunevote_cpanel /tmp/fe.zip gr41l1kzrrhf@132.148.178.39:~/ && cpanel 'cd ~/public_html/app.tunevote.com && rm -rf assets icons && unzip -o ~/fe.zip && rm ~/fe.zip'`

Nothing to restart. The `.htaccess` provides the SPA fallback; Apache picks up new
files immediately. HTTPS is handled by cPanel **AutoSSL** (already provisioned).

---

## 8. Confirm the deploy succeeded (mechanical checks only)

These confirm the *deployment* worked — not that a feature works (that's the
user's testing). All should be green before you report done.

```bash
# Backend (VPS) process is up
vps 'echo "$DEPLOY_SSH_PASSWORD" | sudo -S pm2 status | grep tunevote_api'

# Endpoints answer (a real backend route, not "/" which 404s)
curl -s -o /dev/null -w "api:       %{http_code}\n" https://api.tunevote.com/top-today   # expect 200
curl -s -o /dev/null -w "dashboard: %{http_code}\n" https://app.tunevote.com/            # expect 200

# The live frontend references the bundle you just built (hashes match)
curl -s https://app.tunevote.com/ | grep -o 'assets/index-[A-Za-z0-9_-]*\.js' | head -1
ls ~/Documents/tunevote_frontend/dist/assets/ | grep -o 'index-[A-Za-z0-9_-]*\.js' | head -1

# If DNS is still propagating, test the frontend against the cPanel IP directly:
curl -sk --resolve app.tunevote.com:443:132.148.178.39 -o /dev/null -w "cpanel: %{http_code}\n" https://app.tunevote.com/

# If a migration ran, it's recorded
vps 'echo "$DEPLOY_SSH_PASSWORD" | sudo -S bash -c "cd /var/www/tunevote_api && npm run migrate:status"'
```

Report the results to the user and hand off for feature testing.

---

## 9. Rolling back

**Backend code** (VPS, as root) — redeploy the previous commit:

```bash
vps 'echo "$DEPLOY_SSH_PASSWORD" | sudo -S bash -c "cd /var/www/tunevote_api && git reset --hard <previous-commit> && npm ci --omit=dev && pm2 restart tunevote_api"'
```

**Frontend** (cPanel) — rebuild the previous commit locally and re-run §7's
`rsync`, or keep the prior `dist/` and re-upload it. The nginx-config backup from
the migration (`/root/nginx-sites-backup-*.tgz` on the VPS) restores the *old*
single-host setup if you ever need to move the frontend back to the VPS.

**Database** — restore the pre-migration dump from §6.2:

```bash
vps 'set -a; . /var/www/tunevote_api/.env; set +a
  gunzip -c ~/tunevote-backups/<the-backup>.sql.gz | docker exec -i mysql mysql -u"$DB_USER" -p"$DB_PASSWORD" "$DB_NAME"'
```

> Migrations are additive where possible, but if new code depends on the new
> schema, roll the **code back at the same time** as the database.

---

## 10. Deployment checklist

- [ ] Change committed and pushed to `origin/main`
- [ ] (Backend, VPS via sudo) `git reset --hard origin/main` + `npm ci --omit=dev`
- [ ] (Schema) Row counts recorded **before** touching the DB
- [ ] (Schema) Database backed up, dump verified non-empty
- [ ] (Schema) `migrate:status` reviewed → `migrate:latest` applied → `verify-schema` exit 0
- [ ] (Backend) `sudo pm2 restart tunevote_api`, status **online**, `sudo pm2 save`
- [ ] (Frontend) Built locally, bundle targets `api.tunevote.com`, `.htaccess` present
- [ ] (Frontend, cPanel) `dist/` rsynced to `~/public_html/app.tunevote.com` with `--delete`, live hash matches
- [ ] Endpoints: `api.tunevote.com/top-today` 200, `app.tunevote.com/` 200
- [ ] Results reported → handed to user for feature testing

---

## Appendix — SSH noise & secret hygiene

- **Locale warnings:** if the server floods `perl: warning: Setting locale
  failed`, filter it: `vps '<cmd>' 2>&1 | grep -viE "perl:|locale|LC_|LANG"`.
- **Never** put secrets in this file, in git, or in a commit message. SSH and DB
  credentials live only in the git-ignored `.env`.
- **Never** leave a database dump or a code archive inside a web root — it becomes
  publicly downloadable. Keep backups in `~/tunevote-backups/`, outside
  `/var/www`.
- The YouTube keys already leaked in git history (see README): rotating them in
  Google Cloud is the real fix; env-only config keeps new ones out.
