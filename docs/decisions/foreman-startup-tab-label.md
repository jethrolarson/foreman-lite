# Label the Foreman tab at startup

**Status:** implemented
**Shelf life:** retain while Foreman is launched inside an existing Herdr tab.

Foreman renames its containing Herdr tab to `Foreman` on Pi's initial
`session_start`. The default numeric label (usually `1`) does not identify the
orchestrator once Task Thread tabs exist.

The extension uses Herdr's supported `tab rename` command with the injected
`HERDR_TAB_ID`. Pi's `ctx.ui.setTitle()` is intentionally not used because it
sets the pane's OSC terminal title, not the Herdr tab label. Non-startup session
events are ignored so `/reload`, `/new`, `/resume`, and forks do not overwrite a
later human rename. Outside Herdr there is no tab ID and startup continues
unchanged; command/API failures produce a warning without aborting Foreman.
