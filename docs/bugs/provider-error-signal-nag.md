# Signal enforcement retried provider failures

**Status:** fixed  
**Observed:** 2026-08-09 in pi session `019fe490-92e7-760d-b3e9-c43075e290fe`  
**Shelf life:** keep while signal enforcement uses corrective model turns; remove if enforcement is redesigned without follow-up requests.

## Symptom

A Worker resumed to open a PR hit provider error `429 / code 1113: Insufficient balance`. The `agent_end` enforcement hook interpreted the missing `worker_signal` as agent noncompliance and triggered corrective turns. Each corrective turn hit the same provider error, wasting requests and producing repeated signal warnings. Restarting the session reset the in-memory nag budget and repeated the cycle.

The session JSONL made the distinction explicit: failed assistant messages had `stopReason: "error"` and `errorMessage`, while ordinary signal omissions ended with `stopReason: "stop"`.

## Fix

Worker and Verifier enforcement now settle immediately when the latest assistant message has `stopReason: "error"`; they reset the nag budget but do not issue a corrective model call. Ordinary omissions still receive bounded reminders. `aborted` remains enforceable because `halt_worker` intentionally aborts a turn and relies on the follow-up signal behavior.

## Verification

A mocked extension test asserted zero `sendMessage` calls for an assistant provider error and one corrective call for an ordinary stop without a signal, for both Worker and Verifier. TypeScript and formatting checks pass.
