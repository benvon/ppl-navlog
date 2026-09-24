# Pilot intent persistence and current calculation design

## Authority and scope

Issue #7 defines the persistence boundary for this feature. The user's current pre-1.0 instruction explicitly removes v1 migration from scope. A plan is browser local. Durable data consists of pilot entered working text, structured pilot inputs once valid, selected aircraft profiles, and a bounded record of explicit Update plan submissions. Airport and weather responses and calculated navlog output are disposable. Issue #9 must consume this boundary: current provenance can appear in a displayed calculation or PDF, but neither source products nor results become permanent plan history. A weather only refresh or recalculation does not create a pilot input checkpoint. Existing revision browsing is outside this feature and must not expose stale v1 calculations as current.

## User workflow

1. A pilot may enter a new plan or open an existing one. The editor preserves literal field text, including blank, incomplete, and invalid values. It retains checkpoint order, coordinate input text, selected profile, override reasons, and explicit weather choices. Focus leaving a pilot input commits the current editor state to IndexedDB without resolving airports, fetching weather, or calculating. A failed write leaves a persistent visible failure until a later successful write. Never label an unconfirmed write saved.
2. The planner presents one primary **Update plan** action. It is disabled while locally required inputs are missing or invalid. Nearby controls explain specific problems. External data availability does not determine this local enablement. The handler repeats local validation before doing work.
3. Update plan atomically saves the submitted pilot input state and a bounded checkpoint before external retrieval. Failure of that write ends the attempt with a persistent storage error. Once it succeeds, weather and calculation failures do not erase the submitted input checkpoint.
4. The attempt resolves current airport and weather context, validates the pilot's explicit METAR station and forecast selection against current responses, then calculates. Failure clears any displayed successful result and shows a persistent actionable error. Editing or starting a retry does not clear the error prematurely. Only a successful complete calculation replaces it. The result and its provenance live in memory for the current session; a reload or plan open starts with no result and explains that Update plan is needed.
5. The departure airport identifier and explicitly selected nearby METAR ICAO are separate strings. Neither can be inferred from the other during save, reload, import, or migration. A saved forecast period remains an input but cannot be used until current availability confirms it remains valid; an unavailable period blocks with an explanation, never an automatic replacement.

## Storage and migration contract

- Use a versioned v2 IndexedDB database. Existing v1 data does not need migration or compatibility and is not loaded into the active planner. v2 stores profiles and one current pilot input document per plan; each document contains bounded checkpoints of submitted pilot inputs only. Keep the latest 20 submissions per plan at most. Store raw field text as strings and structured checkpoint/waypoint values without weather products, airport lookup results, calculation snapshots, traces, or PDF output. A profile version referenced by a plan must remain available.
- A field save is an upsert of the current pilot input document and does not append a checkpoint. Update plan appends one checkpoint after local validation and before external retrieval. A weather only refresh does not append one.
- Do not migrate or load old v1 plan data. Keep the old database untouched; deleting it is unnecessary for this change. The new schema is explicitly versioned for future compatibility decisions.
- Current plan recovery JSON contains pilot input state and required profile only. Validate schema, size, value types, ranges, and relationship IDs before any write; import atomically as new IDs. It must not include external context or calculation results. Imported plans open with no result and require current context and Update plan.
- Avoid storing sensitive browser data in a server or request to a new endpoint. Treat import JSON and IndexedDB records as untrusted; text rendering uses `textContent`.

## Integration boundaries

- Preserve existing pure calculation engine and Worker fetch contracts. Change the browser orchestration so a calculation does not call a durable calculated revision or weather snapshot write. Legacy v1 code may be removed or left unused, but the active planner must not write new v1 weather or result records.
- Model UI states explicitly: editing, saving, updating, updated, and failed. A result is current only for the exact submitted pilot inputs and the successful attempt's fresh external context. Any pilot edit immediately makes the result unavailable as current.
- The current release's route aware weather improvements remain issue #9. This feature must not invent destination METAR behavior or route aware interpolation. It must preserve current selection semantics while preventing stale weather display.

## Acceptance tests and gates

- Field blur and reload preserve exact incomplete/invalid text, ordered checkpoints, profile values, override reasons, departure LID `1C8`, and a distinct selected METAR `KORD`; failed IndexedDB writes show a persistent failure.
- Update plan is locally gated and revalidates on invocation. Its submitted checkpoint persists through network or calculation failure; a failed input write prevents calculation. An old result is absent after failure, reload, import, or migration. Error persists through edits and retry start, then clears on successful update.
- Saved period unavailable or inapplicable in current availability blocks without silently choosing another; stale or unavailable external context never supplies a successful result.
- Recovery import is atomic and result free. Weather refresh/recalculation does not add a pilot input checkpoint. Old v1 browser data is not loaded or replayed.
- Run focused tests plus `npm run ci`. Inspect final diff for trust boundary, migration, and state transition errors before PR.
