# C3b — Drop is_active + is_live (READY TO RUN — gated on C2 deploy)

**⚠️ Do NOT run until the C2 frontend (reads `status`) is deployed to production.**
Any browser still running the old frontend reads `sessions.is_live`; dropping it
first breaks those clients. The current dual-write state is the safe bridge.

After C1 (add `status` + dual-write) and C3a (backend reads `status`, `is_active`
removed), `is_live` is now used ONLY as: dual-write, return value, and the
`createNewPublicSession` insert. C3b removes all of those, then drops the columns.

## Step 1 — code changes (make `status` the only session lifecycle field)

- `routes/sessions.js`
  - `/start`: `SET is_live = 1, status = 'live'` → `SET status = 'live'`
  - `GET /sessions` (3 SELECTs): remove the `s.is_live,` / `s.is_live, ` column
  - `GET /sessions/:id`: `res.json({ ...sess[0], hostId: sess[0].user_id, is_live: !!sess[0].is_live })`
    → `res.json({ ...sess[0], hostId: sess[0].user_id })`
- `services/playback.js`
  - phase-timer end: `SET is_live = 0, status = 'ended', ended_at = NOW()` → `SET status = 'ended', ended_at = NOW()`
  - `advanceToNext` end: `SET is_live = 0, status = 'ended', ended_at = NOW()` → `SET status = 'ended', ended_at = NOW()`
  - `createNewPublicSession` insert: drop `is_live` column + its `0` value from
    `(user_id, title, is_private, is_live, created_at) VALUES (1, ?, 0, 0, NOW())`
    → `(user_id, title, is_private, created_at) VALUES (1, ?, 0, NOW())`
- `services/scheduler.js`
  - dead-session end: `SET is_live = 0, status = 'ended', ended_at = NOW()` → `SET status = 'ended', ended_at = NOW()`
  - **KEEP** the participant reaper `UPDATE session_participants ... is_live` — that column stays.
- **Do NOT touch** any `session_participants.is_live` — that is a different, retained column.

## Step 2 — migration `migrations/20260704000005_drop_sessions_is_live.js`

```js
exports.up = async (knex) => {
  await knex.schema.alterTable("sessions", (t) => {
    t.dropColumn("is_active");
    t.dropColumn("is_live");
  });
};
exports.down = async (knex) => {
  await knex.schema.alterTable("sessions", (t) => {
    t.tinyint("is_active").defaultTo(1);
    t.tinyint("is_live").defaultTo(0);
  });
  await knex.raw("UPDATE sessions SET is_live = (status = 'live'), is_active = 1");
};
```

## Step 3 — tests / fixtures

- `test/helpers/fixtures.js`: drop `is_live` from the sessions insert (keep `status = 'live'`).
- `test/session_status.test.js`: drop the `is_live` insert column + the `is_live` mirror assertion (status is now the only field). Keep the `status='ended'` assertion.
- Run the full suite (`node test/run.js test/*.js`), boot smoke, commit:
  `git commit -m "Drop sessions.is_active and is_live; status is the sole lifecycle column"`.

## Deploy order recap
C1 (done) → C2 frontend (done, must be **deployed**) → **verify new frontend live** → C3b (this).
