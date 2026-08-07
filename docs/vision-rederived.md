# Vision, re-derived

Status: in progress, ongoing `/elicit` sessions. Started 2026-08-07.

## Why this document exists, separate from vision.md

`vision.md` came out of a ChatGPT conversation (`docs/inception.md`) where
the user contributed one paragraph of actual intent (delegate, stay at
director level, subagent-like cost, better visibility than the subagent
UI gives) and the rest — the Thread/Working-Memory/Task-State/Role
taxonomy, the Reuse/Fork/Recycle vocabulary, the ADR-shaped checkpoint,
the foreman-decides-from-metadata claim — was the other model's
elaboration, accepted with light edits rather than derived from lived
experience.

The explicit purpose of running `/elicit` is not to reproduce vision.md.
It's to independently re-derive a vision through guided conversation so
every claim in it is something the user can defend in their own words —
and specifically to avoid the same reactive-disengagement failure mode
that showed up at the *agent* level in the original noolang complaint
(head agent absorbing work instead of staying at the orchestration
layer) from happening at the *human* level (rubber-stamping agent output
without staying engaged). Compare against vision.md only at the end, to
see what's different and why.

This document is the running record of what's actually been derived so
far, updated across sessions. Treat unresolved items as unresolved, not
implicitly settled by omission.

## Terminology (pi-native, not vision.md's)

vision.md's "Fork" collided with pi's own `/fork`/`ctx.fork()` (which
copies full history into a new session — a branching/navigation feature,
not independence). Re-anchored on pi's actual primitives:

- **Spawn**: a fresh child session/process seeded only from task state —
  no shared conversation history. What you want for independent review.
  Not a native pi word; closest existing building block is the
  `subagent` example pattern (`docs/research/pi-vision-validation.md`).
- **pi's `/fork` / `ctx.fork()`**: full-history session branch/clone.
  Reserved for its real meaning; not the review mechanism.
- **Role-swap** (was "hat-swap"): same session, same working memory,
  system prompt replaced for the next turn (`before_agent_start`). Pi
  supports this cleanly; Claude CLI didn't have a native mid-session role
  switch.
- **Checkpoint**: task state written durably, working memory then
  discarded/replaced. Maps to pi's compaction hooks
  (`session_before_compact`, `ctx.compact()`), triggerable on our own
  terms rather than only on context overflow. **Not yet drilled into —
  parked, see Open Questions.**

## What's actually grounded in lived experience (noolang worktree session)

Not speculative — this is what motivated the project:

- The head agent had subagents/worktrees available and mostly used them
  well, but repeatedly pulled implementation and review work back onto
  itself instead of delegating it — a behavioral pattern, not a
  capability gap.
- When asked for review, the head agent reviewed subagent output itself,
  competently, but needed full context to do so — same cost as if it had
  just implemented the thing itself.
- No formal verification step existed; review was ad hoc, whatever the
  user happened to request.
- Once a subagent went idle, it dropped out of UI visibility — small
  follow-up steering had to relay through the head agent.
- Session was ad hoc, no assigned roles/responsibilities going in — the
  head agent's behavior wasn't surprising in retrospect, just not what
  the user wanted on reflection.

## Success criteria (the actual filter)

Stated directly, not architecture: any piece of structure (a role, a
signal, a schema field) earns its place by serving one of these, not
because it made a diagram cleaner. This is the standard vision.md's
inherited structure hasn't been checked against yet.

1. **One agent to talk to.** Delegate to it, it tracks completion,
   unblocks stuck work, and specifically surfaces things that need *your*
   judgment rather than solving everything or asking about everything.
2. **Review catches a reasonable share of real errors.** Not "review
   exists," not "review is independent" as an end in itself — independence
   (Spawn) is a means to this, not the goal. "Reasonable" is undefined
   so far — see Open Questions.
3. **Default autonomous, never unmonitored.** Not stepping through each
   task, but never fully blind either.
4. **The workflow itself stays revisable** as you learn what actually
   happens, rather than being locked in by an upfront design.
5. **You can drill in and steer where needed** — concretely, by attaching
   directly to a task's live session, not by relaying a request through
   the foreman. This is the direct fix for the original noolang
   annoyance (subagents going invisible once idle, small steering
   relayed through the head agent).

## Development posture

Corrected mid-session after an earlier mis-summary ("spend LLM judgment
 only where cheap rules fail") was flagged as contradicting where the
loop-termination discussion actually landed:

> As we iterate we can lean on the LLM to drive to functional and then
> eliminate waste for things that are reliably mechanical.

This is a development-time strategy, not a runtime gate. Build the
foreman's (and other roles') judgment to cover a situation first, so the
system works end to end. Watch it operate on real tasks. Extract a
mechanical shortcut only once a pattern has proven itself reliable and
boring — not by guessing upfront which parts of a decision are "obviously
deterministic." Explicitly not building a hand-crafted decision tree /
expert system that tries to encode good judgment as if-then rules.

This is stated as the general posture for foreman-lite, not just for
loop-termination — tentatively, per the last open-questions item below.

## Interaction model: push and pull

Two distinct, deliberately separate ways the director gets involved,
mapped directly onto success criteria #1 and #5:

