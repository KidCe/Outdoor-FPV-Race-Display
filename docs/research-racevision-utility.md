# RaceVision.Utility: Nutzen für Race Display und Next Up

Stand: 2026-09-05  
Untersuchter Quellstand: [`e2e93673a54719db568772450a7c2db800630f7c`](https://github.com/iwandi/RaceVision.Utility/tree/e2e93673a54719db568772450a7c2db800630f7c)

## Kurzfazit

`RaceVision.Utility` ist technisch wertvoll als **lokaler, direkter LiveTime-Kollektor für den aktuellen Rennzustand**. Der Code belegt Zugriff auf Event-ID und -Name, aktuelle Race-ID und Race-Bezeichnung, Rundentyp, einen groben Pre-Race/Race/Post-Race-Status sowie die aktuell aktiven Kanalnamen wie `R1` bis `R8`. Er kann außerdem sämtliche empfangenen LiveTime-JSON-Payloads unverändert in Dateien schreiben.

Für unsere **Next-up-Anzeige reicht der belegte Funktionsumfang allein nicht aus**: Das Repository definiert weder eine geordnete Heat-Warteschlange noch nächste Rennen, Piloten-/Callsign-Felder, Slot-Zuordnungen, Rundenzeiten oder Restzeit. Zwar werden `RaceEntries` und geschätzte Positionen vom LiveTime-Server angefragt, ihre Inhalte sind in diesem Quellstand aber nicht modelliert oder durch Beispieldaten dokumentiert. Der angefangene Race-Scanner ist unvollständig.

Die beste Architektur ist daher zunächst ein **hybrider lokaler Connector**:

- RaceVision/LiveTime liefert den autoritativen, latenzarmen aktuellen Zustand und die aktuelle Race-ID.
- Die vorhandene LiveFPV-/LiveTimeQue-Quelle liefert Piloten, Kanalzuordnungen und `Current + Next + After Next`.
- Ein Normalizer führt beide Quellen in unser bestehendes `org.fpv.race-event.snapshot` v1 zusammen, bewertet Konflikte als `degraded` und behält den letzten validen Snapshot.

Da der erforderliche LiveTime-Key vorhanden ist, ist die technische Authentifizierung kein Projektblocker. Der Key darf dennoch ausschließlich im lokalen Collector als Secret gehalten werden, niemals im Browser, Git-Repository, Snapshot, Log oder öffentlichen HTTPS-Connector.

## 1. Was das Repository tatsächlich liest

Die folgende Tabelle trennt belegte Felder von naheliegenden, aber nicht belegten Annahmen.

| LiveTime-Nachricht | Im Code belegte Felder | Nutzen für das Display | Grenze |
|---|---|---|---|
| `LiveStateResponse` | `Event.LID`, `Event.Name` | stabile Event-Identität und Anzeigename | kein Zeitplan | 
| `LiveRaceStateResponse` | `RaceLID`, `RoundType`, `RaceName` | aktuelles Rennen, Klasse/Phase, Heat-ähnliches Label | keine Heat-Nummer/-Gesamtzahl als eigenes Feld, kein nächstes Rennen |
| `LiveRaceTimeSyncResponse` | `FlagType` | Mapping auf `Unknown`, `PreRace`, `Race`, `PostRace` | trotz des Namens werden keine Zeit-, Lap- oder Split-Felder ausgewertet |
| `LiveRaceEntryResponse` | `LiveRaceEntries[].FrequencyName` | aktive Video-Kanalnamen, im Beispiel `R1` bis `R8` | keine im Repository belegte Verknüpfung Kanal ↔ Pilot |
| `RaceEntryByRaceResponse` | `Race.LID`, `RaceEntries` als Array; ausgewertet wird nur die Anzahl | Grundlage für eine spätere Race-/Pilot-Auflösung | Inhalt der Einträge ist weder typisiert noch als Fixture vorhanden |
| `LiveEstimatedPositionResponse` | keine | potenziell interessant für Live-Rangfolge | wird nur angefragt, aber nirgends geparst |

Quellen: Der Scanner liest Eventdaten und per-Race-Arrays in [`ScanCommandProcessor.cs`](https://github.com/iwandi/RaceVision.Utility/blob/e2e93673a54719db568772450a7c2db800630f7c/RaceVision.AdapterHost/Commands/ScanCommandProcessor.cs#L87-L134) sowie Race-ID, Rundentyp und Race-Name in [`ScanCommandProcessor.cs`](https://github.com/iwandi/RaceVision.Utility/blob/e2e93673a54719db568772450a7c2db800630f7c/RaceVision.AdapterHost/Commands/ScanCommandProcessor.cs#L151-L200). Die definierten Rundentypen sind `Unknown`, `Practice`, `Qualifying` und `Main` ([`Misc.cs`](https://github.com/iwandi/RaceVision.Utility/blob/e2e93673a54719db568772450a7c2db800630f7c/RaceVision.Shared/Misc.cs#L5-L11)). Status- und Kanal-Auswertung stehen in [`Controller.cs`](https://github.com/iwandi/RaceVision.Utility/blob/e2e93673a54719db568772450a7c2db800630f7c/RaceVision.OBSControl/Controller.cs#L755-L837); die R1–R8-Nutzung ist in der Beispielkonfiguration sichtbar ([`obs_logic.json`](https://github.com/iwandi/RaceVision.Utility/blob/e2e93673a54719db568772450a7c2db800630f7c/ExampleConfig/obs_logic.json#L20-L61)).

### Status-Mapping

`FlagType` wird intern so zusammengefasst:

| `FlagType` | RaceVision-Zustand | Vorschlag für FPV Race Event Data v1 |
|---:|---|---|
| `0` oder unbekannt | `Unknown` | `unknown` |
| `4` | `PreRace` | `ready` |
| `1`, `2`, `3` | `Race` | `racing` |
| `5`, `6` | `PostRace` | `complete` |

Dieses Mapping ist eine grobe Zustandsprojektion, keine dokumentierte Bedeutung der einzelnen LiveTime-Flagwerte. Die Quelle belegt nur die Zusammenfassung im RaceVision-Code ([`Controller.cs`](https://github.com/iwandi/RaceVision.Utility/blob/e2e93673a54719db568772450a7c2db800630f7c/RaceVision.OBSControl/Controller.cs#L774-L799)).

### Was nicht belegt ist

Am untersuchten Commit gibt es keine DTOs, Fixtures oder Parser für:

- Pilot-ID, Pilotname oder Callsign;
- Slot-/Startposition und Kanal-zu-Pilot-Zuordnung;
- nächste/stagende Heats oder eine geordnete Event-Schedule;
- Heat-Nummer und Heat-Anzahl als getrennte Felder;
- Lap Count, Lap Time, Best Lap, Split, Rang oder Estimated Position;
- Race elapsed/remaining time oder eine Server-Zeitbasis.

Der Code fordert `LiveEstimatedPositionRequest` zwar an, hat aber keinen entsprechenden Handler. Die komplette Liste der initialen Requests steht in [`Connection.cs`](https://github.com/iwandi/RaceVision.Utility/blob/e2e93673a54719db568772450a7c2db800630f7c/RaceVision.AdapterHost/Connection.cs#L148-L169). Der vorgesehene Vorwärts-/Rückwärts-Scanner enthält leere Implementierungsblöcke und produziert keine Next-up-Daten ([`ScanCommandProcessor.cs`](https://github.com/iwandi/RaceVision.Utility/blob/e2e93673a54719db568772450a7c2db800630f7c/RaceVision.AdapterHost/Commands/ScanCommandProcessor.cs#L230-L277)). Zusätzliche Felder können zur Laufzeit in den Roh-Payloads vorhanden sein, dürfen aber ohne einen echten, redigierten Mitschnitt nicht angenommen werden.

## 2. Protokoll, Endpunkte und Aktualisierung

### LiveTime-Eingang

Der MiniClient verbindet sich per ASP.NET Core SignalR mit:

```text
http://<ConnectionIPAddress>:54235/signalr
```

Er verwendet API-Version `10`, empfängt Hub-Events namens `Response` und sendet über die Hub-Methode `Request`. Das Wire-Envelope ist:

```text
MethodPacket {
  PacketType: string,
  PacketBytes: byte[]
}
```

Belegt sind URL, Port, API-Version und SignalR-Routen in [`StandaloneClient.cs`](https://github.com/iwandi/RaceVision.Utility/blob/e2e93673a54719db568772450a7c2db800630f7c/RaceVision.MiniClient/StandaloneClient.cs#L12-L22), [`StandaloneClient.cs`](https://github.com/iwandi/RaceVision.Utility/blob/e2e93673a54719db568772450a7c2db800630f7c/RaceVision.MiniClient/StandaloneClient.cs#L79-L116) und [`StandaloneClient.cs`](https://github.com/iwandi/RaceVision.Utility/blob/e2e93673a54719db568772450a7c2db800630f7c/RaceVision.MiniClient/StandaloneClient.cs#L257-L292). Der Client hängt von `Microsoft.AspNetCore.SignalR.Client` 9.0.5 ab ([`RaceVision.MiniClient.csproj`](https://github.com/iwandi/RaceVision.Utility/blob/e2e93673a54719db568772450a7c2db800630f7c/RaceVision.MiniClient/RaceVision.MiniClient.csproj#L1-L12)).

Die Nutzlast läuft ausgehend durch:

```text
JSON/String → AES mit UTF-8-Keybytes und vorangestelltem IV
            → Base64-Text → UTF-8-Bytes → DEFLATE
```

Eingehend wird die Reihenfolge umgekehrt. Der Code setzt AES-Zero-Padding, aber keinen expliziten authentifizierenden MAC-/AEAD-Schritt; der SignalR-Endpunkt selbst ist `http`, nicht TLS. Implementierung: [`StandaloneClient.cs`](https://github.com/iwandi/RaceVision.Utility/blob/e2e93673a54719db568772450a7c2db800630f7c/RaceVision.MiniClient/StandaloneClient.cs#L171-L200), [`StandaloneClient.cs`](https://github.com/iwandi/RaceVision.Utility/blob/e2e93673a54719db568772450a7c2db800630f7c/RaceVision.MiniClient/StandaloneClient.cs#L294-L349).

Der Login enthält `APIVersion`, `DeviceName`, `ApplicationType`, `ClientOperatingSystem`, `Password`, `IsLive` und optional `LiveDriverLIDFilter` ([`Requests.cs`](https://github.com/iwandi/RaceVision.Utility/blob/e2e93673a54719db568772450a7c2db800630f7c/RaceVision.MiniClient/Requests.cs#L15-L29)). Der Host nutzt leeres Login-Passwort, `IsLive=true`, keinen Driver-Filter, den Rechnernamen sowie fest `ApplicationType.RaceVision` und `ClientOperatingSystem.Windows`; die separate kryptografische `Key`-Konfiguration bleibt trotzdem erforderlich ([`Connection.cs`](https://github.com/iwandi/RaceVision.Utility/blob/e2e93673a54719db568772450a7c2db800630f7c/RaceVision.AdapterHost/Connection.cs#L56-L87)).

### Update-Verhalten

- Nach jedem Connect/Login werden sechs Live-Datentypen einmal initial angefordert.
- Danach kommen Änderungen als SignalR-`Response`-Pushes.
- Ein `PingRequest` wird ungefähr jede Sekunde gesendet.
- Bei Trennung reconnectet der Host, sofern `AutoReconnect` gesetzt ist, und fordert den Startzustand erneut an.
- Pending Messages werden nach `PacketType` in einem `ConcurrentDictionary` gehalten. Mehrere noch nicht verarbeitete Updates desselben Typs werden dadurch auf den letzten Stand zusammengefasst; eine lückenlose Event-Historie ist nicht garantiert.

Quellen: [`Connection.cs`](https://github.com/iwandi/RaceVision.Utility/blob/e2e93673a54719db568772450a7c2db800630f7c/RaceVision.AdapterHost/Connection.cs#L148-L213), [`AdapterHostProgram.cs`](https://github.com/iwandi/RaceVision.Utility/blob/e2e93673a54719db568772450a7c2db800630f7c/RaceVision.AdapterHost/AdapterHostProgram.cs#L108-L129), [`StandaloneClient.cs`](https://github.com/iwandi/RaceVision.Utility/blob/e2e93673a54719db568772450a7c2db800630f7c/RaceVision.MiniClient/StandaloneClient.cs#L171-L215).

### Vorhandene Ausgabewege

#### JSON-Dateien

Der zuverlässigste bereits implementierte Datenausgang ist der JSON-Dump. Für jeden Pakettyp wird der vollständige geparste `JObject` als `<PacketType>.json` geschrieben. `RaceEntryByRaceResponse` erhält wegen mehrerer Rennen den Namen `RaceEntryByRaceResponse<Race.LID>.json`. Ein Update wird zunächst als `.tmp` geschrieben und anschließend unter einem Prozess-Lock auf die Zieldatei verschoben/überschrieben ([`WriteJsonFileProcessor.cs`](https://github.com/iwandi/RaceVision.Utility/blob/e2e93673a54719db568772450a7c2db800630f7c/RaceVision.JsonDump/WriteJsonFileProcessor.cs#L41-L93)). Die Beispielkonfiguration aktiviert diese Funktion mit Ausgabeordner `data` ([`config.json`](https://github.com/iwandi/RaceVision.Utility/blob/e2e93673a54719db568772450a7c2db800630f7c/ExampleConfig/config.json#L1-L11)).

Das eignet sich für einen schnellen Read-only-Prototyp mit File-Watcher. Nachteile sind fehlende Envelope-Metadaten wie Empfangszeit/Sequenz, notwendige Zusammenführung mehrerer Dateien und potenzielle verpasste Zwischenstände.

#### RaceInfo-WebSocket

Die Beispielkonfiguration startet einen `HttpListener` unter `http://localhost:8080/ws/`; der Pfad ist frei konfigurierbar und muss als HTTP(S)-Prefix mit abschließendem Slash angegeben werden ([`config.json`](https://github.com/iwandi/RaceVision.Utility/blob/e2e93673a54719db568772450a7c2db800630f7c/ExampleConfig/config.json#L10-L14), [`Config.cs`](https://github.com/iwandi/RaceVision.Utility/blob/e2e93673a54719db568772450a7c2db800630f7c/RaceVision.AdapterHost/Config.cs#L97-L114)).

**Dieser WebSocket ist am untersuchten Commit kein Daten-API.** `ProcessData(string type, JObject data)` verwirft `data` und broadcastet nur den Text des Pakettyps, beispielsweise `LiveRaceStateResponse`. Eingehende Client-Nachrichten werden ignoriert ([`RaceInfoDataProcessor.cs`](https://github.com/iwandi/RaceVision.Utility/blob/e2e93673a54719db568772450a7c2db800630f7c/RaceVision.RaceInfoWebSocket/RaceInfoDataProcessor.cs#L44-L71), [`RaceInfoDataProcessor.cs`](https://github.com/iwandi/RaceVision.Utility/blob/e2e93673a54719db568772450a7c2db800630f7c/RaceVision.RaceInfoWebSocket/RaceInfoDataProcessor.cs#L109-L126)). Ein Display-Connector müsste daher einen neuen Datenausgang ergänzen oder die Roh-JSON-Dateien beobachten.

## 3. Mapping auf FPV Race Event Data v1

Unser Display validiert `org.fpv.race-event.snapshot` Version 1, konsistente `schedule.currentRaceId/currentIndex`, mindestens ein Rennen und `quality.state` ([`web/race-event-connector.js`](https://github.com/KidCe/Outdoor-FPV-Race-Display/blob/89a3db7b9e4cd047d5bdda39d3dce3ae02b75183/web/race-event-connector.js#L1-L26)). Für `Current`, `Next Up` und `After Next` projiziert es `schedule.nextRaceIds`, Race-Label/Runde/Heat sowie bis zu acht Piloten mit Callsign und Video-Kanal ([`web/display-scene.js`](https://github.com/KidCe/Outdoor-FPV-Race-Display/blob/89a3db7b9e4cd047d5bdda39d3dce3ae02b75183/web/display-scene.js#L50-L87)).

| FPV Race Event Data v1 | RaceVision-Quelle | Mapping / Regel | Sicherheit |
|---|---|---|---|
| `format` | keine | Konstante `org.fpv.race-event.snapshot` | sicher, vom Adapter erzeugt |
| `version` | keine | Konstante `1` | sicher, vom Adapter erzeugt |
| `snapshotId` | keine Revision vorhanden | Hash/Composite aus Event-LID, Race-LID, normalisiertem Zustand und Collector-Revision | vom Adapter erzeugt |
| `capturedAt`, `deliveredAt` | keine Empfangszeit im Payload belegt | Zeitstempel beim Empfang bzw. HTTP/SSE-Versand | vom Adapter erzeugt |
| `event.id` | `LiveStateResponse["Event.LID"]` | als String serialisieren | direkt |
| `event.name` | `LiveStateResponse["Event.Name"]` | unverändert | direkt |
| `event.sourceUrl` | keine | LiveFPV-URL aus der Hybrid-Konfiguration, sonst weglassen | Hybrid |
| `source.provider` | Transport | z. B. `LiveTime via RaceVision MiniClient` | Adapter-Metadatum |
| `source.kind` | Transport | z. B. `livetime-signalr-v10` | Adapter-Metadatum |
| `source.revision` | keine | Collector-seitiger monotoner Zähler/Hash | Adapter-Metadatum |
| `schedule.currentRaceId` | `LiveRaceStateResponse.RaceLID` | als String serialisieren | direkt |
| `schedule.currentIndex` | keine Gesamtschedule | `0` in einem current-first Hybrid-Snapshot; andernfalls Index aus LiveFPV | Hybrid/Adapter |
| `schedule.nextRaceIds` | keine | ausschließlich aus LiveFPV oder nach später belegter Race-Lookup-Logik | aktuell nicht aus RaceVision ableitbar |
| `races[].id` | `RaceLID` bzw. `Race.LID` | als String serialisieren | direkt für current/per-race response |
| `races[].label` | `RaceName` | unverändert | direkt |
| `races[].phase` | `RoundType` | `Practice`, `Qualifying`, `Main`, sonst `Unknown` | direkt |
| `races[].round` | `RoundType` + `RaceName` | nur vorsichtig formatieren; keine Rundennummer erfinden | teilweise |
| `races[].heat` | keine getrennten Felder | nur aus eindeutigem `RaceName`-Muster parsen; sonst weglassen | heuristisch |
| `races[].status` | `FlagType` | Mapping aus obiger Tabelle | direkt, aber grob |
| `races[].pilots[]` | nicht belegt | aus LiveFPV übernehmen; später mit redigierten Roh-Payloads prüfen | aktuell Hybrid erforderlich |
| `pilots[].video.channel` | `LiveRaceEntries[].FrequencyName` | nur einem Piloten zuordnen, wenn ein stabiler gemeinsamer Pilot-/Slot-Key nachgewiesen ist; nie allein nach Array-Index raten | Kanal direkt, Zuordnung offen |
| `pilots[].video.frequencyMHz` | nicht belegt | aus vorhandener Kanal-Tabelle ableiten oder aus LiveFPV übernehmen; `FrequencyName` ist kein MHz-Wert | abgeleitet/Hybrid |
| `quality.state` | Verbindungs- und Empfangsalter | `fresh`, bei Quellkonflikt/Teilmenge `degraded`, nach Timeout `stale` | Adapter-Regel |
| `quality.warnings` | Fehler/Teilmenge | fehlende Schedule, Pilot-Korrelation oder Quellkonflikt explizit melden | Adapter-Regel |

Wichtig: Kanalnamen dürfen erst dann auf Piloten gemappt werden, wenn ein gemeinsamer Schlüssel belegt ist. Die Reihenfolge von `LiveRaceEntries[]` einfach mit der Reihenfolge der LiveFPV-Piloten gleichzusetzen wäre für ein Race-Day-Display zu riskant.

## 4. Integrationsoptionen

### A. JSON-Dump beobachten

```text
RaceVision.AdapterHost → JSON files → Node/File watcher → v1 snapshot + SSE
```

**Vorteile:** ohne Änderung an RaceVision testbar; vollständige Runtime-Payloads; sehr schneller Proof of Concept.  
**Nachteile:** zwei Prozesse, Dateisynchronisation, keine Sequenz-/Zeitmetadaten aus RaceVision, RaceVision-WebSocket bleibt ungenutzt.

Empfehlung: als Discovery- und Fallback-Weg. Zuerst echte Payloads sammeln, Secrets und personenbezogene Daten redigieren und daraus versionierte Adapter-Fixtures erzeugen.

### B. Neuer `IJObjectProcessor` im .NET-Host

```text
SignalR MiniClient → JObject router → RaceEventV1Processor → localhost HTTP snapshot/SSE
```

Die Architektur unterstützt mehrere Prozessoren; geparste `JObject`s werden nach Typ an alle registrierten Prozessoren verteilt ([`Router.cs`](https://github.com/iwandi/RaceVision.Utility/blob/e2e93673a54719db568772450a7c2db800630f7c/RaceVision.AdapterHost/Router.cs#L21-L60), [`DataProcessor.cs`](https://github.com/iwandi/RaceVision.Utility/blob/e2e93673a54719db568772450a7c2db800630f7c/RaceVision.Shared/DataProcessor.cs#L62-L94)). Ein neuer Prozessor kann daher ohne Änderung des LiveTime-Wire-Protokolls Zustände zusammenführen und die vorhandenen Endpunkte `/api/connectors/race-event/v1/snapshot` und `/stream` implementieren.

**Vorteile:** sauberster Datenpfad, Empfangszeit kann sofort erfasst werden, kein File-Watcher, direkte Normalisierung.  
**Nachteile:** .NET-Implementierungsarbeit und Lizenzfreigabe nötig; die unbekannten Payload-Felder bleiben zunächst unbekannt.

### C. Eigenständiger .NET-Sidecar neben LiveTimeQue

Ein privater/lokaler .NET-Prozess nutzt den MiniClient, veröffentlicht eine kleine loopback-only JSON/SSE-Schnittstelle und LiveTimeQue führt diese Daten mit LiveFPV zusammen.

**Vorteile:** geringe Kopplung an die Browser-App; bestehende LiveTimeQue-Cache-, Retry- und Freshness-Logik bleibt der zentrale Connector; Direct-LiveTime kann optional bleiben.  
**Nachteile:** zusätzlicher lokaler Prozess und Prozess-Lifecycle.

Dies ist der beste erste Produktionsweg, sofern RaceVision-Code mit Erlaubnis genutzt werden darf.

### D. Direkter Browser/PWA-Zugriff

Nicht empfohlen. Er würde den geheimen Key an den Browser ausliefern, müsste das proprietäre Envelope-/Krypto-Verhalten nachbauen und von einer HTTPS-PWA auf einen unverschlüsselten lokalen SignalR-Endpunkt zugreifen. Außerdem ist der vorhandene RaceInfo-WebSocket in diesem Commit datenlos. Der Browser darf nur den normalisierten, secret-freien Connector-Endpunkt sehen.

## 5. Plattform, Lizenz, Sicherheit und Stabilität

### Plattform und Runtime

- MiniClient, AdapterHost, JSON-Dump und RaceInfo-WebSocket zielen auf `.NET 9` ([`RaceVision.AdapterHost.csproj`](https://github.com/iwandi/RaceVision.Utility/blob/e2e93673a54719db568772450a7c2db800630f7c/RaceVision.AdapterHost/RaceVision.AdapterHost.csproj#L1-L18)).
- Die GUI ist eine Windows-Forms-Anwendung mit `net9.0-windows`; der Konsolenhost ist `net9.0` ([`RaceVision.OBSControl.UI.csproj`](https://github.com/iwandi/RaceVision.Utility/blob/e2e93673a54719db568772450a7c2db800630f7c/RaceVision.OBSControl.UI/RaceVision.OBSControl.UI.csproj#L1-L22), [`RaceVision.AdapterHost.Console.csproj`](https://github.com/iwandi/RaceVision.Utility/blob/e2e93673a54719db568772450a7c2db800630f7c/RaceVision.AdapterHost.Console/RaceVision.AdapterHost.Console.csproj#L1-L12)).
- Obwohl der Konsolenhost kein Windows-Target hat, meldet der Login fest `ClientOperatingSystem.Windows`. Ein Einsatz auf Linux wäre deshalb erst nach einem LiveTime-Kompatibilitätstest belastbar.

### Secret- und Netzwerkgrenzen

- `Key` ist in der Beispielkonfiguration vorgesehen und `Config.Validate` verlangt einen nichtleeren Wert ([`Config.cs`](https://github.com/iwandi/RaceVision.Utility/blob/e2e93673a54719db568772450a7c2db800630f7c/RaceVision.AdapterHost/Config.cs#L9-L23), [`Config.cs`](https://github.com/iwandi/RaceVision.Utility/blob/e2e93673a54719db568772450a7c2db800630f7c/RaceVision.AdapterHost/Config.cs#L33-L62)). Für unsere Integration sollte eine Umgebungsvariable oder ein lokaler Secret Store die Datei überschreiben; eine echte Konfiguration mit Key darf nicht committed werden.
- LiveTime-Verkehr läuft laut Code über `http://...:54235`. Collector und LiveTime sollten daher auf demselben Rechner oder einem vertrauenswürdigen, isolierten Race-LAN laufen.
- Der Connector-Ausgang sollte standardmäßig nur an `127.0.0.1` binden. LAN-/Remote-Zugriff braucht explizite Aktivierung, Authentifizierung und möglichst TLS.
- Roh-Payloads können Pilotendaten enthalten. Discovery-Dumps sind lokal zu halten und vor Tests/Commits zu redigieren.

### Lizenz und Verteilbarkeit

Am untersuchten Commit liegt im getrackten Repository keine `LICENSE`-Datei; die first-party GitHub-Metadaten melden das Repository als **öffentlich**, aber ohne erkannte Lizenz und ohne Release. Öffentlich einsehbar bedeutet nicht automatisch, dass Quellcode weiterverwendet oder verteilt werden darf. Technische Analyse und lokaler Test sind möglich, aber RaceVision-Quellcode sollte nicht in das öffentliche `Outdoor-FPV-Race-Display` kopiert, als Dependency verteilt oder in ein öffentliches Binary eingebettet werden, bevor der Rechteinhaber eine passende Lizenz oder ausdrückliche Erlaubnis erteilt hat. Dies ist eine Projekt-Risikobewertung, keine Rechtsberatung. Quellen: [Repository am untersuchten Commit](https://github.com/iwandi/RaceVision.Utility/tree/e2e93673a54719db568772450a7c2db800630f7c), [GitHub repository page](https://github.com/iwandi/RaceVision.Utility).

### Stabilität

Es gibt keine im Repository sichtbare Protokollspezifikation, keine Response-DTOs für die Live-Daten und keine Tests. API-Version und Port sind hart codiert. Pending Updates desselben Typs können absichtlich zusammenfallen. Der Race-Scanner ist unvollständig, und der WebSocket verwirft die Payload. Diese Punkte machen den Code zu einer guten technischen Referenz und Collector-Basis, aber noch nicht zu einer stabilen öffentlichen Connector-API.

Für eine belastbare Integration sollten wir daher:

- den Quellstand/Dependency exakt auf den geprüften Commit pinnen;
- unbekannte PacketTypes und Parsefehler tolerieren;
- letzten validen Zustand mit Empfangszeit behalten;
- Reconnect plus vollständige Reconciliation testen;
- eine dedizierte Adapter-Fixture-Suite aus redigierten Real-Payloads aufbauen;
- LiveTime- und LiveFPV-Daten nie stillschweigend überschreiben, sondern Konflikte als `quality.state = "degraded"` markieren.

## 6. Konkrete Empfehlung

### Phase 1: sichere Discovery

1. RaceVision lokal gegen LiveTime mit dem vorhandenen Key starten; den Key nur über eine lokale, ignorierte Konfiguration bzw. Umgebungsvariable bereitstellen.
2. JSON-Dump aktivieren und je einen redigierten Payload-Satz für `PreRace`, `Race`, `PostRace`, aktuellen Race Entry, einen expliziten `RaceEntryByRaceResponse` und Estimated Position aufnehmen.
3. Prüfen, ob die Rohdaten stabile Pilot-ID/Callsign/Slot-Felder, Zeitfelder oder Verweise auf das nächste Race enthalten. Erst diese Evidenz darf das Mapping erweitern.

### Phase 2: hybrider Connector

1. Einen loopback-only RaceVision-Sidecar oder `IJObjectProcessor` bauen, der ein internes, secret-freies Envelope liefert:

   ```json
   {
     "type": "LiveRaceStateResponse",
     "capturedAt": "2026-09-05T12:34:56.789Z",
     "sequence": 42,
     "data": {}
   }
   ```

2. Im bestehenden Connector RaceVision als optionale `current-state`-Quelle ergänzen und LiveFPV als Schedule-/Pilot-Quelle beibehalten.
3. Über `event.id`/`RaceLID` oder einen später nachgewiesenen gemeinsamen Race-Key abgleichen. Bei fehlendem Match bleibt der letzte vertrauenswürdige Snapshot sichtbar und der neue Snapshot wird `degraded` statt falsch zusammengeführt.
4. Die bereits vom Display verwendeten HTTP-/Stream-Routen unverändert lassen. Dadurch bleibt die Browser-App unabhängig davon, ob die Daten von LiveFPV, RaceVision oder beiden kommen.

### Source-Priorität im Hybridbetrieb

| Datenbereich | Primärquelle | Fallback |
|---|---|---|
| aktueller Race-Status | RaceVision `FlagType` | LiveFPV/letzter valider Zustand |
| aktuelle Race-ID/-Name/-Phase | RaceVision | LiveFPV |
| Next und After Next | LiveFPV-Schedule | letzter valider Schedule; nicht aus Race-LID-Nachbarschaft raten |
| Piloten/Callsigns | LiveFPV, bis RaceVision-Felder belegt sind | letzter valider Race-Snapshot |
| Kanal pro Pilot | Quelle mit belegtem Pilot-/Slot-Key | LiveFPV; niemals nur per Array-Index fusionieren |
| Qualität/Freshness | Connector | aus Empfangsalter, Vollständigkeit und Quellkonflikten |

## Entscheidung

**Go für einen optionalen lokalen RaceVision-Collector und Hybrid-Normalizer; No-Go für RaceVision als alleinige Next-up-Quelle am untersuchten Commit.**

Der direkte SignalR-Datenweg kann unser Display deutlich reaktiver und unabhängiger von LiveFPV-Seiten machen. Für die Next-up-Anzeige bleibt LiveFPV vorerst notwendig. Der wichtigste nächste technische Schritt ist nicht das Kopieren des Clients, sondern ein secret-sicherer, redigierter Runtime-Mitschnitt: Er entscheidet, ob RaceVision später auch Piloten, Kanalzuordnungen, Positionen und eine eigenständige Queue zuverlässig liefern kann.
