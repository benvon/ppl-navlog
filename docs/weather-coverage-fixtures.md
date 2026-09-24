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
