# Design notes

## Recursive improvement needs a call stack analogue

Giving a model write access to its repo is not enough. Long-running self-change
needs preserved history across failed attempts. Helix's append-only event log and
lineage graph are that safety net: the agent can clone, fork, snapshot, and
rewind while still inspecting what already failed.

## Experiments before promotions

Ad-hoc self-edits rot quickly. Helix makes experiments first-class so a change
has a hypothesis, a status, and a recorded outcome before it becomes the default
path.

## One language over a split substrate

A dual-language kernel/runtime split can protect the substrate, but it also
makes self-modification harder and raises the contribution bar. Helix keeps one
TypeScript codebase and protects the kernel with policy + tests instead.
