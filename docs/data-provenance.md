# Data Provenance

Every planning value records its effective value, origin, timestamp, and enough source or calculation evidence to explain why it exists. Origins are limited to pilot input, aircraft default, external data, calculated, and interpolated. A guarded override stores the computed value, replacement effective value, optional pilot reason, and creation timestamp; it must be visually distinct and reversible in the UI.

Saved plans are immutable, linearly ordered journal revisions. Refreshing weather or recalculating from changed inputs creates the next journal entry rather than silently changing an existing plan. The browser retains raw weather only when needed to explain a selected plan or troubleshoot a result. Exported plan archives are self-contained, versioned, validated on import, and exclude credentials.

API responses contain a request ID and normalized cache/source provenance. The application validates transport payloads at its service boundary before mapping them to domain models, so an upstream contract change cannot silently corrupt calculation inputs.
