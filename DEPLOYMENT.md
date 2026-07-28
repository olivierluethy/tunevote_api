# TuneVote — Deployment runbook

This is the single procedure for shipping a TuneVote change to production. It is
written so **Claude can run the whole thing over SSH** — when you say
*"deploy per DEPLOYMENT.md"*, this is the file to follow, top to bottom, for the
part(s) that changed.

Unlike the old manual process (see [`TUNEVOTE_ARCHIV.md`](TUNEVOTE_ARCHIV.md)),
everything here is driven from committed code and environment variables — no
hand-editing URLs before a push, no building on the server, no typing the DB
password on a command line.

> **Scope of "testing" in this document.** This runbook only verifies that the
> deploy itself *mechanically succeeded*: the process is back online, the
> endpoints answer, the migration is recorded. **Functional / feature testing is
> the user's job, done after the deploy.** Do not add or run feature tests here —
> implement, deploy, hand it back for testing.

> ⚠️ **Items marked `CONFIRM ON FIRST DEPLOY`** come from the archived description
> of the old setup and have not been re-verified against the live box. On the
> first real deployment, check each one over SSH and replace it with the true
> value, then remove the warning.

---

## 0. What you are deploying to

**One VPS hosts both apps** (frontend and backend are *not* split across
machines). This makes the deploy simpler: one host, one SSH session.

| | |
|---|---|
| Provider | Host Europe VPS |
| Host / IP | `$DEPLOY_SSH_HOST` (from `.env`) |
| SSH user | `$DEPLOY_SSH_USER` (from `.env`) — archive used `su -` for root steps |
| Frontend domain | `https://app.tunevote.com` (nginx, static build) |
| Backend domain | `https://api.tunevote.com` (nginx → Node on `:4000`) |
| Backend process | PM2 app **`tunevote_api`** |
| Backend code dir | `/var/www/tunevote_api` — ⚠️ CONFIRM ON FIRST DEPLOY |
| Frontend web root | `/var/www/html` or `/var/www/TuneVote/dist` — ⚠️ CONFIRM ON FIRST DEPLOY (the archive is inconsistent) |
| Database | MySQL 8 in Docker, container **`mysql`**, database **`tunevote`** |
| Backups | `~/tunevote-backups/` (created on first backup) |

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

### Two ways to authenticate

