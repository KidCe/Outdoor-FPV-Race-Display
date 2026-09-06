# LiveFPV Next Up and After-Next Analysis

Status: research report
Inspected: 2026-09-06, Europe/Berlin
Scope: public LiveFPV pages inspected through a browser

This report does not change production code or the frozen contract.

## Executive conclusion

The [architecture rework](./RACE-DATA-HUB-IMPLEMENTATION-HANDOFF.md) solved the correct responsibility boundary, but it does not by itself make Next Up reliable.
The main conclusions are:

1. **LiveFPV heat sheets are the primary schedule and lineup source.** They expose explicit heat blocks, phase labels, class labels, local heat numbers, statuses, linked result IDs, frequencies, seed numbers, and bump-up information. Examples are the [Aircrasher Aichtal 2026 Main Events heat sheet](https://aircrasher.livefpv.com/results/?p=view_heat_sheet&id=10291990), the [BavarianMultirotor Central Europe Regional heat sheet](https://bmr.livefpv.com/results/?p=view_heat_sheet&id=10413470), and the [Rotormaniacs Forest Race Finale Q1 heat sheet](https://rotormaniacs.livefpv.com/results/?p=view_heat_sheet&id=10673220).
2. **The event results page is not a canonical chronological queue.** It is grouped by phase and normally presents the highest race number first. It can also contain completion times that are not monotonically ordered, so array position and timestamp sorting are unsafe. See the [Olympia Forest Race Finale results page](https://olympiafpv.livefpv.com/results/) and the [Rotormaniacs Spring Whooprace results page](https://rotormaniacs.livefpv.com/results/?p=view_event&id=496328).
3. **The live-scoring page is the best current-race anchor, not the full future schedule.** It exposes current round, race/heat, status, event name, and live pilot rows when an event is active. At other times it legitimately shows "Waiting for event to start..." with empty fields. This must be treated as source availability or freshness state, not as implicit event deactivation. Examples are [Rotormaniacs live scoring](https://rotormaniacs.livefpv.com/live/scoring/), [Aircrasher live scoring](https://aircrasher.livefpv.com/live/scoring/), and [Olympia live scoring](https://olympiafpv.livefpv.com/live/scoring/).
4. **There is no universal qualifier count, heat count, class layout, or bracket shape.** The samples range from three to ten qualifier rounds, from one to fifteen heats per round, and from single-class to multiple interleaved classes.
5. **The parser must preserve source identity and source order as separate concepts.** A heat should be identified by the selected event plus phase/class/heat identity and, where available, LiveFPV source IDs. A result-page display order must never be mistaken for the schedule order.
6. **Reruns and source corrections must remain legal.** A completed heat can return to staging or running. The same heat identity must remain in place while a new run attempt or source revision is recorded, exactly as required by the frozen contract.

Therefore: the reworked architecture is the right foundation, but Package C still needs a deliberate source-observation parser and a conservative queue assembler. The research does not support a simple "take the next array element" implementation.


Related project decisions:

- [Frozen race-event contract](../contracts/race-event/v1/README.md)
- [Race Data Hub implementation handoff](./RACE-DATA-HUB-IMPLEMENTATION-HANDOFF.md)
- [Existing LiveFPV live-stream research](./research-livetime-auto-stream.md)

## Method and source boundaries

The research used interactive browser navigation and read-only DOM inspection of public LiveFPV pages. Search results were used only to discover candidate organizers and events; claims in this report are based on the linked first-party LiveFPV pages themselves. No login, access-control bypass, private data, or write action was used.

The public results route observed in this research is /results/. Whenever this report says "results page", it refers to that route and its event, heat-sheet, bracket, and race-result variants. The live route is /live/scoring/.

The pages are historical or live views and can change after this inspection. The report records observable behavior and recommends fixture captures before production parser work. Pilot names are included only where they demonstrate the shape of a lineup; they are not used as durable identity assumptions.

The user referred to "Barbarian Multirotor". The LiveFPV organization found during the browser search is titled **BavarianMultirotor**, hosted at bmr.livefpv.com; that is the organization analyzed below.

## Event sample selection

"Large" here is an observable research selection criterion, not a claim about an official event ranking. Events with roughly forty or more entries/drivers, multiple classes, or a deep bracket were prioritized. Smaller events were retained because they expose active/pre-start and simplified-format behavior.

| Organization / host | Event sample | Direct evidence | Observed scale and structure | Research role |
| --- | --- | --- | --- | --- |
| FPV Aircrasher | Fai Aichtal 2025 | [Entry list and event stats](https://aircrasher.livefpv.com/results/?p=view_entry_list&id=470671) | 101 entries and 101 drivers; separate Fai and FPV Dcs class tabs | Large multi-class qualifier sample |
| FPV Aircrasher | Aichtal 2026 Dcs1 | [Event results](https://aircrasher.livefpv.com/results/?p=view_event&id=505321), [Main Events heat sheet](https://aircrasher.livefpv.com/results/?p=view_heat_sheet&id=10291990) | 95 entries and 95 drivers; three qualifier rounds; 23 main-event races; deep 1/2048-to-final bracket | Large current-format bracket sample |
| FPV Aircrasher | Dcs Erfurt 2020 | [Event results](https://aircrasher.livefpv.com/results/?p=view_event&id=323811), [Main Events heat sheet](https://aircrasher.livefpv.com/results/?p=view_heat_sheet&id=2758819) | 80 entries and 68 drivers; eight qualifier rounds; Over40, Dcs Standard, and Dcs Pro are interleaved in the main event; qualifier rounds contain different class heat counts | Large mixed-class and mixed-heat-count sample |
| BavarianMultirotor | Bavarian Multirotor - 2026 Central Europe Regional | [Event results](https://bmr.livefpv.com/results/?p=view_event&id=509260), [Main Events heat sheet](https://bmr.livefpv.com/results/?p=view_heat_sheet&id=10413470) | 32 entries and 32 drivers; five qualifier rounds; 15 main-event races from 1/128 to final | Medium regional bracket sample |
| Rotormaniacs | Spring Whooprace 2026 | [Event results](https://rotormaniacs.livefpv.com/results/?p=view_event&id=496328) | 14 entries and 14 drivers; seeding round, ten qualifier rounds, 15 main-event races; includes a visible timestamp inconsistency inside Qualifier Round 9 | Small completed-format and anomaly sample |
| Rotormaniacs | Forest Race Finale | [Event results](https://rotormaniacs.livefpv.com/results/?p=view_event&id=517186), [Q1 heat sheet](https://rotormaniacs.livefpv.com/results/?p=view_heat_sheet&id=10673220), [live scoring](https://rotormaniacs.livefpv.com/live/scoring/) | Nine entries and nine drivers; five qualifier rounds; no completed results at inspection; live scoring showed Q1, race/heat 3/3, status staging | Active/pre-start and live-to-schedule reconciliation sample |
| Olympia FPV | Forest Race Finale | [Event results](https://olympiafpv.livefpv.com/results/), [Open Class bracket](https://olympiafpv.livefpv.com/results/?p=view_brackets&round_id=1581116&class_id=75110&fullscreen) | Seven entries and seven drivers; seven qualifier rounds whose heat counts shrink from 3 to 2 to 1; separate winners/losers/championship bracket nodes | Small control sample for bracket topology and non-uniform rounds |

The organizer archives also show different operating scales: the [Aircrasher archive](https://aircrasher.livefpv.com/events/) displayed 232 total events, the [BavarianMultirotor archive](https://bmr.livefpv.com/events/) displayed 166, and the [Rotormaniacs archive](https://rotormaniacs.livefpv.com/events/) displayed 19. Rotormaniacs has useful small and active examples, but no comparable 40+ driver event was visible in that archive during this pass.

## What the public LiveFPV pages actually provide

### Live scoring page: current anchor and live status

The [Rotormaniacs live-scoring page](https://rotormaniacs.livefpv.com/live/scoring/) visibly exposed:

- Round = Q1
- Race = 3/3
- a heat header showing Heat 3/3
- Race Status: staging
- Forest Race Finale
- two currently displayed pilot rows
- a Connected connection indicator in the visible page state

The page also had stable-looking presentation elements with IDs round, race, class, race_status, event_name, event_start_date, and event_end_date. The current source scripts included the public LiveFPV Socket.IO client and scoring parser. These selectors and socket events are adapter implementation details, not public contract fields; the [frozen contract](../contracts/race-event/v1/README.md) explicitly forbids consumers from depending on HTML selectors or source packet positions.

The same source can legitimately be empty. At inspection time both the [Aircrasher live-scoring page](https://aircrasher.livefpv.com/live/scoring/) and the [Olympia live-scoring page](https://olympiafpv.livefpv.com/live/scoring/) showed "Waiting for event to start...", with empty round, race, class, event, and status fields. Aircrasher nevertheless had extensive historical event data in /results/. This is direct evidence that an empty live page must not clear the selected event or persisted schedule.

The pages also embed an inline trackInfo object. It contained organization metadata and a last_sync_event_id value that correlated with the visible current event in the Rotormaniacs sample. This is useful for adapter-side correlation, but its stability and semantics are not documented by the public pages, so it must not be promoted directly as a v1 public identity without validation.

### Event results page: event catalog, schedule links, and history

An event results page provides several distinct sections:

- event name and event date range;
- entry list;
- links to each practice, seeding, qualifier, and main-event heat sheet;
- bracket links where the event has a bracket;
- rankings per round;
- completed race results grouped under a phase heading;
- event statistics such as entries, drivers, race track, and total race laps.

The [Aichtal 2026 Dcs1 event page](https://aircrasher.livefpv.com/results/?p=view_event&id=505321) linked Practice Round 1, Qualifier Rounds 1–3, and Main Events. Its stats showed 95 entries, 95 drivers, and 1,964 total race laps. Its Main Events list showed Race 23 first and Race 1 last, while the linked Main Events heat sheet enumerated the corresponding race blocks from 1 upward.

The [Olympia event page](https://olympiafpv.livefpv.com/results/) demonstrates why result-list order cannot be used as a global queue. Its Qualifier Round 1 display listed Race 3, Race 2, Race 1, but the visible completion times were 2:01pm, 2:06pm, and 1:57pm respectively. Race number order and completion-time order therefore differed. The [Rotormaniacs Spring Whooprace page](https://rotormaniacs.livefpv.com/results/?p=view_event&id=496328) showed an even stronger anomaly in Qualifier Round 9: Race 4 was listed at 1:05pm while Race 3 was listed at 2:06pm. The report does not infer the cause; it only records that the rendered result history is not safe to sort as a chronological schedule.

The result list is consequently best treated as **evidence that a run exists or was completed**, not as the sole source of future ordering.
### Heat-sheet page: explicit heat blocks

The [Aircrasher Aichtal Main Events heat sheet](https://aircrasher.livefpv.com/results/?p=view_heat_sheet&id=10291990) exposed repeated semantic heat blocks. Each block visibly contained:

- a source race number;
- a class/bracket label such as FPV Dcs 1/2048 (Even);
- race length;
- source status such as Status: Complete;
- a View Results link with a result ID;
- lineup columns for position, car number/driver, frequency, brand, transmitter number, seed number, and seed result.

The visible HTML shape for one block was a table with class heat_sheet, a race_num element, a class_header element, a race_length element, and a race_status element containing the result link. These are useful adapter observations, but the production adapter should translate them immediately into named source DTO fields and never expose selectors to consumers.

The [BavarianMultirotor Main Events heat sheet](https://bmr.livefpv.com/results/?p=view_heat_sheet&id=10413470) contained 15 explicit blocks in ascending source race number order. The first blocks were Open 1/128 Even, Open 1/128 Odd, Open 1/64 Even, and Open 1/64 Odd. The final blocks were Open 1/4 Odd, Open 1/2 Even, Open 1/2 Odd, and Open 1/1 Final. Each block had a visible status and a result link.

The [Rotormaniacs Forest Race Finale Q1 heat sheet](https://rotormaniacs.livefpv.com/results/?p=view_heat_sheet&id=10673220) contained three blocks:

- Class, Heat 1/3, Status Not Yet Run;
- Class, Heat 2/3, Status Not Yet Run;
- Class, Heat 3/3, Status Not Yet Run.

The third block contained the same pilot pair visible on the live-scoring page at inspection time. This is a useful match between the current live anchor and the schedule, while also showing that Not Yet Run in the historical/lineup page can coexist with live staging.

Heat sheets also expose promotion semantics. In the Aircrasher and BavarianMultirotor main-event samples, later blocks contain Bump-Up in the Seed Result column. A future lineup is therefore not just a static list of originally seeded pilots; it can include explicit promotion results from prior heats.

### Result page: run identity and completed result

A result page provides a more specific run view. The [BavarianMultirotor final result](https://bmr.livefpv.com/results/?p=view_race_result&id=6856334) was titled Open 1/1 Final Results [M1 Race #15] and visibly contained Round: Main Events and Length: 2:00 Timed. The [Aircrasher Fai result](https://aircrasher.livefpv.com/results/?p=view_race_result&id=5927241) contained Fai (Heat 9/11) Results [Q2 Race #9] and Round: Qualifier Round 2.

The public URL IDs are useful source references and should be retained when available. They are not, by themselves, proof that a result URL is the permanent identity of a logical heat across a rerun. The frozen Hub contract correctly separates heat identity from run attempt/revision.

### Bracket pages: topology, not necessarily a linear run queue

The [Olympia Open Class bracket](https://olympiafpv.livefpv.com/results/?p=view_brackets&round_id=1581116&class_id=75110&fullscreen) visibly showed nodes such as:

- Open Class Bracket (Winners) 1-1 and 2-1;
- Open Class Bracket (Losers) 1-1 and 2-1;
- Open Class Bracket (Championship) 3-1;
- result links for each node;
- pilot progression labels such as R1, R3, R6, and R8.

This is a graph-like presentation of progression and does not automatically define the audience-facing linear order of the next three races. The separate main-event heat sheet is the stronger schedule source when it exists. If only bracket topology is available and no source schedule/current anchor resolves the next node, the assembler must return unknown/degraded rather than flattening the bracket by DOM position or race number.

## Cross-event comparison

| Behavior | Directly observed examples | Consequence for parsing |
| --- | --- | --- |
| Qualifier count varies | Aircrasher Aichtal Dcs1: 3; BavarianMultirotor Central Europe Regional: 5; Olympia Forest Race Finale: 7; Aircrasher Erfurt 2020: 8; Rotormaniacs Spring Whooprace: 10 | Never hard-code a qualifier count or assume the next phase is a fixed numeric increment |
| Heat count varies between rounds | Olympia Q1 has 3, Q2–Q4 have 2, Q5–Q7 have 1; BavarianMultirotor Q4 has 7 and Q5 has 8; Aircrasher Fai Aichtal 2025 exposes Fai Q2 Heat 9/11 | Heat number must be scoped to a round/class, not treated as a global index |
| Multiple classes share an event | Aircrasher Fai Aichtal 2025 has Fai and FPV Dcs tabs; Erfurt 2020 mixes Over40, Dcs Standard, and Dcs Pro | Event name plus race number is not enough; include class/phase identity |
| Bracket depth varies | Aichtal Dcs1 reaches 1/2048; Erfurt 2020 reaches different depths across classes; Olympia exposes winners/losers/championship nodes | Parse explicit bracket labels and branch identity; do not infer a universal bracket shape |
| Odd/even branches are explicit | Aichtal, Erfurt, and BavarianMultirotor heat sheets and results use labels such as 1/128 Even and 1/128 Odd | Preserve the branch label as part of heat identity/display data |
| Practice and seeding are real phases | Rotormaniacs Spring Whooprace exposes Seeding Round 1 and ten qualifier rounds; Aircrasher Erfurt exposes two practice rounds | Do not assume the first numeric round is a qualifier |
| Future status is explicit in heat sheets | Rotormaniacs current Q1 shows Not Yet Run; completed samples show Complete | Use source status when present; never infer completion from missing result links alone |
| Live status is separate from result history | Rotormaniacs live scoring showed staging; Aircrasher and Olympia live scoring showed Waiting for event to start | Keep source health/freshness separate from selected event lifecycle |
| Result display is grouped and often reverse-numbered | Aichtal, Erfurt, BavarianMultirotor, Olympia, and Rotormaniacs result pages show phase headings and descending race numbers | Result-page array order is presentation order, not canonical schedule order |
| Completion time is not always monotonic | Olympia Q1 and Rotormaniacs Spring Q9 | Do not sort the future queue by result timestamps |
| Bump-up is explicit | Aircrasher Aichtal and Erfurt heat sheets; BavarianMultirotor heat sheet | Preserve promotion markers and do not treat every later lineup as static seeding |
| Frequencies are in heat-sheet lineups | Examples include F4 5800, F2 5760, R2 5695, and R1 5658 | LiveFPV remains the authority for pilot/channel assignment in v1 |

## Facts versus inferences

| Observation | Safe fact | Unsafe inference |
| --- | --- | --- |
| A heat-sheet block contains a race number, label, status, lineup, and result link | LiveFPV publishes a source schedule/lineup representation for that phase | The block’s HTML index is a global chronological event index |
| Live scoring shows Q1 and Race 3/3 | The live source currently reports a Q1 third heat anchor | Q1 Race 1 and Race 2 are definitely already complete, or the next phase can be guessed without schedule validation |
| Results list shows Race 23 before Race 22 | The page chooses a reverse-numbered/grouped display | Race 23 necessarily ran immediately before Race 22 in every event |
| A result link has a numeric ID | The adapter can retain a source result reference | The ID alone is a durable heat identity across a rerun |
| A heat has no completed result row | No completed result was visible in that page snapshot | The heat was cancelled, never scheduled, or can be removed from the selected event |
| Live scoring says Waiting for event to start | The current live-scoring view has no populated live state at capture time | The Hub has no active event or should erase the last trusted event data |
| A later lineup row contains Bump-Up | LiveFPV explicitly records promotion/seeding information | The displayed pilot order is a complete dependency graph for every future heat |

The first column is browser evidence; the last column is a parser-risk inference that must be rejected.
## Recommended private source-observation model

These are implementation concepts behind the existing Hub seam, not proposed changes to the frozen public contract.

### Event observation

The LiveFPV adapter should retain, privately:

- organization host and source URL;
- upstream event reference extracted from the selected event page;
- event name and date range;
- capture time and source freshness;
- all discovered phase/heat-sheet links;
- the last live-scoring event reference when present.

The exact event reference must be preferred over matching by event name. The Hub’s own eventSessionId remains the public/session identity.

### Schedule heat observation

Each parsed heat-sheet block should become a named DTO with fields equivalent to:

- source event reference;
- heat-sheet ID and URL;
- phase label and phase source ID when available;
- class label;
- source race number;
- local heat number and heat count when displayed;
- bracket/branch label such as 1/128 Even, 1/128 Odd, Winners, Losers, or Championship;
- source-provided order within that heat sheet;
- source status such as Not Yet Run or Complete;
- linked result URL and result ID when present;
- lineup entries with pilot/call-sign, car number, frequency, transmitter number, seed number, and seed result;
- source capture time and parser confidence.

The adapter may use source order from the semantic heat-sheet blocks, but it must retain the explicit labels and IDs alongside that order. It must not emit a bare array position as if it were a universal race identity.

### Current live observation

The live-scoring adapter should privately capture:

- source event reference and event name;
- round label;
- race number and displayed heat number/total;
- class label, including an explicit missing/placeholder state;
- race status such as staging, running, or complete;
- current pilot rows and live timing fields;
- source connection/freshness state;
- source capture time.

In the Rotormaniacs sample, the visible class field was effectively a placeholder while the header contained Heat 3/3. This is a direct reason to treat missing class as ambiguity rather than cross-matching silently across classes.

## Recommended Next Up and after-next policy

The word "next" is ambiguous unless the product chooses one definition. The following distinctions should remain internal:

- **schedule-next:** the next heat in LiveFPV’s explicit source schedule for the selected phase/class/branch;
- **next-not-started:** the first source-scheduled heat whose status is not confirmed complete;
- **bracket-next:** the next node in a resolved bracket dependency graph;
- **chronological-next:** the next heat according to trusted execution timestamps;
- **audience Next Up:** the product projection shown to viewers.

For v1, audience Next Up should be a conservative projection of **schedule-next** scoped to the selected event and resolved class/phase. Chronological-next should not be the canonical definition because the observed result pages do not guarantee reliable timestamp ordering. Bracket-next should only be used when the source provides enough branch/dependency information to resolve it.

### Proposed assembler sequence

1. **Confirm the selected event.** Require an exact event match using the selected source URL/upstream event reference. Do not match an event using only a display name.
2. **Load the complete relevant schedule.** Parse all heat sheets linked from the selected event page, retaining phase, class, heat number/total, branch label, explicit source order, statuses, lineups, and source IDs.
3. **Resolve the live current anchor.** Prefer an exact source heat/result reference. Otherwise match event plus round, class, source race number, and local heat number/total. If class is missing, a phase has duplicate candidates, or the tuple matches multiple heats, mark the current anchor ambiguous.
4. **Respect the source phase and class scope.** Do not scan a single global array containing practice, qualifiers, multiple classes, and main-event branches. The next candidate must come from the resolved schedule scope.
5. **Use heat-sheet source order plus explicit identity.** The ordered heat-sheet blocks are the best available source schedule representation. Use their source order only together with phase/class/heat identity and labels; never use result-page display order or timestamp sorting as a substitute.
6. **Handle phase transitions explicitly.** When the current heat is the last heat of a phase, move to the next phase only if the event’s linked heat sheets and/or live source establish that transition. Do not invent a qualifier-to-main or class-to-class transition from numeric adjacency.
7. **Treat live current state as authoritative for the current anchor.** In the Rotormaniacs sample, live scoring reported Q1 Race 3/3 staging while the Q1 lineup page reported all three heats Not Yet Run. This is a source reconciliation anomaly, not permission to silently reorder the heats. The assembler should retain the live current anchor and mark the schedule relation degraded until the source observations agree.
8. **Derive after-next from the same resolved sequence.** After-next is the next element after schedule-next in the same validated schedule projection. It must not be calculated independently by adding two to a numeric heat field.
9. **Preserve trusted data during source gaps.** If live scoring becomes empty or disconnected, keep the last trusted event/schedule/queue visible with degraded freshness. The event remains selected until explicit deactivation, as required by the handoff.
10. **Publish only a complete candidate.** The normalizer and validator decide whether the assembled candidate can become a public v1 snapshot. If current identity or next ordering is not proven, publish null/omitted fields or degraded quality instead of guessed pilots/heats.

### Important example

For a current live anchor of Q1 Heat 3/3:

- the adapter must not take the third row in a results table;
- it must not assume Q1 has exactly three heats in every event;
- it must not infer that the next global race number is the next viewer-facing heat;
- it must inspect the selected event’s next phase/class heat sheets;
- if Q1 Heat 1 or Heat 2 is still explicitly Not Yet Run while live scoring says Heat 3/3 is staging, it must flag the contradiction and avoid claiming a high-confidence queue until the source state resolves.

This is the specific class of failure that caused previous wrong Next and after-next displays.

## Reruns, corrections, and reconnects

The browser pass did not find an indexed public label literally named Rerun or Re-run. That absence is not evidence that the race-management operation does not exist; it only means the public samples did not expose a searchable label. Rerun behavior therefore remains a contract-driven requirement that must be tested with a captured or simulated source sequence.

The implementation should follow the already frozen rules:

- a rerun keeps the same logical heat ID;
- each confirmed execution gets a distinct run ID or attempt;
- a completed heat may legally return to staging or running;
- a backward status transition is accepted when the source confirms the same heat;
- a corrected result creates a new source revision and published stream sequence;
- reconnects alone must not create a new run attempt;
- a changed result URL/ID must not automatically be interpreted as a new logical heat;
- after a confirmed rerun/correction, the assembler recomputes current, next, and after-next from the updated source observations.

The [frozen contract](../contracts/race-event/v1/README.md) explicitly states that a rerun keeps heat.id and changes runId or attempt. The [implementation handoff](./RACE-DATA-HUB-IMPLEMENTATION-HANDOFF.md) additionally requires source-authoritative backward status transitions and retention of the selected event during transient failures.
## Fixture and test matrix for the later implementation

The following cases should become redacted source fixtures or deterministic adapter tests before claiming reliable Next Up behavior:

| Case | Required source shape | Expected behavior |
| --- | --- | --- |
| Linear qualifier, 3 heats | Rotormaniacs Forest Race Finale Q1 or Olympia Q1 | Match H1/H2/H3 using scoped heat identity; derive next only after exact current match |
| Shrinking heat counts | Olympia Q1 3 heats, Q2–Q4 2, Q5–Q7 1 | Never assume a constant heat count |
| Many qualifier rounds | Aircrasher Erfurt 2020 with Q1–Q8 | Discover rounds from linked heat sheets; do not hard-code Q1–Qn |
| Different heat counts per class | Aircrasher Erfurt qualifier with Dcs Standard and Dcs Pro | Scope current/next to class; do not use one event-global heat number |
| Two classes in one event | Aircrasher Fai Aichtal 2025 | Preserve class identity and independent schedule streams |
| Deep odd/even bracket | Aircrasher Aichtal 2026 Dcs1 or Erfurt 2020 | Preserve bracket depth and Odd/Even labels; do not flatten by result-list order |
| Bump-up entries | Aircrasher Aichtal or BavarianMultirotor Main Events | Retain Bump-Up as source progression metadata |
| Results rendered reverse-numbered | Any sampled event page | Result DOM order must not become schedule order |
| Completion timestamps out of order | Olympia Q1 and Rotormaniacs Spring Q9 | Do not sort future queue by result timestamps |
| Active staging with no results | Rotormaniacs Forest Race Finale | Live anchor can be staging while heat-sheet results are Not Yet Run |
| Empty live scoring | Aircrasher or Olympia live scoring at inspection | Keep selected event and last trusted schedule; mark source/live state degraded |
| Complete-to-rerun transition | Synthetic source sequence based on frozen contract | Keep heat ID, increment run attempt/revision, recompute queue |
| Event correction during reconnect | Synthetic event/source revision sequence | Accept only after event identity confirmation; never silently swap selected event |
| Ambiguous/missing live class | Rotormaniacs live-scoring DOM shape | Do not cross-match to a class-specific schedule without proof |
| Bracket topology without linear schedule | Olympia bracket-only replay | Return unknown/degraded rather than guessing a linear next node |

The first fixture corpus should prioritize Aircrasher Aichtal 2026 Dcs1, Aircrasher Dcs Erfurt 2020, Aircrasher Fai Aichtal 2025, BavarianMultirotor Central Europe Regional, Rotormaniacs Forest Race Finale, and Olympia Forest Race Finale. Raw captures should be redacted and kept private if they contain more pilot information than the test needs.

## Unresolved questions

1. Does LiveFPV expose a stable official event/heat/run ID through the live socket, or must the adapter derive a local run attempt from confirmed status transitions?
2. Is the ordered heat-sheet block order guaranteed to represent the race-manager’s intended run order in every LiveFPV format, or only the order rendered by the current page template?
3. How are multiple classes or tracks interleaved when the race manager alternates between them during a live event?
4. How does the live socket identify class when the visible class field is empty or a placeholder?
5. What exact socket messages distinguish staging, running, complete, cancelled, postponed, and a deliberate rerun?
6. Can a result URL/ID be replaced or duplicated when a race manager resets a completed heat?
7. Does a live current anchor ever intentionally point at a later heat while earlier heats remain Not Yet Run, or was the observed Rotormaniacs state only a pre-start/staging artifact?
8. Can the event page or heat sheet expose a declared next phase/order for a bracket, or must the Hub treat that as unknown until live scoring resolves it?
9. Which data source should be retained when LiveFPV’s schedule page and live-scoring page disagree after reconnect, and how long should the degraded state be held before operator attention is requested?
10. Can a future source adapter obtain an event snapshot without loading every historical result page, or is the heat-sheet set the minimum required fetch?

These questions do not block the architecture. They define the adapter fixture work and the confidence/degraded rules needed before production claims.

## Recommended next step

Proceed with Package C as a source-observation and fixture-driven adapter task:

1. Capture redacted HTML/DOM fixtures for the six priority event cases above.
2. Parse event metadata, linked heat sheets, heat blocks, statuses, lineups, source IDs, and live current fields into private DTOs.
3. Add a pure reconciliation/assembler test layer that exercises exact current matching, phase/class scoping, source order, status anomalies, reruns, and stale recovery.
4. Keep the public v1 contract unchanged. Only the Hub normalizer may publish the final snapshot.
5. Require an explicit confidence/degraded outcome when current, next, or after-next identity cannot be proven.

The browser research supports implementation of a robust adapter, but it does not justify a parser that relies on one fixed qualifier count, one fixed bracket shape, result-page order, timestamps, pilot array positions, or a numeric "next heat" increment.

## Source index

| Purpose | Source |
| --- | --- |
| Aircrasher archive and event-scale discovery | [aircrasher.livefpv.com/events](https://aircrasher.livefpv.com/events/) |
| Aircrasher large multi-class entry list | [Fai Aichtal 2025 entry list](https://aircrasher.livefpv.com/results/?p=view_entry_list&id=470671) |
| Aircrasher 95-driver event | [Aichtal 2026 Dcs1 results](https://aircrasher.livefpv.com/results/?p=view_event&id=505321) |
| Aircrasher deep bracket heat sheet | [Aichtal 2026 Dcs1 Main Events](https://aircrasher.livefpv.com/results/?p=view_heat_sheet&id=10291990) |
| Aircrasher mixed-class historical event | [Dcs Erfurt 2020 results](https://aircrasher.livefpv.com/results/?p=view_event&id=323811) |
| Aircrasher mixed-class main lineup | [Dcs Erfurt 2020 Main Events](https://aircrasher.livefpv.com/results/?p=view_heat_sheet&id=2758819) |
| Aircrasher live current-state absence | [Aircrasher live scoring](https://aircrasher.livefpv.com/live/scoring/) |
| BavarianMultirotor archive and scale | [bmr.livefpv.com/events](https://bmr.livefpv.com/events/) |
| BavarianMultirotor regional event | [Central Europe Regional results](https://bmr.livefpv.com/results/?p=view_event&id=509260) |
| BavarianMultirotor ordered main lineup | [Central Europe Regional Main Events](https://bmr.livefpv.com/results/?p=view_heat_sheet&id=10413470) |
| BavarianMultirotor result identity | [Open 1/1 Final result](https://bmr.livefpv.com/results/?p=view_race_result&id=6856334) |
| Rotormaniacs archive and scale | [rotormaniacs.livefpv.com/events](https://rotormaniacs.livefpv.com/events/) |
| Rotormaniacs completed small event | [Spring Whooprace 2026](https://rotormaniacs.livefpv.com/results/?p=view_event&id=496328) |
| Rotormaniacs active/pre-start event | [Forest Race Finale](https://rotormaniacs.livefpv.com/results/?p=view_event&id=517186) |
| Rotormaniacs active Q1 heat sheet | [Forest Race Finale Q1](https://rotormaniacs.livefpv.com/results/?p=view_heat_sheet&id=10673220) |
| Rotormaniacs live current anchor | [Rotormaniacs live scoring](https://rotormaniacs.livefpv.com/live/scoring/) |
| Olympia non-uniform qualifiers | [Olympia Forest Race Finale results](https://olympiafpv.livefpv.com/results/) |
| Olympia bracket topology | [Olympia Open Class bracket](https://olympiafpv.livefpv.com/results/?p=view_brackets&round_id=1581116&class_id=75110&fullscreen) |
| Olympia live current-state absence | [Olympia live scoring](https://olympiafpv.livefpv.com/live/scoring/) |
