# Design: Benannte Session-Abschnitte (#66, Slice 1)

**Datum:** 2026-09-05
**Bezug:** GitHub-Issue #66 — „verschachtelte Bausteine / Session-Struktur",
erste, risikoarme Realisierung als **benannte Abschnitte**.

## Ziel

Die Session in benannte Blöcke gliedern („Warm-up", „Peak", „Chill"), die man
als Ganzes überspringen oder anspringen kann. Jeder Abschnitt ist eine Menge
gequeueter Items (Songs/Pausen/Loop-Kopien). **Alle** Abschnitts-Operationen sind
demokratische Change Requests (votebar + undo-fähig) — konsistent mit dem Epic.

## Architektur — die Playback-Engine bleibt unangetastet

Abschnitte werden **rein über die vorhandenen Primitive** (`sort_order`,
`status`) realisiert, NICHT über eine neue Baum-Traversierung. `advanceToNext`
bleibt exakt `ORDER BY COALESCE(sort_order, id)` — kein Eingriff in die
reliability-kritische Kern-Engine.

- **`sections`** `{id, session_id (FK CASCADE), name, status('active'|'archived'),
  created_by_user_id, created_by_guest_id, created_at}`.
- **`queue_items.section_id`** (nullable) — ordnet ein Item einem Abschnitt zu.
- Ein Abschnitt ist die Menge seiner Items. Operationen sind Bulk-Updates auf
  `sort_order`/`status` (dieselben, die move_item/remove_queued_item nutzen).

## Change-Types (alle demokratisch)

- **`create_section {name, queue_item_ids}`** — ausgewählte gequeuete Songs zu
  einem benannten Abschnitt bündeln (setzt `section_id`; keine sort_order-Änderung
  in Slice 1). Inverse: `unassign_section` (section_id lösen + Section archivieren).
- **`skip_section {section_id}`** — die noch `queued` Items des Abschnitts
  archivieren. Inverse: `requeue_items` (Items zurück auf `queued`).
- **`jump_to_section {section_id}`** — die Items des Abschnitts direkt hinter den
  aktuellen Song setzen (neue `sort_order`, gleichmäßig verteilt). Inverse:
  `restore_sort_orders` (alte Werte).

Neue `applyInverse`-Ops: `unassign_section`, `requeue_items`,
`restore_sort_orders`.

## API / Frontend / Sockets

- `GET /sessions/:id/sections` → Abschnitte mit Items (Titel, Typ, Status) und
  `queued_count`.
- Socket `sections_updated` (ohne Payload) → Frontend lädt neu.
- `SectionsSheet`: Abschnitt erstellen (Songs wählen + Name), Liste der Abschnitte
  mit „Überspringen"/„Anspringen" — jeweils als Abstimmung.

## Bewusst Slice 2 (später)

Abschnitte umsortieren (`move_section`), umbenennen, „aktueller Abschnitt" für neu
hinzugefügte Songs, Loops explizit als Abschnitts-Bausteine, Sektions-Sprünge als
Weichen.

## Migration

`sections`-Tabelle + `queue_items.section_id` (additiv/nullable). Keine Tests
(auf Wunsch des Auftraggebers).
