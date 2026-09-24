# Pilot Intent Implementation Plan

> **For agentic workers:** Implement the assigned task with focused tests and report exact validation. The architect owns integration review and PR.

**Goal:** Preserve pilot inputs locally and require fresh context for every displayed updated calculation.

**Architecture:** Add a versioned v2 input-only store; no v1 migration is required. Adapt the planner to raw input autosave and a single update transaction. Use existing calculation code only with ephemeral results.

**Tech Stack:** TypeScript, IndexedDB, Vitest, Vite.

**Spec:** `docs/superpowers/specs/2026-09-24-pilot-intent-design.md`

## Global constraints

- Do not persist weather products, resolved airport context, calculated output, or PDF output in v2.
- Do not load old v1 data; migration is out of scope by explicit user instruction.
- Preserve literal invalid input text and distinct departure LID versus METAR ICAO.
- No new server-side plan storage.

## Task 1: Input-only storage

**Files:** Add `src/services/storage/pilot-input-repository.ts` and focused tests; touch `contracts.ts` and transfer helpers only as needed. Do not edit UI files.

**Interface:** Export `PilotInputRepository` with `initialize(): Promise<void>`, `listPlans(): Promise<readonly PilotInputPlan[]>`, `getPlan(id: string): Promise<PilotInputPlan | undefined>`, `saveWorkingCopy(plan: PilotInputPlan): Promise<void>`, `submitInputs(plan: PilotInputPlan): Promise<void>`, `saveProfile(profile: AircraftProfile): Promise<void>`, `listProfiles(): Promise<readonly AircraftProfile[]>`, `exportRecovery(planId: string): Promise<string>`, `importRecovery(json: string): Promise<string>`. Export `PilotInputPlan` with `id`, `title`, `rawFields: Readonly<Record<string,string>>`, `selectedProfileId?: string`, `checkpoints: readonly {name:string; coordinateText:string}[]`, `cruiseAltitudeTexts: readonly string[]`, `overrideReasons: Readonly<Record<string,string>>`, `updatedAt`, and `submissions: readonly {submittedAt:string; rawFields: Readonly<Record<string,string>>}[]`. Extend the shape only for required pilot input values; coordinate with architect before breaking the interface.

- [x] Write tests for raw incomplete text, no submission on working save, bounded submissions, atomic failure, distinct `1C8`/`KORD`, and recovery validation.
- [x] Implement v2 storage and import/export with explicit validation and atomic transactions.
- [x] Run focused tests, typecheck, and report output.

## Task 2: Planner and calculation orchestration

**Files:** `src/ui/planner.ts`, `src/main.ts`, any focused adapter and tests. Do not edit `src/services/storage/pilot-input-repository.ts`.

- [x] Restore raw input state from Task 1's interface and autosave on blur with persistent failure feedback.
- [x] Replace Save/Calculate/Refresh primary actions with Update plan. Gate locally, then submit inputs before fetch/calculation. Do not write calculated revision/weather evidence to durable storage.
- [x] Make successful output session-only and clear on edit, failed attempt, reopen, import, or reload. Preserve error until a later success. Revalidate explicit period against current availability.
- [x] Run focused UI/application tests and typecheck; report output.

## Task 3: Architect integration and review

- [x] Reconcile interfaces and inspect diff for all spec requirements, logic, security, and stale-result paths.
- [x] Run focused and full repository CI; fix findings through workers.
- [ ] Verify clean branch ancestry, commit focused changes, push, and open PR with scope and validation.
