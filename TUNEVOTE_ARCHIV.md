# TuneVote — Historien-Archiv & Ablösung der Handbuch-Doku

> Zweck: Die über Monate gewachsene Notizsammlung wird **nicht gelöscht, sondern eingefroren**.
> Dieses Dokument zeigt, *wie* früher gearbeitet wurde, *warum* es so gemacht wurde, *was daran
> weh tat* — und was der heutige Ersatz dafür ist.
>
> Status: Archiv. Ab hier gilt der Workflow in Kapitel 13, nicht mehr die alten Anleitungen.

---

## 0. SOFORTMASSNAHME — Kompromittierte Zugangsdaten

Die Notizdatei enthält im Klartext:

| Was | Wo | Massnahme |
|---|---|---|
| GitHub Personal Access Token (`ghp_…`) | ~60× in den `git clone` / `git remote set-url` Zeilen | **Sofort widerrufen** — github.com → Settings → Developer settings → Personal access tokens → Revoke |
| MySQL root-Passwort (`rootpass123!`) | Docker-/Import-Befehle | Rotieren |
| MySQL user-Passwort (`userpass123!`) | Python-Connect-Snippet | Rotieren |
| Zwei generierte Secrets (`openssl rand -base64 24` Output, Base64-Key) | Notizen | Als verbrannt betrachten, neu generieren |
| VPS-IP + SSH-Benutzername | Notizen | Passwort-Login deaktivieren, nur noch SSH-Key |

**Der Token ist der kritische Punkt.** Er hat Zugriff auf *alle* aufgelisteten Repos —
privat wie geschäftlich (`David-OW-Web/*`). Ein einziger Fund reicht, um alles zu klonen
oder zu überschreiben.

Zusätzlich prüfen:

```bash
# Steckt der Token irgendwo in der Git-History?
git log -p --all -S 'ghp_' -- . | head

# Steckt er noch in einer Remote-URL?
git remote -v
```

Danach Remotes auf SSH oder auf `gh auth login` umstellen — nie wieder Token in URLs:

```bash
git remote set-url origin git@github.com:<user>/<repo>.git
```

Neuer Standard: `gh auth login` (Credential-Helper) oder Fine-grained PAT in
`~/.config/gh/hosts.yml` / `.env`, niemals in Notizen oder Repo-Dateien.

---

## 1. Zeitstrahl in Kürze

| Phase | Zeitraum | Kennzeichen |
|---|---|---|
| **0 — Idee** | 1. Oktober 2025, Delta-Logic-Zeit | Musik im Büro, Frage: „warum gibt es keine schlichte Song-Queue-Session?" — schriftlich festgehaltene Vision, siehe Kapitel 1a |
| **1 — Konzeptbeweis** | Start | Handgeschriebenes `index.html`, um der KI die Vorstellung überhaupt erklärbar zu machen |
| **2 — Plattformentscheid** | früh | Spotify vs. YouTube → YouTube (kein Login-/Premium-Zwang) |
| **3 — Basis-Entwicklung** | ~1 Monat | React-Frontend + Node/Socket.io-Backend, VPS bei Host Europe (~5 CHF/Monat) |
| **4 — Der Sprung** | Meilenstein | Automatischer Song-Wechsel funktioniert (getestet mit 1-Sekunden-Videos) |
| **5 — Datenhölle** | mehrere Monate | YouTube-Quota → Cache-Tabelle → GB-grosse Dumps → Import-Odyssee |
| **6 — Deployment-Hölle** | durchgehend | Manuelles SSH-Deployment, `git reset --hard`, localhost/prod-Switching |
| **7 — Heute** | ab EasyContactForm | Claude Code bekommt SSH-Zugriff, deployt und migriert selbst |

---

## 1a. Ursprungsvision — 1. Oktober 2025

Der schriftliche Ausgangspunkt, bevor eine Zeile Code existierte. Er ist deshalb wertvoll,
weil er zeigt, wie weit der ursprüngliche Entwurf über das hinausging, was am Ende gebaut
wurde — und weil zwei zentrale Annahmen im Lauf des Projekts gekippt sind.