- **Push**: a dev agent hits a decision point outside the scope of its
  original task (something the initial request didn't cover) and emits
  a `/flag` signal. The event lands in a log the foreman watches. The
  foreman triages: tell the agent how to proceed itself, or escalate to
  the director — concretely, something like an OS-level notification,
  not just a dashboard update, since a blocked task sitting unnoticed
  defeats "not unmonitored." `/flag` carries the same self-report
  reliability risk as `/done` (see Open Questions) — not examined yet.
- **Pull**: the director attaches directly to a task's live session to
  add guidance or requirements, with no foreman relay involved. This is
  what "drill in and steer" (#5) concretely means — confirmed as
  attaching to the live session itself, not sending a message through
  the foreman or another intermediary.

## Settled (re-derived this session)

Each of these is a claim the user actively reasoned to, not inherited:

1. **Review is automatic**, triggered by the dev agent's own `/done` —
   not something the director/head-agent decides to invoke ad hoc. This
   directly targets the lived-experience problem: removing the head
   agent's discretion means it can't default into being the reviewer.

2. **The foreman never reviews.** Not a quality argument — a
   bandwidth-protection one. Review work inside the foreman's working
   memory degrades its actual job (holding many task threads at once),
   independent of whether the review itself would've been any good.

3. **Review defaults to Spawn** (independent working memory, seeded from
   task state only), likely a different model than the implementer.
   Reasoning: same-context self-review (Role-swap) is a coin flip on the
   failure mode that matters most — a misread requirement baked into both
   the implementation and its tests. A separate context/model is more
   likely to independently re-derive the requirement rather than inherit
   the blind spot.

4. **Role-swap is real and cheap in pi**, not deprecated — kept on the
   map for transitions where continuity is a feature, not a bias risk
   (candidate: Researcher → Engineer, where the engineer should see how
   the researcher arrived at its conclusions). Explicitly not the
   default for review.

5. **Review reports facts, not verdicts, upward.** Compact surfacing
   (`Review on !123 completed. 5 blockers identified`), full detail stays
   at the task level.

6. **The reviewer persists across rounds within one task**, rather than
   being freshly spawned each retry. It doesn't rederive the requirement
   from scratch each round — it checks its own prior list ("was blocker
   #3 addressed") against the new diff. Independence from the *dev* is
   preserved; only the reviewer's own continuity across rounds changes.

7. **Role separation, applied recursively**: the reviewer's job is to
   report what it observes (e.g. "this is the second time I've flagged
   this exact issue"), not to decide what happens as a result. Deciding
   what happens is a lifecycle decision — this was caught mid-session as
   a repeat of the original role-conflation problem, this time almost
   built into the reviewer itself.

8. **For loop-termination specifically: give the foreman visibility (the
   task's workflow step log) and real handles (halt a task, spawn a
   fresh agent), and let its judgment handle oscillation case-by-case.**
   No cheap rule gates this — see "Development posture" above for why
   (this item was originally mis-summarized as a tiering/gating rule;
   corrected). A concrete threshold like "3 rounds is fine, 8 is not"
   was floated and explicitly not committed to; extraction into a cheap
   rule happens later, if and when real behavior earns it.

## Open / parked, not resolved

- **Checkpoint** — flagged multiple times as wanting a deeper pass, never
  actually drilled into. Don't assume anything about it beyond the
  terminology mapping above.
- **What triggers the next step after review's `/pass`/`/fail`** —
  foreman-mediated vs. dev auto-reactivating directly off review's
  signal. Not decided; the oscillation-handling discussion assumed *some*
  loop exists but didn't settle who/what restarts it each round.
- **Whether the reviewer's own inconsistency round-to-round** (flip-
  flopping on whether something counts as fixed) needs a separate
  circuit-breaker. Named as a real edge case, explicitly not pursued
  ("you didn't reach for it, so it's probably not where your attention
  actually is right now").
- **How "same blocker, unaddressed" actually gets evaluated** — exact-ID
  match vs. free-text similarity vs. reviewer re-judging with memory of
  its prior ask. Not resolved; this is part of why stuck-loop handling
  was deferred to foreman judgment rather than a designed rule.
- **What "reasonable" means for success criterion #2** (review catches a
  reasonable share of real errors) — not yet defined. No target rate,
  no way of measuring it named yet.
- **`/flag` reliability** — same self-report risk as `/done`, not yet
  examined the way review's self-assessment risk was.
- **Whether the no-expert-system posture, applied backward to vision.md's
  Role/lifecycle/Task-State structure, actually changes what gets built
  first** — affirmed as a lens, not yet applied to a concrete decision
  about what to build or skip.

## Session log

- 2026-08-07: First `/elicit` session. Covered: origin story validation
  (noolang worktree pain), re-scoping "there needs to be a foreman" away
  from context-bloat and toward role-conflation, the review/verification
  design (automatic trigger, foreman-doesn't-review, Spawn-over-Role-swap
  for review, persistent reviewer, role separation applied to the
  reviewer itself, deliberately deferred stuck-loop design), the
  development posture (LLM-judgment-first, mechanize what proves
  reliable, no expert system), five success criteria, and the push/pull
  interaction model (`/flag`+triage+notification vs. attach-to-live-
  session). Stopped before Checkpoint.
