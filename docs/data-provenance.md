# Data Provenance

Every planning value records its effective value, origin, timestamp, and enough source or calculation evidence to explain why it exists. Origins are limited to pilot input, aircraft default, external data, calculated, and interpolated. A guarded override stores the computed value, replacement effective value, optional pilot reason, and creation timestamp; the override and its reason remain distinct from the aircraft default in the UI.

The v2 browser store persists pilot input documents and aircraft profiles. Pilot inputs include raw field text, ordered checkpoints, selected profile values, override reasons, and explicit forecast choices. An ordinary working-copy save updates that input document without recording a submission. The explicit **Update plan** action appends a bounded pilot-input checkpoint before external retrieval; only the latest 20 submissions per plan are retained.

Airport and weather responses, provenance evidence, and calculated results are held for the current session and are not durable plan history. A displayed calculation is valid only for its exact submitted pilot inputs and successful attempt's fresh context. Editing inputs or a failed update makes the previous result unavailable as current. Reopening, importing, or reloading requires a new successful update. Provenance can accompany the current display or its PDF output; the source products and calculated result are not retained in the plan store.

A JSON recovery document contains the current pilot input state and required aircraft profile only. It is size-bounded and validated on import, assigned new local IDs, and written atomically as a new plan. It excludes submission history, external evidence, calculations, and revision history. The Worker receives only the airport and weather lookup parameters needed for a calculation; it does not receive or retain plan records.

API responses contain a request ID and normalized cache/source provenance. The application validates transport payloads at its service boundary before mapping them to domain models, so an upstream contract change cannot silently corrupt calculation inputs.

Externally retrieved weather timestamps allow up to five minutes of browser-to-Worker clock skew; locally authored timestamps remain strict. A `stale_on_error` winds response may be retained in the current session as provenance, but stale external context cannot produce a successful current calculation.
