# Design: Generisches Change-Request- & Session-Event-Fundament

**Datum:** 2026-09-04
**Bezug:** GitHub-Issues #66, #67, #68 (tunevote_api) — erster Slice des Epics
"Dynamische, demokratisch steuerbare Session-Struktur".

## Ziel & Scope

Fundament, auf dem Loops, Undo, votable Session-Regeln, Metriken und das
Mobile-UX-Epic später aufsetzen. Dieser Slice baut **nur** den generischen Kern:

- ein persistentes, votebares **Change-Request**-System (Vorschlag → Ja-Stimmen →
  Auflösung), das **parallel** zum bestehenden `voting_rounds`-Song-Voting läuft
  (Koexistenz, kein Eingriff in die Song-Auswahl-Runden);
- einen append-only **Session-Event-Log** (Decision-Log) aller tatsächlich
  angewandten Änderungen, jeweils mit inverse-Info, damit demokratisches **Undo**
  später ohne Migration nachrüstbar ist;
- vier konkrete Change-Types als Beweis der generischen Mechanik.

**Bewusst NICHT in diesem Slice** (vorbereitet, nicht gebaut): Undo-Voting,
Multi-Option/Ranking/Nein-Stimmen, "ab N Likes → Vote", Live-Preview-Diagramme,
Loops, Reorder-UI, Session-Regeln-Voting, Metriken, volles Mobile-UX. **Keine
Tests in diesem Slice** (explizit vom Auftraggeber gewünscht).

## Datenmodell (additive Knex-Migration, ids sind signed INT)

- **`queue_items.sort_order DECIMAL(30,10) NULL`**, backfill `= id`. Next-Pick in
  `advanceToNext` und die Queue-List-Query wechseln zu
  `ORDER BY COALESCE(sort_order, id) ASC, id ASC` (Fallback = altes Verhalten).
- **`change_requests`**: `id, session_id (FK→sessions, CASCADE), type VARCHAR(64),
  payload JSON, proposed_by_user_id, proposed_by_guest_id,
  status ENUM('open','applied','rejected','expired','superseded','failed'),
  quorum_percent DECIMAL(5,4), expires_at DATETIME, resolved_at, resolution
  VARCHAR(64), applied_event_id INT, created_at`. Indizes:
  `(session_id,status)`, `(status,expires_at)`.
- **`change_request_votes`**: `id, change_request_id (FK→change_requests,
  CASCADE), user_id, guest_id, created_at`, UNIQUE `(cr,user_id)` /
  `(cr,guest_id)` (NULL-tolerant wie die bestehende `votes`-Tabelle). Approve-only.
- **`session_events`** (append-only): `id, session_id (FK, CASCADE), type
  VARCHAR(64), change_request_id INT, payload JSON, reversible BOOL, inverse JSON,
  actor JSON, created_at`. Index `(session_id,id)`.

## Handler-Registry (`services/changeRequests.js`)

Pro Type eine isolierte Einheit:
`{ quorumPercent, durationSeconds, validate(conn, session, payload),
apply(conn, session, payload) -> { eventType, eventPayload, reversible, inverse },
describe(payload) -> string }`. Neue Types = neuer Eintrag, kein Core-Change.

- **`skip_current`** (Quorum 0.5, 25s): `apply` markiert nur; der eigentliche
  Effekt (`advanceToNext(sessionId, expectedItemId)`) läuft **nach** dem
  CR-Commit in getrennter Lock-Domäne (CAS macht harmlosen No-op, falls der Song
  schon wechselte). `reversible: false`.
- **`insert_pause`** (0.5, 45s, payload `{after_item_id?, duration_seconds}`):
  INSERT `queue_item` `item_type='pause'`, `sort_order` = Midpoint hinter
  `after_item_id` (Default: hinter dem aktuell spielenden Item). `inverse` =
  dieses Item archivieren. `reversible: true`.
- **`remove_queued_item`** (0.5, 45s, payload `{queue_item_id}`): `queued →
  archived`. `inverse` = zurück auf `queued`. `reversible: true`.
- **`end_session`** (0.75, 45s): ruft extrahierten `endSession(sessionId,reason)`
  Helper (aus der End-Guard-Logik in `advanceToNext` herausgezogen).
  `reversible: false`.

## Lifecycle-Service

- **`create(sessionId, type, payload, proposer)`** — validiert; `expires_at =
  now + durationSeconds`; Quorum-Snapshot; INSERT; In-Memory-Timer armen;
  `change_request_created` emit.
