# Vertical profile slice: retired implementation

Issue #30 removes this superseded implementation and its callers/tests. It is not an alternate calculation path or a current requirement.

Use the [current worksheet calculation path](worksheet-calculation.md), [teaching contract](navigation-worksheet-teaching-contract.md), and [weather model](weather-model.md). The worksheet uses one cruise altitude, one-time estimated TOC/TOD placement, the entered aircraft performance, and sequential outgoing-row weather. There is no intermediate altitude model, convergence, checkpoint altitude tolerance, or automatic descent-rate adjustment.
