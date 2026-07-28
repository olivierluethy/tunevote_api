# Production text-encoding repair (UTF-8 ← MySQL-latin1 double-encoding)

**Status: DONE — applied to production on 2026-07-28.** 38,837 corrupt
`youtube_video_cache.title` rows repaired (one legacy row was triple-encoded and
took a second layer; the script's loop-until-dry handled it in the follow-up
run). Final state: **0 remaining mojibake**; a re-run reports 0 changes; the live
API returns `Rag’n’Bone Man - Guilty …` with the apostrophe as `E2 80 99`.
Pre-repair backup: `/root/tunevote-backups/tunevote-pre-encoding-repair-20260728-205510.sql`
(41 MB). The section below is retained as the diagnosis + runbook of record.

Symptom: song titles with non-ASCII characters render garbled in production
(`app.tunevote.com`) but correctly on localhost — e.g. `Rag’n’Bone Man - Guilty`
shows as `Ragâ€™nâ€™Bone Man - Guilty`.

---

## 1. Diagnosis

**Root cause: #2 — storage-side double-encoding.** The database *stores* the
wrong bytes; the display path is correct. Evidence (production, read-only):

```
-- id 50620, "Rag'n'Bone Man - Guilty (Live from Heitere Open Air Festival)"
HEX(title) = 5261 67 C3A2E282ACE284A2 6E C3A2E282ACE284A2 42 6F6E65204D616E ...
                  ^^^^^^^^^^^^^^^^ the apostrophe ’ is stored as 8 bytes
```

`C3A2 E282AC E284A2` is the UTF-8 encoding of the three characters `â € ™` —
i.e. the apostrophe `’` (U+2019, UTF-8 `E2 80 99`) was written while the client
connection was **latin1**, so MySQL read those 3 UTF-8 bytes as 3 latin1
characters and re-encoded each to utf8mb4. A correct row stores the apostrophe
as `E2 80 99`.

### Where the corruption came from

Production MySQL negotiates **latin1** for clients that don't force a charset:

```
character_set_client     = latin1
character_set_connection = latin1
character_set_results    = latin1
collation_connection     = latin1_swedish_ci
```

A legacy bulk import of the YouTube cache ran over such a latin1 session and
double-encoded every non-ASCII title. The application connection was later fixed
to `utf8mb4` (see §2), so **new** rows are correct — the database is now a *mix*
of correct and corrupted rows.

### Scope — exactly one column is affected

Read-only detection across every user-visible text column (safe round-trip test,
not a string search):

| table.column                     | rows   | mojibake |
|----------------------------------|--------|----------|
| **youtube_video_cache.title**    | 98,968 | **38,837** |
| youtube_video_cache.title_norm   | 98,968 | 0 |
| artists.name / name_norm         | 224    | 0 |
| sessions.title                   | 38     | 0 |
| users.username                   | 31     | 0 |
| guest_users.nickname             | 55     | 0 |
| shouts.message                   | 5      | 0 |
| queue_items.description          | 13,392 | 0 |

Only `youtube_video_cache.title` holds mojibake: **38,837 of 98,968 rows**
(≈39%). `title_norm` is clean because `normalize()` strips non-word characters.
43,952 title rows contain genuine, correctly-stored non-ASCII (real emoji, real
curly quotes) and are left untouched.

### Prod-vs-local differences found (the actual bug is here)