**Der Kern der Idee:** Session per Link beitreten, alle schlagen Songs vor, es wird
abgestimmt, der Gewinner wird eingespielt. Ausgelöst durch die Bürosituation — jemand fragt,
was läuft, jemand will etwas anderes hören.

**Vision vs. Realität**

| Aus der Vision | Status | Anmerkung |
|---|---|---|
| Session per Link, gemeinsames Hören | ✅ gebaut | Der Kern, hat funktioniert |
| Queue mit sichtbarer Reihenfolge | ✅ gebaut | „Einsicht auf die Schleife" |
| Voting über den nächsten Song (ja/nein, bei Patt Zufall) | ⚠️ offen | Namensgebendes Feature — taucht in der ganzen Rückschau nicht mehr auf |
| Spotify als Quelle | ❌ verworfen | Login- und Premium-Zwang pro Zuhörer |
| KI-Songsuche nach Stimmung | ✅ teilweise | Als serverseitige AI-Song-Suggestions umgesetzt |
| Bewusst kein Live-Chat | ✅ gehalten | Begründung damals: Moderationsaufwand |
| Musikpausen (z. B. 30 Min) | ❌ nie gebaut | |
| Loops, Rückwärts-Wiedergabe, Pitch/Frequenz ändern | ❌ nie gebaut | Mit einem YouTube-Player auch technisch nicht mehr trivial |
| DJ-/Künstler-Livestreams, Abos, Bewertung | ❌ nie gebaut | Der Monetarisierungsgedanke war aber ab Tag 1 da |
| Daily Polls, Higher-Lower-Game, Hoster-Statistik | ❌ nie gebaut | Engagement-Ebene |
| Genre-Beschränkung bei Party-/Bar-Sessions | ❌ nie gebaut | |

**Die zwei gekippten Annahmen — der interessanteste Teil**

1. **Spotify war gesetzt, nicht optional.** In der Vision steht die Streaming-Quelle als
   Selbstverständlichkeit. Der Entscheid dagegen kam erst, als klar wurde, dass jeder Zuhörer
   Account *und* Premium bräuchte. Richtiger Entscheid — aber er kam spät, nachdem bereits
   Zeit in einen Spotify-API-Aufbau (inkl. geliehenem Account eines Kollegen) geflossen war.

2. **Das Hauptargument der Vision war ausdrücklich gegen Video** — Bandbreite, Prozessorlast,
   Ladezeit, Ablenkung. Genau das war die Begründung, warum die Plattform kein YouTube-Erlebnis
   sein sollte. Gebaut wurde sie dann auf YouTube.
   Das ist kein Widerspruch aus Nachlässigkeit: die Zugangshürde von Spotify wog schwerer.
   Aber die ursprüngliche Anforderung wurde beim Plattformwechsel **nicht erneut geprüft**,
   sondern stillschweigend fallengelassen. Der Videostream läuft weiterhin im Hintergrund —
   das Problem wurde kaschiert, nicht gelöst.

**Learning für künftige Projekte:** Beim Wechsel einer Kernplattform die ursprüngliche
Anforderungsliste nochmals durchgehen. Sonst erbt man die Nachteile, gegen die man
ursprünglich angetreten ist — und merkt es erst Monate später.

