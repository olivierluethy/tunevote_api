# Database Security Architecture — private DB, no public phpMyAdmin

**Date:** 2026-08-26 · **Issue:** [#53](https://github.com/olivierluethy/tunevote_api/issues/53)
· **Status:** repo/config hardening ✅ done here · live VPS steps ⏳ runbook below

> **Principle:** *Expose only what TuneVote actually needs to expose.* The frontend
> (`app.tunevote.com`) and the Node/Socket.io backend (`api.tunevote.com`) are public.
> The database and its administration interface (phpMyAdmin) are **private**.

---

## 1. Target architecture

```text
                         INTERNET
                            │
              ┌─────────────┴─────────────┐
              │                           │
              ▼                           ▼
        app.tunevote.com            api.tunevote.com
        Frontend (cPanel)           Node.js Backend (VPS, PM2)
                                      │  Socket.io
                                      ▼
                              MySQL / MariaDB
                              PRIVATE ONLY
                              127.0.0.1:3306   ← loopback, never 0.0.0.0

        phpMyAdmin  ── NOT publicly served ── reachable only via SSH tunnel
                       (compose "admin" profile, bound to 127.0.0.1:8080)
```

The Node backend runs on the **same VPS** as MySQL and connects over `127.0.0.1:3306`.
Because MySQL binds to loopback, that host-local connection keeps working while the
database is unreachable from the public internet. Socket.io is unaffected — it lives
in the same Node process and is exposed through `api.tunevote.com` exactly as before.

Keeping MySQL on the VPS is a valid architecture; the fix is **not** to move it, only
to make sure it is not reachable from the internet merely because it runs there.

---

## 2. What changed in the repository (this issue)

| File | Change | Why |
|---|---|---|
| `docker-compose.yml` | MySQL port `"3306:3306"` → `"127.0.0.1:3306:3306"` | Publishes the DB on loopback only; never on `0.0.0.0`. The Node app on the same host still connects. |
| `docker-compose.yml` | phpMyAdmin moved behind `profiles: [admin]`, port `"8080:80"` → `"127.0.0.1:8080:80"`, `restart: "no"` | `docker compose up -d` no longer starts phpMyAdmin. When explicitly started it binds to loopback, so it is only reachable through an SSH tunnel — never a public subdomain. |
| `docker-compose.yml` | Hard-coded `rootpass123!` / `userpass123!` → `${MYSQL_ROOT_PASSWORD}` / `${MYSQL_USER}` / `${MYSQL_PASSWORD}` (from `.env`) | Production credentials must not be committed to the repo. Compose interpolates them from the git-ignored `.env`. |
| `docker-compose.yml` | Dropped `MYSQL_ROOT_PASSWORD` from the phpMyAdmin service | phpMyAdmin now uses interactive login; no root password baked into a container's env. |
| `.env.example` | Added `MYSQL_ROOT_PASSWORD` / `MYSQL_DATABASE` / `MYSQL_USER` / `MYSQL_PASSWORD` placeholders and DB-privacy notes | Documents the new provisioning vars without committing real secrets. |
| `DEPLOYMENT.md` | Notes phpMyAdmin is private + MySQL loopback-only, and the `admin`-profile/tunnel workflow | Keeps the runbook truthful so future deploys don't re-expose the DB. |

> **Note on secrets already in git history.** The old compose file committed
> `rootpass123!` / `userpass123!`, and per `DEPLOYMENT.md`/README some API keys leaked
> historically. Changing the file forward does **not** purge history — the real fix is to
> **rotate** those credentials on the VPS (see runbook step 5). History rewriting is out of
> scope for this change and should be a deliberate, separate operation.

---

## 3. Secure administrative access — SSH tunnel (replaces the public subdomain)

There is no `phpmyadmin.tunevote.com` anymore. Two supported ways to administer the DB,
both over the encrypted SSH channel you already use to deploy — no DB port and no admin
UI is ever published to the internet.

### A) Direct MySQL client over an SSH tunnel

```bash
# From your workstation — forward local 3306 to the VPS's loopback MySQL:
ssh -N -L 3306:127.0.0.1:3306 <DEPLOY_SSH_USER>@<DEPLOY_SSH_HOST>
# then, in another terminal, point any MySQL client at 127.0.0.1:3306
mysql -h 127.0.0.1 -P 3306 -u <DB_USER> -p <DB_NAME>
```

### B) phpMyAdmin, on-demand, over an SSH tunnel

```bash
# On the VPS (over SSH): start phpMyAdmin only while you need it
docker compose --profile admin up -d phpmyadmin

# From your workstation: forward local 8080 to the container's loopback bind
ssh -N -L 8080:127.0.0.1:8080 <DEPLOY_SSH_USER>@<DEPLOY_SSH_HOST>
# browse http://localhost:8080  → log in with a least-privilege DB user

# When finished, stop it again so nothing admin-related is left running
docker compose --profile admin stop phpmyadmin
```

Neither port `3306` nor `8080` is opened in the firewall — the tunnel rides the existing
SSH connection, so credentials and traffic are always encrypted.

---

## 4. VPS runbook — apply on the box (ops, not code)

These are the live-server steps that finish the issue. They are intentionally **not** run
automatically from the repo; execute them over SSH (see `DEPLOYMENT.md` for the `vps` helper).
Each maps to an acceptance criterion.

```bash
# 1. Remove the public phpMyAdmin vhost (criterion 1)
#    Find and delete/disable the nginx server block for phpmyadmin.tunevote.com,
#    then drop its DNS record. Example:
sudo rm -f /etc/nginx/sites-enabled/phpmyadmin.tunevote.com
sudo nginx -t && sudo systemctl reload nginx
#    Then remove the phpmyadmin.tunevote.com DNS A/CNAME record at the DNS provider.

# 2. Recreate MySQL bound to loopback (criteria 2 & 3)
cd /var/www/tunevote_api
git pull                                   # picks up the hardened docker-compose.yml
#    Ensure .env has MYSQL_* set, then:
docker compose up -d mysql                 # now published on 127.0.0.1:3306 only
#    Verify the Node app still connects (criterion 3) and Socket.io still works (4):
pm2 restart tunevote_api && pm2 logs tunevote_api --lines 30 --nostream

# 3. Firewall — deny the DB/admin ports, keep only what's needed (criteria 6, 8, 9)
sudo ufw default deny incoming
sudo ufw allow 22/tcp                       # SSH (admin channel + tunnels)
sudo ufw allow 80/tcp && sudo ufw allow 443/tcp   # frontend/api via nginx
sudo ufw deny 3306/tcp                      # MySQL never public
sudo ufw deny 8080/tcp                      # phpMyAdmin never public
sudo ufw enable && sudo ufw status verbose

# 4. Verify nothing DB-related listens on a public interface (criteria 2, 9)
sudo ss -tlnp | grep -E ':3306|:8080'       # expect only 127.0.0.1 binds (or nothing)
#    From OUTSIDE the box, these must fail/timeout:
#    nc -vz <DEPLOY_SSH_HOST> 3306   ;   curl -m5 http://<DEPLOY_SSH_HOST>:8080

# 5. Rotate credentials that were in git history, and apply least privilege (criteria 10, 11)
#    - Change the MySQL root and app-user passwords; update .env (never commit).
#    - Grant the app user only what it needs on the tunevote DB (no GRANT ALL, no root):
#      GRANT SELECT, INSERT, UPDATE, DELETE ON tunevote.* TO 'user'@'localhost';
#    - Confirm no MySQL account uses host '%': SELECT user, host FROM mysql.user;
```

---

## 5. Acceptance-criteria coverage

| # | Criterion | Where it's satisfied |
|---|---|---|
| 1 | `phpmyadmin.tunevote.com` not public | Runbook §4.1 (nginx vhost + DNS removal); repo no longer serves it by default |
| 2 | MySQL not reachable from the internet | `docker-compose.yml` loopback bind + firewall §4.3 + verify §4.4 |
| 3 | Node backend still connects | Same-host `127.0.0.1:3306`; `db.js`/`knexfile.js` unchanged (`DB_HOST=localhost`) |
| 4 | Socket.io still works | Backend process/exposure unchanged; verified in §4.2 |
| 5 | DB admin via a documented secure method | §3 SSH-tunnel workflows (MySQL client + phpMyAdmin `admin` profile) |
| 6 | Firewall/network reviewed, unneeded ports closed | Runbook §4.3–§4.4 |
| 7 | Credentials only over encrypted/local connections | SSH tunnels (encrypted) + loopback (local); no plain-HTTP admin path remains |
| 8 | Final architecture documented | This document + `DEPLOYMENT.md` updates |
| — | Credentials not committed to the repo | `docker-compose.yml` reads from git-ignored `.env`; hard-coded passwords removed |

**Repo scope (done in this change):** items that live in code/config — the compose bind,
the `admin` profile, env-sourced credentials, and this documentation.

**Ops scope (runbook, run on the VPS):** the nginx vhost + DNS removal, firewall rules,
and credential rotation. These require production access and are deliberately left to a
human/deploy step so they are applied intentionally.
