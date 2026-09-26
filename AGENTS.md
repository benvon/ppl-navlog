# Engineering Principles

This file combines the base engineering principles with requirements for this repository. If a directive here conflicts with the base AGENTS.md, this repository-specific AGENTS.md takes precedence.

## Problem Solving

* Think before coding.
* Translate vague requests into concrete, verifiable outcomes before writing code.
* Inspect the available code, documentation, configuration, and tooling before asking questions that the repository can answer.
* State material assumptions explicitly.
* Make reasonable, low-risk, and reversible assumptions when the repository context provides a clear default.
* Do not guess about facts that can be discovered through inspection or testing.
* Ask for clarification when uncertainty could materially affect scope, interfaces, security, data integrity, compatibility, or irreversible actions.
* If a simpler solution satisfies the requirements, recommend it.

## Requirements and Model Selection

* Before designing a domain-heavy feature, identify the decisions the user needs to make, the outputs that support those decisions, and explicit non-goals. Ask for an authoritative reference or representative worked example when the domain has an established workflow.
* Agree on the required level of precision before adding dimensions, forecasts, simulations, or special cases. State which values are estimates and which uncertainty the model cannot remove.
* For every proposed data source, calculation, request, and validation, identify the required output or safety property it supports. Do not make a result depend on data that cannot affect that result.
* Walk through one ordinary case and one boundary case with the user before implementing a complex calculation. Show where each input enters, how state advances, and what causes the calculation to stop.
* When review findings repeatedly expose edge cases in the same model, pause and revisit the product goal and assumptions. Simplify or replace the model when appropriate instead of adding another exception.
* When a decision supersedes earlier requirements, remove obsolete behavior and tests, update the current documentation, and preserve user-authored data. Do not let an older plan or automated review comment silently restore superseded scope.
* Give implementation agents a shared behavioral contract and bounded tasks. The coordinating agent must review the combined flow and verify the user-visible result, not only that each task’s tests pass.

## Design Philosophy

* Prefer the simplest solution that satisfies the requirements while remaining maintainable.
* Avoid speculative abstractions, premature optimization, and flexibility that has not been requested.
* Assume the code will be maintained by multiple engineers and coding agents over a long period of time.
* Optimize for clarity, operability, supportability, sustainability, and future evolution.
* Keep data, business logic, and interfaces separated when doing so creates clear and maintainable boundaries.
* Treat reliability, security, observability, and testability as design properties rather than afterthoughts.
* Prefer explicit behavior and contracts over implicit coupling, hidden state, and surprising side effects.

## Implementation Standards

* Make the smallest change necessary to satisfy the request completely.
* Do not refactor, optimize, or improve adjacent code unless explicitly requested or required for a correct and secure implementation.
* Every change should be traceable to a stated requirement.
* Follow established repository patterns unless they are unsafe, incorrect, or incompatible with the requirement. Explain material deviations.
* Call out technical debt, dead code, security concerns, or related issues when discovered, but do not modify them without direction unless they directly prevent a correct and secure implementation.
* Prefer small, purpose-focused functions and modules.
* Keep cyclomatic complexity low.
* Build reusable components when they naturally emerge from the requirements; do not introduce abstractions solely for hypothetical future reuse.
* Avoid behavior changes outside the requested scope.
* Preserve backward compatibility when it is an established requirement. Do not retain unsafe behavior merely for compatibility without identifying the risk.

## Reliability

* Design for clear, observable, and safe failure modes.
* Do not hide, ignore, or fabricate failures.
* Surface partial, stale, unavailable, and inconclusive results explicitly.
* Validate important preconditions before performing work that could change state.
* Prefer atomic operations when partial completion could leave data or systems inconsistent.
* Use timeouts, bounded retries, backoff, resource limits, and idempotency where operations may block, fail, repeat, or consume unbounded resources.
* Release resources and clean up temporary state on both success and failure.
* Preserve the original error context when wrapping or translating errors.
* Do not claim that an implementation works unless it has been validated. Report what was tested, what failed, and what could not be verified.