**Password (what you're providing now)** — uses `sshpass`:

```bash
# install once: sudo apt-get install -y sshpass
alias vps='sshpass -p "$DEPLOY_SSH_PASSWORD" ssh -p "${DEPLOY_SSH_PORT:-22}" -o StrictHostKeyChecking=accept-new "$DEPLOY_SSH_USER@$DEPLOY_SSH_HOST"'
vps 'echo connected as $(whoami)'
```

**Key-based (recommended, one-time hardening)** — the archive's #0 lesson is
*never keep passwords in notes*. Once things work, switch to a key and drop the
password from `.env`:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_tunevote -N "" -C "deploy@tunevote"
sshpass -p "$DEPLOY_SSH_PASSWORD" ssh-copy-id -i ~/.ssh/id_ed25519_tunevote.pub \
  -o StrictHostKeyChecking=accept-new "$DEPLOY_SSH_USER@$DEPLOY_SSH_HOST"
# then use: ssh -i ~/.ssh/id_ed25519_tunevote "$DEPLOY_SSH_USER@$DEPLOY_SSH_HOST"
```

> In the commands below, `vps '<cmd>'` means "run `<cmd>` on the server" using
> whichever method is configured.

---

## 2. Local = production (no per-environment code differences)

The same code runs locally and in prod; only `.env` **values** differ, never the
variable **names**. To bring a fresh checkout up locally:

**Backend** (`tunevote_api`):

```bash
cp .env.example .env          # fill in local values (DB_HOST=localhost, etc.)
docker compose up -d          # MySQL 8 + phpMyAdmin (phpMyAdmin on :8080)
# load the canonical schema once, then apply migrations:
#   import init.sql into the `tunevote` database, then:
npm ci
npm run migrate:latest
node index.js                 # API on http://localhost:4000
```

**Frontend** (`tunevote_frontend`):

```bash
cp .env.example .env          # VITE_API_URL=http://localhost:4000/
npm ci
npm run dev                   # http://localhost:5173
```

> ⚠️ **Known caveat (from the README):** several frontend files still hardcode
> `https://api.tunevote.com/`. Until that's refactored to use `VITE_API_URL`,
> those pages hit **prod** even when running locally. Consolidating to the env
> var is the fix that makes local/prod truly identical.

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

```bash
vps 'set -e
  cd /var/www/tunevote_api          # ⚠️ CONFIRM path
  git fetch origin
  git reset --hard origin/main      # deploy target is never hand-edited, so this is safe & intended
  npm ci --omit=dev                 # reproducible install from package-lock
'
```

Then (after §6 if applicable) restart and persist:

```bash
vps 'pm2 restart tunevote_api && pm2 save && pm2 status'
```

`pm2 status` must show `tunevote_api` as **online**. If it's `errored`, read the
logs immediately:

```bash
vps 'pm2 logs tunevote_api --lines 40 --nostream'
```

---

## 6. Database migrations — only when the schema changed

**Back up before touching the schema. This is not optional** — the archive
records the `youtube_video_cache` table being lost to un-backed-up overwrites
(problem #2).

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
    --single-transaction --routines "$DB_NAME" > "$OUT" 2>/dev/null
  gzip -k "$OUT"
  ls -lh "$OUT"*
  grep -c "^CREATE TABLE" "$OUT"'
```

> If `$DB_USER` lacks privileges for `--routines`/locking, use root instead:
> `docker exec mysql mysqldump -uroot -p"$DEPLOY_DB_ROOT_PASSWORD" ...`
> **Do not continue if the dump is empty or the table count looks wrong.**

### 6.3 Review, then apply (Knex)

```bash
vps 'cd /var/www/tunevote_api && npm run migrate:status'   # shows what WOULD run, changes nothing
vps 'cd /var/www/tunevote_api && npm run migrate:latest'   # apply
```

Migrations are idempotent (INFORMATION_SCHEMA-guarded); re-running is safe.

### 6.4 Verify the schema matches the canonical source

```bash
vps 'cd /var/www/tunevote_api && npm run verify-schema'    # exit 0 = live DB matches init.sql
```

Then re-run the §6.1 count query and confirm existing rows are unchanged.

---

## 7. Deploy the frontend

Build **locally** and upload the static artifacts. Do **not** build on the server
(the archive's problem #7: the frontend ran on the VPS and wasted its resources).

```bash
cd ~/Documents/tunevote_frontend
# ensure .env points VITE_API_URL at the prod backend for the prod build:
#   VITE_API_URL=https://api.tunevote.com/
npm ci
npm run build                 # outputs to dist/
```

Confirm the bundle targets prod, then upload the **contents** of `dist/`
(including any dotfiles) to the web root:

```bash
grep -o 'https://api.tunevote.com' dist/assets/*.js | head -1   # must print the prod URL

# ⚠️ CONFIRM the web root path first
FE_ROOT=/var/www/html
sshpass -p "$DEPLOY_SSH_PASSWORD" rsync -az --delete -e "ssh -p ${DEPLOY_SSH_PORT:-22} -o StrictHostKeyChecking=accept-new" \
  dist/ "$DEPLOY_SSH_USER@$DEPLOY_SSH_HOST:$FE_ROOT/"
```

`--delete` removes stale old-build files so no orphaned hashed chunks linger. If
`rsync` isn't available on the server, `scp -r dist/. ...` works but leaves old
files behind — clear the directory first in that case.

Static files need no service restart. Only reload nginx if you changed nginx
config:

```bash
vps 'sudo nginx -t && sudo systemctl reload nginx'
```

---

## 8. Confirm the deploy succeeded (mechanical checks only)

These confirm the *deployment* worked — not that a feature works (that's the
user's testing). All should be green before you report done.

```bash
# Backend process is up
vps 'pm2 status | grep tunevote_api'

# Endpoints answer
curl -s -o /dev/null -w "api:       %{http_code}\n" https://api.tunevote.com/
curl -s -o /dev/null -w "dashboard: %{http_code}\n" https://app.tunevote.com/

# The live dashboard references the bundle you just built (hashes match)
curl -s https://app.tunevote.com/ | grep -o 'assets/index-[A-Za-z0-9_-]*\.js' | head -1
ls ~/Documents/tunevote_frontend/dist/assets/ | grep -o 'index-[A-Za-z0-9_-]*\.js' | head -1

# If a migration ran, it's recorded
vps 'cd /var/www/tunevote_api && npm run migrate:status'
```

Report the results to the user and hand off for feature testing.

---

## 9. Rolling back

**Backend code** — redeploy the previous commit:

```bash
vps 'cd /var/www/tunevote_api && git reset --hard <previous-commit> && npm ci --omit=dev && pm2 restart tunevote_api'
```

**Frontend** — rebuild the previous commit locally and re-run §7, or keep the
prior `dist/` and re-upload it.

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
- [ ] (Backend) `git reset --hard origin/main` + `npm ci --omit=dev` on the server
- [ ] (Schema) Row counts recorded **before** touching the DB
- [ ] (Schema) Database backed up, dump verified non-empty
- [ ] (Schema) `migrate:status` reviewed → `migrate:latest` applied → `verify-schema` exit 0
- [ ] (Backend) `pm2 restart tunevote_api`, status **online**, `pm2 save`
- [ ] (Frontend) Built locally against prod `.env`, bundle targets `api.tunevote.com`
- [ ] (Frontend) `dist/` uploaded with `--delete`, live hash matches local hash
- [ ] Endpoints return expected HTTP codes
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
