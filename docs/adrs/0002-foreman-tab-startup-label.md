# 0002. Label the Foreman tab at startup

Status: accepted

## Context

The default numeric Herdr tab label (usually `1`) doesn't identify the orchestrator once Task Thread tabs exist.

## Decision

Foreman renames its containing Herdr tab to `Foreman` on Pi's initial `session_start`, using Herdr's `tab rename` command with the injected `HERDR_TAB_ID`.

Pi's `ctx.ui.setTitle()` is intentionally not used — it sets the pane's OSC terminal title, not the Herdr tab label. Non-startup session events are ignored so `/reload`, `/new`, `/resume`, and forks don't overwrite a later human rename. Outside Herdr there is no tab ID and startup continues unchanged; command/API failures produce a warning without aborting Foreman.

## Consequences

Retain while Foreman is launched inside an existing Herdr tab; revisit if that launch model changes.
