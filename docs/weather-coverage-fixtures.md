# Weather coverage fixtures

The Winds/Temps station IDs below are representative identifiers from the
Aviation Weather Center station catalog and regional product fixtures captured
on 2026-09-21. They provide exact-ID examples for the three supported product
regions; they are test references, not a complete coverage list.

| Region | Winds/Temps station IDs | Source date |
| --- | --- | --- |
| CONUS (`us`) | ABQ, ATL, BGR | 2026-09-21 |
| Alaska (`alaska`) | FAI, BRW | 2026-09-21 |
| Hawaii (`hawaii`) | ITO, LIH, HNL | 2026-09-21 |

The source date identifies the captured fixture set used by
`worker/api/winds.test.ts`. Product periods in those fixtures are synthetic
variations of that captured product and must not be interpreted as live
availability.
