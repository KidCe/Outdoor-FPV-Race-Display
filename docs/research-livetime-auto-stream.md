# LiveTimeAutoStream: Nutzen fuer Race Display und Next Up

Stand: 2026-09-05  
Untersuchter Quellstand: [`7e76e9c885455bc29340a3ef9d4816848ba8f253`](https://github.com/iwandi/LiveTimeAutoStream/tree/7e76e9c885455bc29340a3ef9d4816848ba8f253)

## Kurzfazit

`LiveTimeAutoStream` ist fuer uns **als technische Referenz fuer den LiveFPV-Livestream interessant**, aber nicht als fertiger Connector. Es zeigt einen anderen, wichtigen Datenweg als `RaceVision.Utility`: Die App braucht weder den LiveTime Device Center noch einen RaceVision-Key. Sie laedt die oeffentliche Seite `https://<eventId>.livefpv.com/live/scoring/` in ein Electron-Webview und klinkt sich in deren bereits vorhandenen Socket.IO-Client ein.

Der untersuchte Code nutzt davon produktiv jedoch nur den Race-Status `staging`, `running` oder `complete`, um OBS-Szenen umzuschalten. Pilotendaten werden zwar abgefangen und weitergereicht, danach aber verworfen. Es gibt keinen Connector-Endpunkt, keinen normalisierten Snapshot und keine Next-up-Warteschlange.

**Empfehlung:** Nicht die Electron-/OBS-App uebernehmen. Stattdessen die belegte LiveFPV-Socket-Quelle als optionale, latenzarme `current heat`-Quelle im LiveTimeQue-Adapter nachbauen und mit dessen bestehender HTTP-/Schedule-Auswertung zusammenfuehren. Fuer `Next Up` bleibt die Event-/Heat-Sheet-Auswertung erforderlich. Das Ergebnis muss weiterhin in `org.fpv.race-event.snapshot` v1 normalisiert und mit letztem validen Zustand, Freshness und Reconnect ausgeliefert werden.

## 1. Was die App macht

```text
Event subdomain
  -> Electron loads https://<eventId>.livefpv.com/live/scoring/
  -> injected hook subscribes to window.liveData.socket
  -> updateRaceData / updateDriverData are relayed through Electron IPC
  -> only raceData field 2 is read
  -> OBS WebSocket SetCurrentProgramScene
```

- Der Nutzer gibt nur die LiveFPV-Subdomain sowie OBS-Adresse, Passwort, Szenennamen und optionale Zeitlimits ein ([`renderer.html`](https://github.com/iwandi/LiveTimeAutoStream/blob/7e76e9c885455bc29340a3ef9d4816848ba8f253/renderer.html#L60-L102)).
- `loadEvent()` baut daraus `https://${id}.livefpv.com/live/scoring/` und laedt die Seite im Webview ([`renderer.js`](https://github.com/iwandi/LiveTimeAutoStream/blob/7e76e9c885455bc29340a3ef9d4816848ba8f253/renderer.js#L62-L70)).
- Der injizierte Hook wartet auf `window.liveData` und lauscht auf `updateRaceData` sowie `updateDriverData` ([`inject-hooks.js`](https://github.com/iwandi/LiveTimeAutoStream/blob/7e76e9c885455bc29340a3ef9d4816848ba8f253/inject-hooks.js#L3-L30)).
- Die eigentliche Logik verarbeitet nur `raceData`, trennt den Pipe-String und verwendet Feldindex `2` als Status ([`livetime-to-obs.js`](https://github.com/iwandi/LiveTimeAutoStream/blob/7e76e9c885455bc29340a3ef9d4816848ba8f253/livetime-to-obs.js#L85-L91)).
- Fuer `staging`, `running` und `complete` wird jeweils eine konfigurierbare OBS-Szene gesetzt. Nach `staging` und `complete` kann ein lokaler Timer ersatzweise zur naechsten Phase weiterschalten ([`livetime-to-obs.js`](https://github.com/iwandi/LiveTimeAutoStream/blob/7e76e9c885455bc29340a3ef9d4816848ba8f253/livetime-to-obs.js#L21-L82)).
- Ausgabe ist ausschliesslich der OBS-WebSocket-Aufruf `SetCurrentProgramScene`; eine HTTP-, SSE-, WebSocket- oder JSON-Ausgabe fuer andere Programme existiert nicht ([`livetime-to-obs.js`](https://github.com/iwandi/LiveTimeAutoStream/blob/7e76e9c885455bc29340a3ef9d4816848ba8f253/livetime-to-obs.js#L67-L70)).

## 2. Ein- und Ausgaben

| Bereich | Belegt | Fuer unser Display |
|---|---|---|
| LiveTime-Eingang | oeffentliche LiveFPV-Scoring-Webseite; keine lokale LiveTime-Verbindung | gut als indirekte, cloudbasierte Quelle |
| Live-Transport | vorhandenes `window.liveData.socket`; Events `updateRaceData`, `updateDriverData` | prinzipiell fuer Current Heat verwendbar |
| Race-Status | Pipe-Feld `2`: `staging`, `running`, `complete` | direkt brauchbar |
| Current Heat | Rohdaten enthalten Klasse, Race-/Heatnummer, Runde, Status und Race-Laenge; die App parst sie nicht | Adapter kann sie parsen |
| Piloten | `updateDriverData` wird abgefangen, aber von der App nicht ausgewertet | Rohquelle ist vorhanden; Parser erforderlich |
| Channels | kein explizites `R1`-bis-`R8`-Feld im Repository belegt | nicht verlaesslich aus dieser App ableitbar |
| Laps/Timing | nicht abonniert; `updateClockData` fehlt im Hook | App liefert es nicht, LiveFPV-Quelle bietet es aber |
| Next Up/Queue | kein Stream, kein Parser, kein Schedule-Zugriff | nicht vorhanden |
| Ausgang | OBS-Szenenwechsel und kleine lokale Statusanzeige | kein wiederverwendbarer Connector |

Die drei mitgelieferten Beispielnachrichten bestaetigen den Pipe-Race-Payload und die Statuswerte; sie enthalten keine Driver- oder Clock-Fixture ([`messages.json`](https://github.com/iwandi/LiveTimeAutoStream/blob/7e76e9c885455bc29340a3ef9d4816848ba8f253/messages.json#L1-L5)).

## 3. Was die heutige LiveFPV-Seite zusaetzlich anbietet

Die aktuell ausgelieferte, first-party LiveFPV-Scoring-Implementierung bestaetigt, dass der oeffentliche Browser-Client neben `updateRaceData` und `updateDriverData` auch `updateClockData`, Estimated-Position- und weitere Events abonniert. Der Race-Parser benennt unter anderem Klasse, Status, Race-/Heatnummer, Runde, Race-Laenge, Eventname und Fahreranzahl. Der Driver-Parser benennt Position, Name/Nickname, Nummer, Runden, letzte und schnellste Runde, Pace, elapsed time, Fahrer-ID, Farben und weitere Rennfelder. Quellen: [LiveFPV Socket-Client](https://rotormaniacs.livefpv.com/js/live/live.socketio.min.js?1402) und [LiveFPV Scoring-Parser](https://rotormaniacs.livefpv.com/js/live/live.scoring.min.js?1402).

Damit ist der Ansatz fuer **Current Heat + laufende Zeiten + Piloten** deutlich ergiebiger als das Repository selbst. Zwei Grenzen bleiben:

1. Der oeffentliche Live-Stream beschreibt nur das aktuell ausgestrahlte Rennen. Eine geordnete Liste der naechsten Heats ist darin nicht belegt.
2. `carNum`/`eqp` sind keine dokumentierten FPV-Channel-Felder. Eine Zuordnung zu `R1` bis `R8` darf erst nach einem echten Payload-Mitschnitt oder ueber die Heat-Sheet-Daten erfolgen.

Die LiveFPV-Seite verwendet derzeit den sehr alten Socket.IO-Client `0.9.16` und ein undokumentiertes, positionsbasiertes Pipe-Format. Das ist fuer einen defensiven Adapter nutzbar, aber nicht als stabiler oeffentlicher Standard anzusehen.

## 4. Lizenzstufe und Abhaengigkeiten

### Keine Device-Center-/RaceVision-Premium-Abhaengigkeit

Technisch benutzt `LiveTimeAutoStream` weder den lokalen SignalR-Port von RaceVision noch den RaceVision-Key. Es greift lediglich auf den oeffentlichen LiveFPV-Broadcast zu. LiveTime nennt die Integration mit LiveFPV und die Live-Broadcasting-Werkzeuge fuer FPV in allen drei Tarifen; nur `Device Center Capabilities` sind Premium vorbehalten ([offizielle Feature-Tabelle](https://www.livetimescoring.com/features/), insbesondere Zeilen 93-136 der FPV-Tabelle).

Folglich braucht dieser Datenweg **keine groessere Lizenz fuer Device Center**, sofern das Event ohnehin erfolgreich zu LiveFPV publiziert wird. Er benoetigt aber Internet und haengt von LiveTimes Cloud-Sync sowie der Verfuegbarkeit des oeffentlichen LiveFPV-Dienstes ab.

### Lokale Software

- Electron `^35.1.5` und electron-builder `^26.0.12`;
- `electron-store` `^10.0.1` fuer lokale Einstellungen;
- `obs-websocket-js` `^5.0.6` fuer OBS;
- Windows-Portable-Build ist konfiguriert, obwohl Electron grundsaetzlich plattformuebergreifend ist ([`package.json`](https://github.com/iwandi/LiveTimeAutoStream/blob/7e76e9c885455bc29340a3ef9d4816848ba8f253/package.json#L5-L35)).

Das Projekt hat am untersuchten Stand keinen README, keine Releases und keine Tests; die GitHub-Seite zeigt nur Quellcode ohne Bedien- oder Protokolldokumentation ([Repository](https://github.com/iwandi/LiveTimeAutoStream)).

## 5. Stabilitaets-, Sicherheits- und Portabilitaetsgrenzen

- **Fragile Datenquelle:** Der Hook greift auf die interne globale Variable `window.liveData` und undokumentierte Socket-Events zu. Jede LiveFPV-Frontend-Aenderung kann den Connector brechen.
- **Keine Reconciliation:** Es gibt keinen initialen normalisierten Snapshot, keine Sequenznummer und keine Fetch-Wiederholung, falls beim Hook-Start bereits Events verpasst wurden.
- **Reconnect ist nicht robust:** Nach erfolgreicher OBS-Verbindung wird `isConnected` nur bei einem expliziten Disconnect zurueckgesetzt; fuer einen unerwarteten Verbindungsabbruch ist kein OBS-Close-Handler implementiert ([`obs.js`](https://github.com/iwandi/LiveTimeAutoStream/blob/7e76e9c885455bc29340a3ef9d4816848ba8f253/obs.js#L7-L50)).
- **Konfigurationsfehler:** Die UI speichert `obsUri`, der OBS-Client liest dagegen `obsUrl`; eine geaenderte Adresse wird daher nicht uebernommen ([`renderer.js`](https://github.com/iwandi/LiveTimeAutoStream/blob/7e76e9c885455bc29340a3ef9d4816848ba8f253/renderer.js#L32-L44), [`obs.js`](https://github.com/iwandi/LiveTimeAutoStream/blob/7e76e9c885455bc29340a3ef9d4816848ba8f253/obs.js#L17-L22)).
- **Secret-Speicherung:** Das OBS-Passwort wird mit einer unkonfigurierten `electron-store`-Instanz gespeichert. Deren Standard ist eine lokale JSON-Datei und sie ist ausdruecklich kein Security-Store ([App-Code](https://github.com/iwandi/LiveTimeAutoStream/blob/7e76e9c885455bc29340a3ef9d4816848ba8f253/main.js#L4-L5), [`electron-store`-Dokumentation](https://github.com/sindresorhus/electron-store)).
- **Webview-Angriffsoberflaeche:** Die Electron-App aktiviert `webviewTag` und deaktiviert die Sandbox; das Remote-Webview erhaelt eine IPC-Bruecke, die beliebige `liveTimeDataHook`-Nachrichten an den Host senden kann ([`main.js`](https://github.com/iwandi/LiveTimeAutoStream/blob/7e76e9c885455bc29340a3ef9d4816848ba8f253/main.js#L7-L29), [`inject-preload.js`](https://github.com/iwandi/LiveTimeAutoStream/blob/7e76e9c885455bc29340a3ef9d4816848ba8f253/inject-preload.js#L1-L5)).
- **Dependency-Stand:** Ein lokaler `npm audit --omit=dev` am 2026-09-05 meldete im gepinnten Lockfile drei bekannte Produktions-Dependency-Befunde (ein moderater, zwei hohe). Das ist ein zeitabhaengiger Audit-Hinweis, keine Aussage ueber konkrete Ausnutzbarkeit in dieser App.
- **OBS-Netzwerk:** OBS WebSocket 5.x laeuft standardmaessig auf Port `4455`; das OBS-Projekt empfiehlt ausdruecklich Passwortschutz ([offizielle OBS-WebSocket-Dokumentation](https://github.com/obsproject/obs-websocket)).

### Rechtliche Grenze

`package.json` deklariert `ISC`, im Repository fehlt jedoch eine separate `LICENSE`-Datei. Vor dem Kopieren groesserer Codeanteile sollte iwandi die Lizenzabsicht bestaetigen. Unabhaengig davon formuliert LiveTimes EULA sehr weitgehende Einschraenkungen fuer Wiederverwendung, Verlinkung und Dienste auf Basis der LiveTime-Materialien. Fuer einen veroeffentlichten Connector sollte deshalb eine schriftliche Freigabe von LiveTime eingeholt werden ([offizielle LiveTime-EULA](https://www.livetimescoring.com/legal/), Abschnitte I-A und I-F). Dies ist eine Projektrisikobewertung, keine Rechtsberatung.

## 6. Konkreter Integrationsvorschlag

```text
LiveFPV Current stream
  updateRaceData + updateClockData + updateDriverData
                         \
                          -> LiveTimeQue normalizer -> FPV Race Event Data v1
                         /
LiveFPV schedule/heat sheets
  current + next + after next + explicit R-channel mapping
```

1. Den Electron-Code nicht als Runtime-Abhaengigkeit uebernehmen.
2. In LiveTimeQue einen kleinen `LiveFpvSocketSource` hinter derselben Source-Schnittstelle wie den bestehenden HTTP-Collector setzen.
3. Socket-Daten nur als `current race`-Delta behandeln. Beim Start, Reconnect, Heat-Wechsel und periodisch per HTTP den vollstaendigen Schedule-Snapshot neu abgleichen.
4. Raw-Felder sofort in benannte interne DTOs und danach in `org.fpv.race-event.snapshot` v1 normalisieren; das Pipe-Format nie bis in die Display-UI durchreichen.
5. Ohne passende Heat-Sheet-Zuordnung keine Nummer als FPV-Kanal ausgeben. Bei Konflikten den letzten validen Snapshot sichtbar halten und `quality.state = "degraded"` setzen.
6. Parser mit redigierten Real-Fixtures fuer `staging`, `running`, `complete`, Heat-Advance, Reconnect, acht Piloten und `R8` absichern.

## Bewertung

| Ziel | Bewertung |
|---|---|
| Aktueller Live-Status | **sehr hilfreich als Referenz** |
| Current-Heat-Metadaten | **gut erschliessbar**, im Repo noch ungenutzt |
| Piloten und laufende Zeiten | **Quelle vorhanden**, Parser muss erweitert werden |
| Sichere Channel-Zuordnung | **nicht belegt** |
| Next-up-Reihenfolge | **nicht vorhanden** |
| Fertiger Connector | **nein** |
| Premium-/Device-Center-Lizenz | **technisch nicht erforderlich** fuer bereits publizierte LiveFPV-Daten |
| Direkt in GitHub-Pages-PWA | **nicht empfohlen** ohne stabilen Account-ID-Lookup, Reconciliation und Protokollschutz |

Unterm Strich ist `LiveTimeAutoStream` nuetzlicher als `LiveOverlays`, weil es den echten, latenzarmen LiveFPV-Datenstrom sichtbar macht. Es ersetzt aber weder LiveTimeQue noch dessen Next-up-Auswertung. Der wertvolle Teil ist das **Quellenmuster**, nicht die App selbst.
