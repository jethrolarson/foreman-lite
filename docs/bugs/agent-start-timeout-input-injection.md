# Agent startup timeout injected into Foreman input

**Status:** fixed  
**Observed:** 2026-08-10 in Foreman pane `w34:p1` while creating `roadmap-scan-msmlaqa1`  
**Shelf life:** keep while Worker/Verifier launch uses herdr pane submission; revisit if herdr adds a supported non-waiting `agent start` mode.

## Symptom

`create_task` successfully launched a Worker and returned success, but about four seconds later this appeared as raw text in Foreman's pi input area:

```json
{
  "error": {
    "code": "timeout",
    "message": "timed out waiting for agent startup"
  },
  "id": "cli:agent:start"
}
```

It was not a pi user/tool message and did not appear in the session JSONL. The Worker was running normally. The text came from `herdr agent start`'s readiness timeout reaching the caller terminal after launch; capturing and treating the CLI timeout as success did not prevent terminal injection.

## Fix

Worker and Verifier launch now use `herdr pane run` with a fully quoted `pi ... @prompt-file` command. `pane run` submits to the shell and returns immediately; foreman-lite already relies on pi's herdr integration plus its push plugin for real lifecycle transitions, so a separate readiness waiter was redundant.

This removes herdr agent-name registration. `halt_worker` now targets the durable recorded pane ID instead, and all routing/attach operations already use pane IDs.

## Verification

- A scratch `pane run` pi launch was detected by `herdr agent list` as a normal idle pi session with a session ID.
- A real mocked-Foreman `create_task` returned in 865ms and the Worker was detected by herdr.
- An isolated plugin test verified Verifier launch calls `pane run` and never `agent start`.
- TypeScript, JavaScript syntax, formatting, and diff checks pass.
