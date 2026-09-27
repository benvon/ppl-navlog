# Repository Engineering Guidance

Read and apply the applicable parent or user-level `AGENTS.md` (including `~/.codex/AGENTS.md` when present) alongside this file. If their directives conflict, this repository's `AGENTS.md` takes precedence.

## Default Engineering Workflow

* For substantial, separable changes, work as architect and reviewer. Inspect the repository and issue, state confirmed requirements and material assumptions, and write a shared behavioral contract with acceptance criteria before implementation.
* Delegate bounded implementation tasks to GPT-6 Luna at medium reasoning when agent tools are available. Give each agent the same contract, explicit interfaces, and a clear file or responsibility boundary. Use a lighter workflow for small or tightly coupled changes, or when the user requests another approach.
* Review each delegated result and the combined user-visible flow. Return concrete findings for correction, then run the relevant local and remote checks. Report what passed, failed, or could not be verified.
* Preserve isolated branches or worktrees and unrelated user work throughout. Do not open a pull request or claim completion until the integrated result is reviewable and verified.

## Requirements and Model Selection

* Before designing a domain-heavy feature, identify the decisions the user needs to make, the outputs that support those decisions, and explicit non-goals. Ask for an authoritative reference or representative worked example when the domain has an established workflow.
* Agree on the required level of precision before adding dimensions, forecasts, simulations, or special cases. State which values are estimates and which uncertainty the model cannot remove.
* For every proposed data source, calculation, request, and validation, identify the required output or safety property it supports. Do not make a result depend on data that cannot affect that result.
* Walk through one ordinary case and one boundary case with the user before implementing a complex calculation. Show where each input enters, how state advances, and what causes the calculation to stop.
* When review findings repeatedly expose edge cases in the same model, pause and revisit the product goal and assumptions. Simplify or replace the model when appropriate instead of adding another exception.
* When a decision supersedes earlier requirements, remove obsolete behavior and tests, update the current documentation, and preserve user-authored data. Do not let an older plan or automated review comment silently restore superseded scope.
* Give implementation agents a shared behavioral contract and bounded tasks. The coordinating agent must review the combined flow and verify the user-visible result, not only that each task's tests pass.