**Was gut gealtert ist:** Der bewusste Verzicht auf Live-Chat. Eine Nicht-Entscheidung
festzuhalten („das bauen wir bewusst nicht, weil Moderation zu teuer ist") hat verhindert,
dass das Feature später aus Reflex doch entsteht. Solche Negativ-Entscheide gehören in jedes
Konzept.

**Offene Frage an dich selbst:** Das Voting ist der Namensgeber der Plattform und der
eigentliche Unterschied zu einer geteilten Playlist. In der gesamten Rückschau über Monate
kommt es nicht ein einziges Mal vor — dort geht es nur um Queue, Abspielen und Song-Wechsel.
Entweder ist es gebaut und unauffällig, oder der Scope ist von „Vote" nach „Queue" gedriftet.
Falls Letzteres: das ist die wichtigste Produktfrage im ganzen Archiv.

---

## 2. Themenblock A — Datenbank-Dumps & Daten-Transfer

Das grösste Zeitloch des Projekts. Fünf Evolutionsstufen:

**Stufe 1 — phpMyAdmin Web-Import**
SQL-Datei über das Web-Interface hochladen. Funktionierte genau *einmal*, solange die
Datenmenge minimal war. Vorher musste die Docker-/MySQL-Limitierung angehoben werden:

```bash
docker exec mysql mysql -uroot -p'<ROOT_PW>' -e "SHOW VARIABLES LIKE 'max_allowed_packet';"
```

Ab GB-Grösse: Timeouts, kein Fortschritt sichtbar, unbrauchbar.

**Stufe 2 — SCP + `docker exec` mit Redirect**
Dump hochladen, dann serverseitig direkt in MySQL pipen.

```bash
scp ~/Documents/TuneVote_api/dump.sql <user>@<VPS_IP>:~
ssh <user>@<VPS_IP>
su -
ls -l /home/<user>/dump.sql
docker exec -i mysql mysql -uroot -p'<ROOT_PW>' tunevote < /home/<user>/dump.sql
```

Deutlich besser als Stufe 1, aber: kein Fortschrittsbalken, Server ging mehrfach in die Knie.

**Stufe 3 — Python-Importer mit Progress**
Eigenes Skript mit `mysql.connector`, zuerst lokal, dann direkt gegen Produktiv.

```python
conn = mysql.connector.connect(
    host="127.0.0.1", port=3306,
    user="<USER>", password="<PW>", database="tunevote",
)
```

Vorteil: sichtbarer Fortschritt („läuft überhaupt noch was?"). Nachteil: fror regelmässig ein.

**Stufe 4 — Erkenntnis**
Die Frage „gibt es einen schnelleren Weg?" wurde *zu spät* an die KI gestellt. Genau diese
Frage hätte mehrere der Stufen übersprungen.

**Stufe 5 — Heute**
Kein manueller Dump-Transfer mehr. Claude Code macht per SSH Backup → Migration → Verifikation
in einem Durchgang. Der Cache wird nicht mehr als Monolith geschoben, sondern lazy beim
Queue-Insert gefüllt (siehe Block F).

**Kernlektion:** Kein Overwrite ohne vorheriges Backup — genau daran ist die
`youtube_video_cache`-Tabelle mehrfach gestorben.

---

## 3. Themenblock B — Schema-Vergleich & Migrationen

**Damaliger Ablauf (mühsam):**
1. Komplette Datenbank über phpMyAdmin exportieren (Struktur *und* Daten, weil die
   „nur Struktur"-Option im Interface nicht gefunden wurde — auch die KI fand sie im
   Screenshot nicht).
2. Datei manuell zurechtschneiden: pro Tabelle nur ein Datenausschnitt behalten, damit die
   KI überhaupt erkennt, welche Tabellen existieren.
3. Altes vs. neues Schema an ChatGPT/Grok geben, Diff erklären lassen.
4. Migrations-SQL generieren lassen, manuell gegen Produktiv ausführen.

**Verbesserung:** Python-Skript, das *nur* die Struktur ausliest (`information_schema`) —
Export und Zurechtschneiden fielen komplett weg. Skript liegt im Repo `jdl-expo`, Kapitel TuneVote.

**Heute:** Migrationsdateien gehören ins Repo und laufen versioniert (ein Migrations-Runner
statt handgeschriebener One-Off-SQL). Claude Code erzeugt Diff + Migration + Rollback-Skript.

---

## 4. Themenblock C — Deployment

**Damaliger Ablauf, jedes Mal von Hand:**

```bash
ssh <user>@<VPS_IP>
su -                      # Root-Rechte (war anfangs nicht klar, dass "su -" das tut)
cd /var/www
```

Frontend:
```bash
cd /var/www/TuneVote
git pull origin main
npm install
npm run build
sudo cp -r build/* /var/www/html/
sudo systemctl reload nginx
```

Backend:
```bash
cd /var/www/tunevote_api
git reset --hard          # nötig, weil "git pull" allein nichts ersetzte
git pull origin main
sudo nginx -t
sudo systemctl restart nginx
pm2 restart tunevote_api
pm2 status
```

**Was daran falsch war (im Nachhinein klar):**
- Das React-Frontend lief unnötig auf dem VPS. Statisches Build → Static Hosting/CDN hätte
  RAM und CPU gespart. Nur das Socket.io-Backend *brauchte* den VPS.
- `git reset --hard` als Standardschritt ist ein Symptom, kein Fix: auf dem Server wurde
  offensichtlich am Working Tree gearbeitet. Ein Deploy sollte nie aus dem Server-Repo heraus bauen.
- Kein Rollback-Pfad. Ging etwas schief, war das Live-System kaputt.

**Heute:** Claude Code bekommt SSH-Zugriff und führt das Deployment selbst aus — inkl.
Fehlerdiagnose. Der Praxisbeweis kam bei EasyContactForm: was vorher eine halbe Stunde
Fehlersuche war, war in ~2 Minuten erledigt.

---

## 5. Themenblock D — VPS, nginx, Docker, HTTPS

Ausgangsfrage war: *Braucht das Projekt überhaupt einen VPS?* Ja — Socket.io braucht einen
dauerhaft laufenden Node-Prozess, das gibt kein klassisches Shared Hosting her. Lösung war
aber einfacher als gedacht: Zusatzpaket bei Host Europe für ~5 CHF/Monat, kein Anbieterwechsel nötig.

Einrichtung damals: ~5–6 Stunden reines Command-für-Command-Durchklicken mit ChatGPT
(nginx, Docker, SSL), plus geschätzt ~10 Stunden, bis die Deployments stabil waren.

```bash
# nginx-Konfiguration
sudo nano /etc/nginx/nginx.conf
sudo nano /etc/nginx/sites-available/tunevote
sudo nano /etc/nginx/sites-available/api.tunevote.com
ls /etc/nginx/sites-enabled
sudo nginx -t

# HTTPS via Let's Encrypt
sudo certbot --nginx -d app.tunevote.com -d api.tunevote.com
```

**Heute:** Provisionierung ist ein Claude-Code-Job, kein Tutorial-Marathon. Realistisch
10–20 Minuten statt eines halben Tages.

---

## 6. Themenblock E — Lokal vs. Produktiv

| Umgebung | Frontend | Backend |
|---|---|---|
| Lokal | `http://localhost:5173/` | `http://localhost:4000/` |
| Produktiv | `https://app.tunevote.com/` | `https://api.tunevote.com/` |

**Das Problem:** Die URLs standen hart im Code. Vor jedem Push musste manuell von `localhost`
auf die Produktiv-Domain umgestellt werden — sonst zeigte das Live-System auf localhost.
Dazu kamen unterschiedliche Credentials (User, Passwort, DB-Name) für lokal und Produktiv,
die auch noch verschieden benannt waren.

**Das ist der teuerste vermeidbare Fehler im ganzen Projekt.** Er hat über Monate bei
*jedem einzelnen* Push Zeit gekostet und war die Ursache mehrerer „warum geht Live nichts"-Sessions.

**Fix, der von Anfang an möglich gewesen wäre:** `.env` / `.env.production` mit
`VITE_API_URL` bzw. `DB_HOST`, `DB_USER`, `DB_NAME` — identische Variablennamen in beiden
Umgebungen, nur andere Werte. Null Code-Änderung beim Deploy.

---

## 7. Themenblock F — YouTube-Quota & der Cache

**Das Problem:** Jede Suche = ein YouTube-API-Request. Bei mehreren Nutzern ist das
Tageslimit schnell erreicht — dann kann *niemand* mehr suchen, die ganze Plattform steht.

**Untersuchte Auswege:**
- Quota-Erhöhung bei Google beantragen → laut Reddit-Recherche praktisch aussichtslos
  (gefühlt <1 % Erfolgsquote, teils monate- bis jahrelange Wartezeit).
- Key-Rotation über mehrere API-Keys → Workaround, aber fragil.
- **Gewählt:** Cache-Tabelle `youtube_video_cache`.

**Befüllung damals:** Scraper über ~1000 Künstler, pro Künstler alle Video-Links holen,
Ergebnis in ein SQL-File schreiben, File an die Datenbank schicken. Ein voller Extraktions-Tag,
danach ein Import, der ewig lief. Skripte liegen im separaten Repo `jdl-expo`.

**Heute:** Link einfügen → System erkennt das Video → beim Queue-Insert wandert es in den
Cache. Kein Mass-Scraping mehr nötig, der Cache wächst organisch mit der Nutzung.

> ⚠️ Compliance-Hinweis, der im alten Modell fehlte: Die YouTube-API-Developer-Policies
> begrenzen die Speicherung von API-Daten. <cite index="4-1">Nach 30 Kalendertagen muss der API-Client die gespeicherten Daten entweder löschen oder aktualisieren</cite>, und <cite index="4-1">Statistiken aus nicht-autorisierten Daten dürfen gar nicht länger als 30 Tage gespeichert werden</cite>.
> Ein dauerhaft eingefrorener Katalog aus 1000 Künstlern passt da nicht hinein — ein
> `cached_at`-Feld mit 30-Tage-Refresh schon. Siehe Kapitel 14.

---

## 8. Themenblock G — Produkt- und Architekturentscheide

**Spotify vs. YouTube.**
Spotify hätte technisch alles geliefert: Qualität, saubere Synchronisation. Der Killer war
die Voraussetzung — jeder Zuhörer hätte sich mit eigenem Spotify-Account einloggen *und*
Premium haben müssen. Für „ich schau kurz rein, was gerade läuft" ist das eine Mauer.
Entscheidung: YouTube. (Die KI hatte Spotify empfohlen; der Entscheid dagegen war richtig,
weil das Produktziel schwerer wog als die technische Eleganz.)

**Landingpage: React war die falsche Wahl.**
Anfangs lag die Landingpage als weitere React-Route neben der Session-Page. Verständnislücke
damals: eine SPA ist für Google schlecht crawlbar — die Seite existiert, rankt aber nicht.
Daraus folgten die Learnings zu Astro und Next.js (und der Tailwind-Versionskonflikt, den
die KI lange nicht als Ursache erkannte).
**Regel seither:** Web-App in React, Landingpage/Blog separat mit SSG/SSR.

**Auth.** Erster privater Einsatz von Google-Login und zusätzlich Facebook-Login.
Schema der Integration ist bei beiden gleich, aber Googles Console und Datenabruf sind
spürbar angenehmer als Metas.

**Der Meilenstein.** Der automatische Sprung zum nächsten Song. Getestet mit
1-Sekunden-Videos statt echten Songs — sonst wären pro Testlauf Minuten verloren gegangen.
Kleiner Trick, grosse Wirkung; gehört in jeden künftigen Testaufbau mit zeitbasierten Abläufen.

---

## 9. Themenblock H — Repo-Hygiene

`jdl-expo` wurde bewusst als separates Repo für Scraper und Automatisierung angelegt, um
TuneVote sauber zu halten. Genau dort ist dann aber alles gelandet, was ein Python-Venv
brauchte — inklusive Resume-Generator und anderem, das nichts mit TuneVote zu tun hat.

**Ursache:** Das Venv war schon aktiviert. Bequemlichkeit schlägt Struktur.
**Konsequenz:** Ein „Sammelrepo" wächst immer. Entweder von Anfang an ein bewusstes
`scripts/`-Monorepo mit Ordnerstruktur, oder konsequent pro Zweck ein Repo.

---

## 10. Problem-Katalog

| # | Problem | Ursache | Damals | Heute |
|---|---|---|---|---|
| 1 | Import von GB-Dumps bricht ab | phpMyAdmin/Paket-Limits | Limits hochsetzen, hoffen | Serverseitiger Import, kein Web-UI |
| 2 | Cache-Tabelle nach DB-Overwrite leer | Overwrite ohne Backup | Alles neu hochschieben | Backup-vor-Migration ist Pflichtschritt |
| 3 | Import friert ein | Ein Riesen-Statement, kein Batching | Neu starten | Batches + Resume |
| 4 | Schema-Diff nur mit Volldump möglich | „Nur Struktur"-Option nicht gefunden | Export + manuell zurechtschneiden | `information_schema`-Abfrage |
| 5 | Live zeigt auf localhost | Hardcodierte URLs | Vor jedem Push manuell switchen | `.env` pro Umgebung |
| 6 | `git pull` ersetzt nichts | Am Server-Working-Tree gearbeitet | `git reset --hard` davor | Build-Artefakte deployen, nicht auf dem Server bauen |
| 7 | VPS-Ressourcen knapp | Frontend lief unnötig mit | ertragen | Statisches Frontend getrennt hosten |
| 8 | YouTube-Quota-Blockade | Jede Suche = 1 Request | Mass-Scraping + Cache | Lazy Cache beim Queue-Insert |
| 9 | Landingpage rankt nicht | React-SPA | — | SSG/SSR getrennt |
| 10 | VPS-Setup dauert Stunden | Command-für-Command | Tutorial-Modus | Provisionierung per Claude Code |
| 11 | Deploy vergisst `npm install` | Deploy ist eine getippte Befehlsfolge, kein Skript | Schritt nachträglich einschieben | `deploy.sh` im Repo als einzige Quelle der Wahrheit |
| 12 | Neue Env-Vars fehlen auf PROD | `.env` ist (korrekt) gitignored und reist nicht mit dem Pull | Auf dem Server von Hand nachtragen | `.env.example` im Repo + Startup-Guard, der bei fehlender Variable abbricht |
| 13 | Stripe-Webhook bricht nach API-Versionswechsel | Feld `current_period_end` von der Subscription-Wurzel nach `items.data[]` gewandert | Nach Live-Fehler debuggen, Event replayen | `apiVersion` im SDK pinnen + Webhook vor dem Deploy im Testmode triggern |

> **Nachtrag Juli 2026.** Zeilen 11–13 stammen aus dem Stripe-Deploy und sind der Grund, warum
> das Archiv hier endet und `deploy.sh` anfängt: Nr. 11 und 12 sind keine Wissenslücken mehr,
> sondern reine Prozessfehler — sie passieren, weil der Deploy eine Befehlsliste ist statt ein
> Skript. Doku dagegen hilft nicht; ein Skript, das den Schritt gar nicht auslassen kann, schon.

---

## 11. Command-Referenz (bereinigt)

Alle Secrets durch Platzhalter ersetzt. Diese Liste ersetzt die alte Notizdatei.

**Ports & Prozesse**
```bash
sudo lsof -i :3000                 # Wer belegt den Port?
sudo netstat -tulnp | grep 8080    # Alternative
sudo kill -9 <PID>
alias freeport='f() { sudo lsof -t -i:$1 | xargs sudo kill -9; }; f'   # ~/.bashrc
```

**Docker**
```bash
docker ps
docker ps | grep 8080
docker stop <name> && docker rm <name>
docker compose up --build -d
docker compose down
docker stop $(docker ps -q)        # alle stoppen
docker rm -f $(docker ps -aq)      # alle entfernen
```

**MySQL im Container**
```bash
docker exec mysql mysql -uroot -p"$DB_ROOT_PW" -e "SHOW VARIABLES LIKE 'max_allowed_packet';"
docker exec -i mysql mysql -uroot -p"$DB_ROOT_PW" <db> < dump.sql
```

**Server**
```bash
ssh <user>@<host>
su -
sudo nginx -t && sudo systemctl reload nginx
pm2 restart <app> && pm2 status
sudo certbot --nginx -d app.example.com -d api.example.com
openssl rand -base64 24            # Secret generieren — NICHT in Notizen ablegen
```

**Git**
```bash
git init && git add . && git commit -m "chore: initial commit"
git branch -M main
git remote add origin git@github.com:<user>/<repo>.git   # SSH, kein Token
git push -u origin main
git log --oneline
git clone --mirror git@github.com:<user>/<repo>.git <repo>-backup.git
```

**Sonstiges**
```bash
sudo apt install ./paket.deb
sudo rm -rf <pfad>
npx create-next-app@latest <name>
flutter create <name>
```

---

## 12. Was bewusst nicht mehr gemacht wird

- Keine handgepflegte Command-Sammlung mehr. Was ein Projekt braucht, steht als kurzes
  `RUNBOOK.md` **im jeweiligen Repo** — nicht in einer projektübergreifenden Sammeldatei.
- Kein manuelles Deployment über SSH-Sessions.
- Kein Zurechtschneiden von SQL-Dumps, um einer KI ein Schema zu erklären.
- Keine URL-Umschaltung im Code vor dem Push.
- Keine Credentials in Notizen, Repo-URLs oder Chat-Verläufen.

Was **bleibt**: das Verständnis dahinter. Zu wissen, *warum* `git reset --hard` nötig war,
ist mehr wert als der Befehl selbst — und genau das geht verloren, wenn nur automatisiert
und nie dokumentiert wird. Dafür existiert dieses Dokument.

---

## 13. Zielbild — der neue Standard-Workflow

1. Hosting-Paket kaufen.
2. Claude Code bekommt SSH-Zugriff → provisioniert Server, Docker, nginx, Zertifikate.
3. Konfiguration ausschliesslich über `.env` pro Umgebung.
4. Deploy = Claude Code, mit Backup davor und Rollback-Pfad.
5. Migrationen versioniert im Repo, nicht als handgereichtes SQL.
6. Pro Repo ein kurzes `RUNBOOK.md`: Start, Deploy, Rollback, Umgebungsvariablen. Mehr nicht.

Realistische Einschätzung aus eigener Erfahrung: Was bei TuneVote ohne Agent ~1 Monat für die
Basis brauchte, wäre heute in etwa einer Woche machbar.

---

## 14. Offene und kritische Punkte (ehrlich)

**a) YouTube-Cache und die API-Policies.**
Die Rechtsfrage „darf man YouTube-Videos einbetten und wie eine Playlist abspielen?" ist
beim *Embed über den offiziellen Player* unproblematisch — Views zählen weiter für YouTube.
Der heiklere Teil ist ein anderer: das dauerhafte Speichern gescrapeter Metadaten und der
Einsatz von yt-dlp-artigen Bibliotheken zum Auslesen. Das ist eine andere Kategorie als das
Embed und wird von den Developer-Policies nicht gedeckt. Eine KI-Recherche, die „legal"
sagt, ersetzt hier keine Prüfung — ich bin kein Jurist. Konkret umsetzbar: `cached_at`-Spalte,
Refresh oder Löschung nach 30 Tagen, Metadaten nur über die offizielle API beziehen.

**b) Werbung in Songs.**
Bisher nie aufgetreten — aber das ist kein Beweis, sondern Glück. Ein Video mit Mid-Roll-Ads
bricht die Session-Synchronisation. Fallback einplanen.

**c) Autonome PROD-Deployments.**
Der Ansatz ist richtig, hat aber dieselbe Risikoklasse wie die alten DB-Overwrites:
schnell, unwiderruflich, wenig Kontrolle. Die Absicherung ist nicht „vorsichtiger sein",
sondern: automatisches Backup vor jeder Migration, ein Rollback-Kommando, und
Migrationen nie im selben Schritt wie Feature-Deploys.

---

## 15. Umgang mit diesem Dokument

- Dieses Archiv wird **nicht mehr erweitert**. Es ist der Blick zurück.
- Neue projektspezifische Anleitungen: `RUNBOOK.md` im jeweiligen Repo, maximal eine Seite.
- Die alte Notizdatei kann nach Erledigung von Kapitel 0 gelöscht werden — der Inhalt ist
  hier strukturiert erhalten, die Secrets sind es bewusst nicht.
