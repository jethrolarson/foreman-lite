# Aborted turns triggered lifecycle reminders

**Status:** fixed
**Observed:** 2026-08-10

`halt_worker` sends Escape to interrupt the Worker's current turn. Pi ends that run with an assistant message whose `stopReason` is `aborted`. The turn-end enforcement hook only exempted `error`, so it interpreted an intentional halt as a Worker forgetting to signal and immediately injected a follow-up reminder. That follow-up defeated the purpose of halting and could resume work.

Worker and Verifier enforcement now treat both `error` and `aborted` as non-compliance-free exits. Neither receives a corrective turn after a provider failure or explicit interruption.