- **`vote(crId, voter)`** — idempotenter Ja-Vote; Quorum neu prüfen → ggf. sofort
  `resolve` (early pass); `change_request_updated` emit.
- **`resolve(crId)`** — in `SELECT … FOR UPDATE`-Transaktion auf die CR-Zeile:
  offen? Ja-Stimmen / Anzahl `is_live`-Teilnehmer ≥ `quorum_percent`? → `apply`
  (Handler ausführen, `session_events` mit inverse schreiben, `applied`), sonst
  `rejected`/`expired`. Emits (`change_request_resolved` + Effekt-Events) **erst
  nach Commit**; verzögerte externe Effekte (skip-advance) danach.
- **Durable Reconciler** — neue Phase in `services/scheduler.js`: scannt
  `change_requests WHERE status='open' AND expires_at <= NOW()` und ruft
  `resolve` → überlebt Neustart (analog `current_plays_until`).

Quorum-Nenner = aktuell live-verbundene Teilnehmer (`is_live=1`). Nur solche
dürfen abstimmen (analog #13-Check im Song-Voting).

## API (`routes/changeRequests.js`) & Sockets

- `POST /sessions/:id/change-requests` — Change Request erstellen (Live-Session +
  Live-Teilnehmer erforderlich).
- `GET /sessions/:id/change-requests` — offene + jüngste Requests inkl. Vote-Count
  und Live-Teilnehmerzahl.
- `POST /change-requests/:crId/vote` — Ja-Vote (idempotent, nur Live-Teilnehmer).
- `GET /sessions/:id/events` — Decision-Log.
- Socket-Events: `change_request_created`, `change_request_updated`,
  `change_request_resolved` (+ bestehende `queue_updated`, `playback_sync`,
  `pause_started`, `session_ended`).

## Frontend (minimal)

- `ChangeRequestBanner` (analog `VotingBanner`): offene Requests mit
  `describe()`-Text, Ja-Count / Live-Count, Countdown, großer Vote-Button.
- Quick-Action-Auslöser mit den vier Types.
- Socket-Handler für die drei neuen Events in `SessionPage`/`PlaybackContext`.

## Folge-Slices (umgesetzt im selben Zug)

Auf dem Fundament aufbauend, ohne dessen Kern zu ändern:

- **Demokratisches Undo** — neuer Change-Type `undo_event` (payload `{event_id}`):
  führt die im Event gespeicherte `inverse`-Operation aus und markiert das Event
  `undone_at` (Migration `20260904000002`). Nur reversible, noch nicht rückgängig
  gemachte Events sind wählbar. `applyInverse` deckt `archive_item`,
  `requeue_item`, `archive_items`, `restore_sort_order` ab.
- **Loops** — `create_loop` (payload `{queue_item_ids, repeat 2..10}`, Default =
  aktueller Song): fügt `repeat`×Kopien direkt nach dem laufenden Song ein
  (sort_order gleichmäßig verteilt). `inverse` = alle eingefügten Kopien
  archivieren → per Undo entfernbar.
- **Reorder** — `move_item` (payload `{queue_item_id, after_item_id|null}`,
  null = ganz nach vorne): setzt `sort_order` neu; `inverse` =
  `restore_sort_order` auf den alten Wert.
- **Live-Preview** (#67 §5) — jeder offene Change-Request-DTO trägt ein
  `preview: { before, after }` (die nächsten Queue-Labels als „Jetzt → Danach"),
  berechnet aus einem `queueWindow`-Snapshot pro Handler.
- **Mobile-First-UX** (#68, erster Schritt) — `BottomSheet` (Slide-up, große
  Touch-Targets, Swipe-to-close), Steuerzentrale `QuickChangeActions`
  (Schnellaktionen + pro-Song Als-Nächstes/Loop/Entfernen), `ChangeHistory`-Sheet
  mit Undo, Preview-Darstellung im Banner.

## Integrations-Risiken

- Einziger Eingriff in die Playback-Engine: `ORDER BY`-Wechsel (Fallback auf id =
  verhaltensneutral) + Extraktion von `endSession`. `skip_current` ruft
  `advanceToNext` unverändert.
- Zwei parallele `resolve` desselben CR: durch `FOR UPDATE` + Status-Recheck
  serialisiert → höchstens ein `applied`.