| aspect | localhost | production | is it the bug? |
|---|---|---|---|
| **youtube_video_cache.title data** | clean utf8mb4 | 38,837 double-encoded rows | **YES — the bug** |
| MySQL client session default | utf8mb4/latin1 (fresh) | **latin1** default | the historical *vector* (an import that didn't set charset got double-encoded) |
| App DB connection charset | utf8mb4 | utf8mb4 | no (already fixed) |
| Schema (tables + columns) | utf8mb4 | utf8mb4 | no |
| API `Content-Type` | `…; charset=utf-8` | `…; charset=utf-8` | no |
| HTML `<meta charset>` | UTF-8 | UTF-8 | no |
| Process locale (PM2) | — | `LANG=C.UTF-8` | no (UTF-8-capable) |

There is **no remaining code/schema/connection difference** — the only
difference is the legacy data, plus the server's latin1 client-session default
(harmless now that the app forces utf8mb4, but the reason a past import corrupted
the data).

---

## 2. Pipeline hardening — status

The chain is already hardened (connection fix shipped in the prior session);
verified this session:

- **DB connection charset = `utf8mb4`** in *every* place a connection opens —
  `db.js` (app pool), `knexfile.js` (migrations), and `scripts/repair-encoding.js`
  (repair pool). No other component opens its own connection.
- **Schema** — all tables/columns already `utf8mb4` (`utf8mb4_0900_ai_ci`, and
  `utf8mb4_unicode_ci` on `shouts`). Nothing to convert.
- **API responses** — `Content-Type: application/json; charset=utf-8` (Express
  default), confirmed on the live endpoint.
- **HTML** — `<meta charset="UTF-8">` present in `index.html`.
- **Ingestion** — YouTube Data API (axios) and ytdl return UTF-8 JSON parsed to
  JS strings; all inserts are parameterized through the utf8mb4 pool. No
  re-encoding anywhere.
- **Process locale** — PM2 runs with `LANG=C.UTF-8` (UTF-8-capable).

The new **regression test** (`test/encoding_roundtrip.test.js`,
`npm run test:encoding`) fails if this ever regresses: it writes `’ ä ü é – 😀`,
asserts the stored bytes (`HEX` = `E28099` for the apostrophe, no `C3A2E282AC`),
serves it over the real HTTP route, and checks the response bytes.

---

## 3. Data repair — `scripts/repair-encoding.js`

A standalone, controlled script (not an auto-running Knex migration — you do NOT
want a 38k-row rewrite firing on every deploy). It repairs with MySQL's own
`latin1` round-trip:

```sql
CONVERT(BINARY(CONVERT(col USING latin1)) USING utf8mb4)
```

**Why MySQL `latin1`, not a JS cp1252 library:** the corruption was performed by
MySQL's latin1, so only MySQL's latin1 is its exact inverse. MySQL latin1 is a
full, symmetric 256-value table; iconv-lite's `windows-1252` maps the 5
CP1252-undefined bytes (`0x81/0x8D/0x8F/0x90/0x9D`) asymmetrically and silently
fails to reverse ~19k rows — every double-encoded curly quote `”`/`“` (3rd byte
`0x9D`). The first draft of this script used iconv-lite and under-counted 38,837
→ 19,977; the SQL-driven version fixes all 38,837.

Safety properties (all verified):

- **Dry-run by default**; `--apply` required to write.
- **Backup-gated**: `--apply` exits 3 unless a fresh dump exists (prints the
  exact `mysqldump` command). Verified it refuses.
- **Idempotent & safe**: only rows whose latin1 bytes decode to a *different,
  valid* UTF-8 string *and* that are losslessly latin1-encodable are touched.
  Genuine emoji / accents / correct quotes are never damaged; a second run
  changes 0 rows (a repaired value's latin1 bytes are no longer valid UTF-8).
- **Byte-exact & concurrency-guarded**: updates by PK with a `HEX(col)` guard so
  a row edited underneath the run is never clobbered.
- **Auditable**: logs every `changed` (id, before, after) and every
  `unrepairable` row to a JSONL log file.
- **Covers all** diagnosed text columns (no-op on the clean ones).

### Dry-run output (production, read-only — already run)

```
• youtube_video_cache.title: scanned 98968, would change 38837, unrepairable 1 (logged, skipped)
  (all other target columns: would change 0)
Rows to change: 38837   Rows skipped (clean): 159679   Unrepairable: 1
Sample:  "…Iâ€™m a Freak…"        → "…I’m a Freak…"
         "…Here We Goâ€¦ Again"    → "…Here We Go… Again"
         "…cassÃ¶ remix…"          → "…cassö remix…"
         "…From â€œTop Gun…â€…"     → "…From “Top Gun…”…"
         "ðŸ˜­ðŸ˜­…"                 → "😭😭…"   (double-encoded emoji)
```

The 1 `unrepairable` row has a broken/partial byte sequence and is logged and
skipped, never written.

### How to run it against production

All commands run on the VPS as root (see `DEPLOYMENT.md §1` for the `vps` helper).
The script needs the app's `node_modules`, so run it from the code directory.

**1. Back up first (mandatory — the script enforces it):**

```bash
vps 'echo "$DEPLOY_SSH_PASSWORD" | sudo -S bash -c "
  set -a; . /var/www/tunevote_api/.env; set +a
  mkdir -p ~/tunevote-backups
  OUT=~/tunevote-backups/tunevote-pre-encoding-repair-$(date +%Y%m%d-%H%M%S).sql
  docker exec mysql mysqldump -u\"\$DB_USER\" -p\"\$DB_PASSWORD\" --single-transaction --routines \"\$DB_NAME\" > \$OUT
  ls -lh \$OUT"'
```

**2. Deploy the script** (normal deploy — commit, push, `git reset --hard`
origin/main on the VPS; see `DEPLOYMENT.md §5`). No PM2 restart or migration is
needed for this script.

**3. Dry-run on prod, review, then apply:**

```bash
# Dry-run (read-only):
vps 'echo "$DEPLOY_SSH_PASSWORD" | sudo -S bash -c "cd /var/www/tunevote_api && node scripts/repair-encoding.js"'

# Apply (auto-detects the fresh dump from step 1):
vps 'echo "$DEPLOY_SSH_PASSWORD" | sudo -S bash -c "cd /var/www/tunevote_api && node scripts/repair-encoding.js --apply"'

# Re-run — must report 0 rows to change (idempotency check):
vps 'echo "$DEPLOY_SSH_PASSWORD" | sudo -S bash -c "cd /var/www/tunevote_api && node scripts/repair-encoding.js"'
```

`npm run repair:encoding` is the same as the bare `node scripts/repair-encoding.js`.

### Rolling back

Restore the pre-repair dump from step 1 (`DEPLOYMENT.md §9`). Because the repair
is byte-exact and logged (`changed` entries carry before/after), individual rows
can also be reverted from the log if ever needed.

---

## 3a. Prevention — so it never recurs

Adding songs/titles **through the app** is already safe (utf8mb4 pool, utf8mb4
columns, UTF-8 ingestion). These layers close the remaining out-of-band paths
(manual imports, CLI/phpMyAdmin, a future script, restoring an old dump):

1. **Server forces utf8mb4 (root cause, closed at the source).**
   `docker-compose.yml` runs MySQL with:
   ```
   --character-set-server=utf8mb4
   --collation-server=utf8mb4_0900_ai_ci
   --skip-character-set-client-handshake
   ```
   `--skip-character-set-client-handshake` makes the server **ignore** the
   charset a client requests and use utf8mb4. Previously the server handed out
   **latin1** to any client that didn't ask for utf8mb4 — the exact hole the
   original import fell through. Now the CLI, phpMyAdmin, an import, or a script
   that forgets `charset` all get utf8mb4. **Applied to prod on 2026-07-28** —
   verified: a client requesting no charset now reports
   `character_set_client/connection/results = utf8mb4` (was `latin1`).

   > **Ops caveat:** the VPS's `docker-compose` is v1.29.2, incompatible with the
   > current Docker Engine (`KeyError: 'ContainerConfig'` on recreate — it deletes
   > the container then fails to rebuild it). So the `mysql` container is managed
   > with plain `docker run`, not compose. To change its config, re-run (data
   > lives on the named volume `tunevote_api_mysql_data`; **back up first**):
   > ```bash
   > docker rm -f mysql
   > docker run -d --name mysql --restart always --network tunevote_api_default -p 3306:3306 \
   >   -e MYSQL_ROOT_PASSWORD=… -e MYSQL_DATABASE=tunevote -e MYSQL_USER=user -e MYSQL_PASSWORD=… \
   >   -v tunevote_api_mysql_data:/var/lib/mysql \
   >   mysql:8.0 \
   >   --character-set-server=utf8mb4 --collation-server=utf8mb4_0900_ai_ci \
   >   --skip-character-set-client-handshake
   > ```
   > (Env vars are ignored once the data dir exists — existing users/passwords are
   > preserved.) `docker-compose.yml` keeps the same flags for local dev and as the
   > source of truth; fixing compose on the host means installing Compose v2.

2. **App fails fast on a wrong charset.** `index.js` checks
   `@@character_set_client/connection/results` at startup and refuses to boot if
   any is not utf8mb4 — a misconfiguration surfaces immediately instead of
   silently corrupting writes.

3. **Static guard test.** `npm run test:charset-guard`
   (`test/db_charset_guard.test.js`) fails if any source file opens a DB
   connection without `charset: "utf8mb4"`, so a future connection can't
   regress. Plus `npm run test:encoding` proves a full write→read→API round-trip.

4. **Import / backup discipline.**
   - Dumps: always `mysqldump --default-character-set=utf8mb4`; the file must be
     UTF-8 (`file -I dump.sql`).
   - Restores: always `mysql --default-character-set=utf8mb4 < dump.sql`.
   - **Never restore a pre-2026-07-28 backup** — those still hold the old
     mojibake and would reintroduce it. If you must, re-run
     `node scripts/repair-encoding.js --apply` afterwards.

## 4. Acceptance criteria — how each is met

- `Rag’n’Bone Man - Guilty` renders identically on prod and localhost → after
  `--apply`, id 50620's title decodes correctly (dry-run preview confirms).
- `SELECT HEX(title)` returns `E28099` for the apostrophe → the repair rewrites
  `C3A2E282AC…` to `E28099` (verified in the dry-run's before/after and the
  Verification block).
- A newly ingested song with `’ ä ü é – 😀` stores and renders correctly with no
  manual step → guaranteed by the already-utf8mb4 pipeline and locked in by
  `test/encoding_roundtrip.test.js`.
- Re-running the repair reports zero changed rows → idempotency proven (a fixed
  value's latin1 bytes are not valid UTF-8, so it is not re-selected).