## Secure Software Development

The following requirements apply when writing or modifying software, scripts, configuration, automation, infrastructure as code, tests, fixtures, and examples. They supplement—and do not relax—the safety requirements for commands, tools, credentials, filesystem operations, and external systems used during the work.

* Treat security properties as requirements and preserve existing security controls.
* For changes that cross a trust boundary, identify the untrusted inputs, sensitive data, privileged operations, and plausible misuse before implementation.
* Prefer secure defaults, least privilege, defense in depth, and deny-by-default access control.
* Do not weaken, bypass, or disable a security control merely to make code, tests, or tooling pass.
* Stop and explain the conflict when requirements cannot be satisfied securely.

### Secrets and Sensitive Data

* Never hardcode or commit credentials, tokens, passwords, private keys, connection strings, or other secrets.
* Never expose secrets in logs, errors, telemetry, command output, command arguments, tests, fixtures, examples, diffs, generated artifacts, or assistant responses.
* Use the project's approved secret-management and runtime-injection mechanisms.
* Use clearly fake and nonfunctional values in examples, documentation, and tests.
* Access, process, return, and retain only the sensitive data required for the intended operation.
* Avoid copying or modifying secret-bearing files unless the task explicitly requires it.
* Redact sensitive values while preserving enough nonsensitive context to diagnose failures.
* If a secret may have been exposed, do not repeat it. Identify the affected location and recommend revocation or rotation. Do not rotate or revoke credentials unless explicitly authorized.

### Input Validation and Injection Prevention

* Treat data from users, APIs, files, databases, queues, configuration, environment variables, command-line arguments, and external services as untrusted until validated.
* Validate untrusted input at trust boundaries using explicit allowlists or schemas.
* Check applicable types, lengths, ranges, formats, encodings, allowed values, and cross-field relationships.
* Normalize or canonicalize input before validation when multiple equivalent representations are possible.
* Reject invalid, ambiguous, or unexpected input rather than silently repairing it.
* Do not use generic sanitization as a substitute for validation, parameterization, or context-specific output encoding.
* Use structured and parameterized APIs for database queries, serialized data, templates, and other interpreter boundaries.
* Never concatenate untrusted data into executable syntax.
* When software launches an external process, prefer direct process-execution APIs with a fixed executable and separately supplied arguments.
* If software genuinely requires a shell, never interpolate untrusted data into shell syntax. Validate and allowlist all externally influenced arguments.
* Apply context-appropriate output encoding when placing untrusted data into HTML, JavaScript, CSS, URLs, headers, logs, or other interpreted output.
* Protect filesystem operations against path traversal, unsafe permissions, symlink attacks, race conditions, and unintended overwrite.
* Validate externally influenced URLs, redirects, schemes, hosts, ports, and resolved destinations when they affect outbound connections or navigation.

### Authentication, Authorization, and Cryptography

* Use established authentication, authorization, session-management, and cryptographic libraries rather than custom implementations.
* Enforce authentication and authorization on a trusted system for every protected operation and resource.
* Do not rely on client-side checks, hidden interface elements, or caller-provided roles for authorization.
* Verify authorization against the specific action and object being accessed, not only at login or route level.
* Grant users, processes, service accounts, files, and network connections only the permissions they require.
* Fail closed when authentication, authorization, or security-policy evaluation cannot be completed.
* Use approved cryptographic algorithms and cryptographically secure randomness.
* Never invent cryptographic algorithms or protocols.
* Never disable certificate validation, hostname verification, or other transport-security checks without an explicit, documented, and narrowly scoped requirement.
* Protect sensitive data in transit and at rest according to the applicable threat model and project requirements.

### Errors, Logging, and Auditability

