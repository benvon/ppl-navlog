# Weather coverage fixtures

The Winds/Temps station IDs below are representative identifiers from the
Aviation Weather Center station catalog and regional product fixtures captured
on 2026-09-21. They provide exact-ID examples for the three supported product
regions; they are test references, not a complete coverage list.

| Region | Station | Coordinates (latitude, longitude) | Nearest other fixture station |
| --- | --- | --- | --- |
| CONUS (`us`) | ABQ | 35.0402, -106.6090 | ATL, 1,101 NM |
| CONUS (`us`) | ATL | 33.6407, -84.4277 | BGR, 985 NM |
| CONUS (`us`) | BGR | 44.8074, -68.8281 | ATL, 985 NM |
| Alaska (`alaska`) | FAI | 64.8031, -147.8761 | BRW, 436 NM |
| Alaska (`alaska`) | BRW | 71.2837, -156.7843 | FAI, 436 NM |
| Hawaii (`hawaii`) | ITO | 19.7191, -155.0490 | HNL, 188 NM |
| Hawaii (`hawaii`) | LIH | 21.9805, -159.3386 | HNL, 88 NM |
| Hawaii (`hawaii`) | HNL | 21.3187, -157.9224 | LIH, 88 NM |

Coordinates are taken from the exact station-catalog fixtures in `worker/api/winds.test.ts`. Pair distances use great-circle distance rounded to the nearest nautical mile. The 100 NM point-distance bound places the midpoint of the 188 NM ITO–HNL fixture pair within 94 NM of either station and rejects the midpoint of the sparse 436 NM FAI–BRW pair. The CONUS fixture is far too sparse to establish coverage between its stations. These fixtures do not establish regional coverage in any region; each point still requires a reporting station with usable levels inside the bound. Route sampling spacing remains unset until representative route evidence is available.

Development Worker source measurements on 2026-09-24: successful decoded regional products across supported regions/cycles ranged from 618 to 12,504 bytes; Hawaii cycle 06 timed out once. The station catalog decoded to 1,950,054 bytes, below its 3 MiB cap. A separate live station-discovery response measured 651,267 decoded bytes, exceeding the browser's 512 KiB response limit. That confirms the browser response boundary as a size failure path, but does not establish the cause of every intermittent report. The Worker retains a finite 1 MiB regional-source limit and a synthetic valid product above 512 KiB as a bounded regression test.

The source date identifies the captured fixture set used by
`worker/api/winds.test.ts`. Product periods in those fixtures are synthetic
variations of that captured product and must not be interpreted as live
availability.


## One aloft request per route waypoint (2026-09-24)

Each Update plan sends exactly one point query for each pilot route waypoint, including departure and destination at the applicable aloft altitude. The departure METAR remains the surface anchor and the destination TAF remains the terminal descent/pattern surface forecast. Intervening route locations and generated climb, descent, and altitude-transition boundaries use vector interpolation from the immutable waypoint answers; they do not trigger additional API calls. The existing storage limit is 25 checkpoints plus departure and destination, so one Update plan makes at most 27 aloft calls. Routes beyond that supported limit fail before requests. Requests run sequentially because each corrected leg time determines the next waypoint query. A failed answer stops the update before any later waypoint is requested.

| Representative geometry | Coordinates in route order | Distance | Route points | Aloft calls per Update |
| --- | --- | ---: | ---: | ---: |
| KORD–checkpoint–KJVL short CONUS fixture | 41.9742, -87.9073 → 41.8000, -88.2000 → 42.6200, -89.0400 | 79 NM | 3 | 3 |
| ABQ–ATL long CONUS station-pair geometry | 35.0402, -106.6090 → 33.6407, -84.4277 | 1,101 NM | 2 | 2 |
| FAI–BRW Alaska station-pair geometry | 64.8031, -147.8761 → 71.2837, -156.7843 | 436 NM | 2 | 2 |
| ITO–HNL Hawaii station-pair geometry | 19.7191, -155.0490 → 21.3187, -157.9224 | 188 NM | 2 | 2 |

The latter three are station-pair geometries, not validated flight plans or proof of forecast coverage. The KORD checkpoint coordinates and distance are from the existing KORD→KJVL mixed-altitude fixture; distances are great-circle geometry rounded to the nearest nautical mile. FAI–BRW midpoint is outside the Worker 100 NM station limit; CONUS station fixtures are sparse. Every requested waypoint must be individually resolved by the Worker. The browser starts at planned departure UTC and validates each returned issue/use window against its progressive query UTC and corrected waypoint UTC before requesting another point; final validation then checks each calculated waypoint UTC and requires adjacent answer windows jointly to cover each leg's full calculated time interval without a gap. A point whose period expires or starts too late, or a gap between adjacent product windows, blocks this Update. The calculation does not refetch or substitute another period.