* Return errors that are useful without exposing secrets, sensitive data, internal paths, stack traces, queries, account existence, or unnecessary implementation details.
* Log security-relevant events with enough context for investigation without logging credentials, tokens, session identifiers, private data, or full sensitive payloads.
* Use structured logging or appropriate encoding so untrusted input cannot forge or corrupt log entries.
* Do not expose detailed internal failures to untrusted callers when a generic external response is sufficient.
* Preserve auditability for privileged or security-sensitive operations.

## Testing

* Write code that is easy to test.
* Prefer designs that separate business logic from external dependencies.
* Define success criteria that can be validated through automated tests whenever practical.
* Test observable behavior rather than implementation details where possible.
* Cover normal behavior, boundary conditions, invalid input, and expected failure modes.
* Add negative and abuse-case tests when changes affect validation, authorization, sensitive data, privileged operations, or other trust boundaries.
* Do not use real secrets, production data, or live privileged credentials in tests.
* Run the repository's relevant tests, formatting, linting, static analysis, dependency scanning, and secret scanning when available.
* Report unavailable, skipped, failed, or inconclusive validation explicitly.

## Dependencies

* Prefer mature, well-supported open-source libraries over custom implementations of complex functionality.
* Minimize new dependencies and add them only when their value justifies their maintenance and security cost.
* Respect the repository's compatibility constraints, lockfiles, and version policies.
* When adding or upgrading a dependency, prefer a currently supported version.
* Consider maintenance status, ownership, release history, integrity controls, license compatibility, transitive dependencies, and known vulnerabilities.
* Use the project's established package manager and integrity or checksum mechanisms.
* Do not perform unrelated dependency upgrades without direction.

## Documentation

* Write code that is self-explanatory where possible.
* Add comments when they help future maintainers understand intent, constraints, security considerations, or non-obvious behavior.
* Document public interfaces, important invariants, operational requirements, and failure behavior.
* Document non-obvious trust boundaries, security assumptions, accepted risks, and required external controls.
* Keep documentation consistent with the implemented behavior.

## Language Preferences

* Prefer Go as the default implementation language.
* Prefer Python when Go is not the best fit.
* Use another language or technology when it is clearly better suited to the task or required by the existing project.
* Follow the established language and framework choices of an existing repository unless the task requires otherwise.

## Tooling

* Use `mise` for local tool and version management. If a tool is not available locally, attempt to add it via `mise`.
* Ensure the mise shims are in place before determining if a tool is available or not.
* Fall back to system-installed tooling only when the required tooling is unavailable through `mise`.
* Use shell commands when they are the clearest and most maintainable way to perform development tasks.
* Before executing a command, consider whether it could modify or delete data, execute untrusted content, expand an unintended target, expose sensitive information, or affect an external system.
* Construct commands defensively: quote variables, avoid `eval` and unnecessary dynamic command construction, validate targets and externally influenced arguments, and avoid placing secrets in command arguments or output.
* Prefer direct, narrowly scoped commands over broad recursive operations, unresolved globs, or commands whose targets depend on unvalidated variables.
* Prefer existing repository tasks and scripts over reproducing their behavior with ad hoc commands.
* Do not bypass established validation or security tooling merely because it is inconvenient or slow.

## Source Control and Collaboration

* Assume the user may modify code before, during, or after implementation.
* Do not assume sole authorship of any codebase or working session.
* Inspect the working tree before making changes and preserve unrelated user work.
* Do not discard, overwrite, or rewrite changes that are outside the requested scope.
* Keep commits purpose-focused and limited to the requested change.
* Use signed commits when working with GitHub repositories.
* Signed commits are not required for Azure DevOps repositories.
* Use Conventional Commits for commit messages and pull request titles.
* Pull request descriptions should summarize:
  * What changed
  * Why it changed
  * Testing and validation performed
  * Known limitations or follow-up work, when applicable

## GitHub

* Assume the GitHub CLI (`gh`) is available and authenticated unless proven otherwise.
* Troubleshoot authentication issues before assuming `gh` is unusable.
* Verify repository, branch, pull request, and authentication context before performing GitHub operations.
* Do not claim that remote checks passed without verifying their current state.