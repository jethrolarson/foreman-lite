# Worker and Verifier model selection

**Status:** investigation and design recommendation, revised after independent review on 2026-08-09

**Shelf life:** revisit when Pi's model CLI/API changes, Foreman stops launching role sessions as `pi` subprocesses, or measured model profiles replace the proposed rubric. Product model names and prices should live in configuration, not this document.

## Question

How can Foreman intentionally choose the model and thinking level for each Worker and Verifier, without turning that choice into an opaque workflow rule?

The short answer is: the existing subprocess launch boundary is already the right control point, but the current tool schemas do not expose it reliably. Add an explicit, validated per-role selection to `create_task` and `start_verifier`; persist the effective selection; then pass exact Pi CLI flags when each role is first launched. Keep the decision in Foreman and use a small, measurable rubric rather than hard-coded task modes.

This is an investigation only. No runtime code was changed.

## Evidence inspected

### Foreman-lite

- `extensions/foreman.ts:23-36` already has optional `provider` and `model` fields on `TaskRecord`.
- `extensions/foreman.ts:195-210` turns those fields into `pi --provider ... --model ...` at the subprocess boundary.
- `extensions/foreman.ts:285-292` launches the Worker with that command. `extensions/foreman.ts:304-345` launches the Verifier with the same task record and therefore the same provider/model.
- `extensions/foreman.ts:390-402` exposes placement but no model choice in `create_task`. `extensions/foreman.ts:506-512` exposes verification context but no model choice in `start_verifier`.
- `extensions/foreman.ts:438-450` tries to inherit the Foreman model through `process.env.PI_PROVIDER` and `process.env.PI_MODEL`.
- The current task's durable `~/.foreman/tasks/investigate-agent-model-msmto8yp/meta.json` contains neither field even though this Worker reports `openai-codex/gpt-5.6-sol` through its Bash environment. This is a small live probe, not a general benchmark.
- Pi documents `PI_PROVIDER`, `PI_MODEL`, and `PI_REASONING_LEVEL` as environment injected into **LLM-callable Bash commands**, resolved when each command starts. It does not document them as extension-process configuration. Therefore reading them from `process.env` inside the Foreman extension is not a supported way to inspect the current Foreman model. The missing fields in this task demonstrate the practical consequence.
- The task record has no thinking-level field. `piCommand` passes neither `--thinking` nor the `:<thinking>` model suffix.
- A reused Verifier receives only an inbox message (`extensions/foreman.ts:308-316`); it is not relaunched and its model cannot change through the current path.
- Existing design keeps lifecycle judgment in Foreman (`docs/decisions/foreman-owned-policy.md:9-19`). Model selection should follow the same boundary: metadata informs judgment; mechanics validate and launch; code should not infer a workflow from a task label.
- The current checkout has no executable test files, but repository history on the `test-refactor-backfill` line at commit `b21127e` contains `foremanMechanics.test.ts`, `foremanExecution.test.ts`, and `sdkIntegration.test.ts`. Those tests assert provider/model launch arguments, first-versus-reused Verifier behavior, and public Pi extension integration. `docs/plans/test-refactor-and-backfill.md:85-115` records the intended coverage. Any implementation should restore or rebase onto those seams rather than adding more command construction to the current monolith.

### Pi 0.84.1

The complete installed `docs/models.md`, `docs/providers.md`, `docs/settings.md`, `docs/custom-provider.md`, `docs/environment-variables.md`, `docs/usage.md`, `docs/sdk.md`, and `docs/extensions.md` were inspected, along with the complete `examples/extensions/subagent/` model-launch path and `examples/extensions/preset.ts`.

Relevant capabilities:

1. **CLI launch is direct and sufficient.** `--provider <name>`, `--model <pattern>`, and `--thinking <level>` select a new process's model. `--model` also accepts exact `provider/id` and optional `:<thinking>`. Pi's subagent example uses this same pattern by adding `--model` before spawning a child process.
2. **Exact model metadata is available to an extension.** `ctx.modelRegistry` can find models and enumerate available authenticated models; `ctx.model` and `ctx.thinkingLevel` report the current session's effective selection. `ctx.scopedModels` is only the Ctrl+P/session scope, not a general policy catalogue.
3. **In-session switching exists but is local.** `pi.setModel(model)` and `pi.setThinkingLevel(level)` change the current Pi session; `setModel` returns false without usable authentication. Foreman's extension instance cannot call that API on another pane's Pi process.
4. **The SDK can construct a session with an explicit `model` and `thinkingLevel`,** and restores/defaults/falls back when a model is omitted. Moving Foreman to SDK-owned sessions would expose more control but is unnecessary for initial selection and would replace the working Herdr-visible subprocess topology.
5. **Defaults are directory-sensitive.** Global and project `.pi/settings.json` can define `defaultProvider`, `defaultModel`, and `defaultThinkingLevel`; project settings override global settings. If no model is supplied, Pi restores a session model, then uses settings, then the first available model. That is useful for ordinary interactive Pi but too implicit for a recorded orchestration decision.
6. **Availability is not capability quality.** Model metadata exposes provider/id, context window, output limit, input modalities, reasoning support, and configured token prices. It does not establish coding accuracy, latency, tool-use reliability, or independence from another model. Those require measured, deployment-specific profiles.
7. **Custom providers and model catalogues are supported, but registries are context-dependent.** Built-ins plus user-level `models.json`/auth are process-global inputs, while extension-registered providers can depend on the process's loaded resources, cwd, project revision, and trust decision. A Foreman `ctx.modelRegistry` is therefore not automatically authoritative for a child launched in a target worktree. Exact IDs cannot be assumed globally.

## Current constraints and failure modes

| Constraint | Consequence |
|---|---|
| One `provider`/`model` pair is stored per task | Worker and Verifier cannot intentionally differ. |
| Selection is absent from both tool schemas | Foreman has no explicit control despite the launch helper supporting flags. |
| Inheritance reads undocumented extension-process environment | Child sessions usually fall through to their own Pi defaults; the task record does not explain the effective choice. |
| Thinking level is neither captured nor passed | Reasoning budget can silently differ with global/project settings. |
| Pi CLI accepts patterns | A broad or ambiguous pattern can resolve differently as catalogues change. |
| Launch success only means Herdr accepted the shell command | Unknown model, missing auth, or provider failure can occur after placement/tab side effects or during the initial turn. |
| A persistent Verifier is reused | A later request cannot silently demand another model without either switching the live session or creating a new verification context. |
| Worker and Verifier share a cwd and user configuration | Available providers and privacy/cost policy are installation concerns, not facts Foreman should invent. |
| Foreman and child resource contexts can differ | Foreman's registry may accept a provider that the target-cwd child lacks, or miss/describe one that a trusted project extension adds or overrides. |
| No model-quality telemetry is recorded | A rubric cannot be calibrated from outcomes yet. |

## Feasible control points

### 1. Explicit CLI selection at role launch — recommended first step

Add an optional exact selection to each launch-owning tool:

```ts
type AgentModelSelection = {
  provider: string;
  model: string;
  thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
};

create_task({ ..., workerModel?: AgentModelSelection })
start_verifier({ ..., verifierModel?: AgentModelSelection })
```

Resolve omitted values to a concrete effective selection before any Git/Herdr side effect, persist it by role, and launch with all three exact flags. Separate fields are preferable to a free-form model pattern because they are typeable, auditable, and avoid accidental wildcard/name matching.

The initial implementation needs an explicit **common-registry contract**; Foreman's current `ctx.modelRegistry` alone is not sufficient:

- Supported role profiles may reference Pi built-ins/catalogues, user-level `models.json` plus user-level auth, and explicitly configured provider extensions only when the same extension paths are allowlisted in validation and launch. Auto-discovered project/provider extensions are out of scope for v1.
- Launch role processes with auto-discovered extensions disabled (`--no-extensions`) and load the Worker or Verifier extension explicitly with `-e`. Otherwise a trusted project extension in the target cwd can add or override the selected provider after Foreman validated a different composition. Additional role/provider extensions must come from the common allowlist; provider registration outside it is prohibited.
- Resolve/validate in a dedicated runtime composed from `ModelRuntime` and the exact user agent directory, models file, credentials, and allowlisted provider-extension paths used by the child launch—not against the Foreman session's fully composed registry. Exact CLI flags then override project default settings.

Under that contract, validation should:

1. find the exact provider/model in the common launch registry;
2. require configured authentication/availability;
3. check requested thinking against model capability and reject unsupported intent rather than silently changing assurance;
4. check hard task constraints available to Foreman (context, images, provider/privacy policy);
5. return the resolved provider, model ID, thinking level, context window, registry-policy revision, and profile revision in tool details.

The child remains the final enforcement point. Its role extension should persist the actual `ctx.model` and `ctx.thinkingLevel` at `session_start`; the first role signal and launch diagnostics should expose requested versus observed values. A mismatch is a launch failure, not a successful fallback.

If extension-registered/project-local providers become a requirement, replace the v1 restriction with a **target-child-context preflight**: after the target revision/cwd exists but before the initial LLM turn, start a probe with the exact child cwd, trust decision, resource flags, agent directory, and provider extensions; have it resolve auth/model/thinking and write an atomic acknowledgement. Launch the role only after that acknowledgement. A timeout, unavailable model, or mismatch must fail visibly and roll back whatever placement/session resources were created. Tests must include a provider registered only in the Foreman context, only in the target project, and overridden differently in each. A generic `pi --list-models` table or Foreman-side lookup is not an adequate machine-readable substitute.

### 2. Capture the active Foreman selection through `ctx` — suitable default source

When no role-specific selection and no role default is configured, `ctx.model` and `ctx.thinkingLevel` may nominate the exact selection, rather than reading `process.env`. The nominated pair must still exist and authenticate in the common launch registry; Foreman's registry membership does not waive child validation. This preserves today's apparent intention to inherit Foreman's model while making the result explicit and durable. It is an input chosen before validation, not a fallback after another choice fails.

### 3. In-session model switching through the role extension — defer

Worker/Verifier extensions could accept a structured inbox control message, validate it with their own `ctx.modelRegistry`, call `pi.setModel`, then set thinking level at an idle boundary. This would preserve conversation context while changing models.

It is feasible but should not be the first implementation because it adds protocol acknowledgement, active-turn ordering, authentication failure, and cross-provider history compatibility questions. A text directive cannot invoke Pi's built-in `/model`: built-in interactive commands are not extension commands and are not executed by sending prompt text.

For the first version, if `start_verifier` reuses a Verifier and the requested selection differs from its persisted selection, reject with the existing selection and ask Foreman to choose reuse or a future fresh-Verifier capability. Never claim the model changed when only a message was sent.

### 4. SDK-owned sessions — not recommended for this need

`createAgentSession({ model, thinkingLevel })` provides typed control and `session.setModel`, but adopting it would make Foreman own process/session UI integration that Herdr and the Pi CLI currently provide. Revisit only if Foreman later needs broad programmatic session supervision, not merely model choice.

## Recommended state and policy shape

Replace the task-wide pair with role-specific launch facts. Preserve missing legacy fields when reading old records.

```ts
type EffectiveAgentModel = AgentModelSelection & {
  selectedBy: "explicit" | "role-default" | "foreman-active";
  profile?: "economy" | "balanced" | "frontier";
  profileRevision?: string;
};

type TaskRecord = {
  // existing task fields
  workerModel: EffectiveAgentModel;
  verifier?: {
    paneId: string;
    model: EffectiveAgentModel;
  };
};
```

The profile maps should be user-level Foreman configuration, containing exact provider/model/thinking triples plus measured latency, tool reliability, allowed data classes, and a common-registry policy revision. Under the v1 contract they cannot name auto-discovered project providers; an extension-registered provider must be in the explicit common allowlist. Keep product IDs out of role prompts and out of the rubric so model catalogue churn is a config update, not a policy rewrite.

Foreman's tool result and eventual role signal should report the effective `provider/model:thinking`, not only the requested alias. Session assistant messages already record actual provider/model, so a later adapter can audit requested versus observed selection.

## Defaults and fallback behavior

Choose exactly one source for a **new role session**, in this order:

1. explicit selection supplied by Foreman, if present;
2. configured role default (`worker` and `verifier` may differ), if present;
3. concrete active Foreman `ctx.model` plus `ctx.thinkingLevel`, only when neither of the above exists;
4. otherwise fail before placement/session creation.

After a source is chosen, validate it against the common launch registry. **Do not continue down the list when the chosen selection is unknown, unavailable, unauthenticated, or unsupported.** The ordering fills an omitted policy value; it is not a runtime substitution chain. Persist `selectedBy` before launch and report the same source in tool details.

Do not delegate selection to Pi's “first available model” fallback. It is valid interactive behavior but makes cost and assurance dependent on catalogue order.

Failure rules:

- **Any chosen selection unknown/unavailable:** fail closed and list bounded available profile names or exact candidates. This includes an unavailable configured role default and an active-Foreman nomination absent from the common registry. Do not silently substitute.
- **Unsupported thinking level:** fail closed. Silent clamping makes the durable record lie about intended reasoning.
- **Observed child mismatch:** fail the launch and retain requested/observed values in diagnostics; never relabel it as success under another model.
- **Runtime provider failure after launch:** let Pi's same-provider retry policy operate. Do not automatically cross-provider switch a persistent session in v1. Report the failure and let Foreman choose retry, a fresh session, or human escalation.
- **Reused session:** retain its recorded effective selection. A conflicting new request is an explicit error until model-switch/fresh-role semantics exist.

These conservative rules are justified by observability: an unavailable agent is visible, while a silently cheaper, weaker, costlier, or policy-incompatible substitute can produce a plausible but misclassified result.

## Practical decision rubric

The rubric chooses a **capability profile**, not a product model. First apply hard constraints, then score required reasoning, then consider latency/cost within the eligible tier.

### Step 1: hard filters

A candidate is ineligible unless all are true:

- provider and model are authenticated and allowed for the task's data/privacy class;
- required input modality and tool calling are supported;
- projected peak input is no more than **60% of context window** (task prompt, relevant source/evidence, likely tool output, and retained conversation). The 40% reserve is an initial operational hypothesis for output, corrections, and compaction—not a Pi guarantee;
- maximum output is sufficient for the requested artifact;
- required thinking level is supported;
- measured tool/schema reliability meets the role's configured floor.

If no candidate passes, flag rather than pretending a larger model solves a modality, policy, or context violation.

### Step 2: Worker capability score

Score each dimension 0, 1, or 2:

| Dimension | 0 | 1 | 2 |
|---|---|---|---|
| **R — consequence risk** | read-only/reversible, deterministic check | scoped source change or externally visible advice | security, auth, money, privacy, migration, deployment, destructive/irreversible action |
| **A — ambiguity** | exact request and acceptance oracle | some design choice or incomplete edge cases | conflicting/novel requirements, weak specification, discovery is central |
| **C — integration complexity** | local/mechanical | multiple files/components or one unfamiliar API | cross-system architecture, concurrency, subtle state/lifecycle behavior |
| **K — context pressure** | <20% of candidate window | 20–40% | 40–60% |

Calculate `W = 2R + A + C + K`:

- `0–3`: **economy** profile;
- `4–6`: **balanced** profile;
- `7–10`: **frontier** profile.

Risk is weighted twice because a cheap false answer on a consequential task usually costs more than model latency. Within the selected profile, choose the lowest measured expected cost that meets latency needs. Step down at most one profile for a hard budget/deadline only when `R = 0`, and record the override; otherwise reduce scope or ask the human.

### Step 3: decide verification and Verifier profile

Verification remains a Foreman judgment, not an automatic transition.

- Usually skip an LLM Verifier for `R = 0` when complete deterministic checks cover the claim, or when the Worker report is itself a review intended for direct human inspection.
- Usually request independent verification for source changes, incomplete/nondeterministic tests, consequential factual claims, or `R >= 1`.
- Require an independent verification plan for `R = 2`; irreversible production action may still require a human even after approval.

For a requested Verifier, score `V = 2R + O + A`, where oracle weakness `O` is 0 for complete deterministic checks, 1 for partial tests, and 2 for subjective/no executable oracle:

- `0–2`: economy;
- `3–5`: balanced;
- `6–8`: frontier.

The Verifier needs enough context to inspect evidence but should not inherit the Worker's conversation. Foreman-lite already provides a separate session. Prefer a different model family or provider when `R >= 1` or `O >= 1`, because identical failure modes reduce independence. For `R = 2` and `O >= 1`, treat lack of a meaningfully independent eligible model as a fact to flag, not as proof that same-model review is useless. Deterministic tests, source evidence, and a different prompt/context can still add assurance.

### Examples

- Rename a private symbol with complete tests: `R0 A0 C1 K0 => W1`, economy Worker; tests may make an LLM Verifier unnecessary.
- Add a normal API endpoint across handler/storage/tests: `R1 A1 C1 K1 => W5`, balanced Worker; partial tests give roughly `V4`, balanced Verifier, preferably a different family.
- Diagnose and change an authorization/session race with incomplete reproduction: `R2 A2 C2 K1 => W9`, frontier Worker; `O2` gives `V8`, frontier independent Verifier plus human attention before deployment.
- Summarize a very large read-only corpus: low `R/A/C` does not justify a frontier model, but the context hard filter and `K` require a sufficiently large-window candidate; split/retrieve if none qualifies.

## Falsifiability and calibration

The numeric thresholds are a starting policy, not observed truth. Record for every role launch:

- rubric inputs and any override;
- requested profile and effective provider/model/thinking;
- estimated and observed context use;
- wall time, token cost, provider errors;
- Worker outcome, checks run, Verifier verdict, remediation turns, and human reversal when known.

Evaluate these predeclared hypotheses after a useful sample (at least 30 comparable tasks per tested bucket, and report confidence intervals rather than only averages):

1. On `W <= 3`, economy has no more than a 5 percentage-point increase in verifier denial/human reversal versus balanced while reducing median cost or wall time by at least 25%.
2. On `W >= 7`, frontier reduces denial/remediation incidence by at least 15% relative to balanced. If not, the threshold or profile mapping is unjustified.
3. For `R >= 1` or `O >= 1`, different-family Verifiers find materially more confirmed defects than same-family Verifiers at comparable false-denial rates. Until measured, “prefer different family” is a diversification hypothesis, not a fact.
4. Fewer than 5% of sessions selected under the 60% projected-context rule should overflow before producing their artifact. If not, lower the threshold or improve estimation/splitting.

Do not compare raw model outcomes across dissimilar task scores; otherwise the rubric will merely rediscover that hard tasks fail more often.

## Recommended implementation sequence

1. **Recover the testable mechanics boundary first.** Rebase/restore the `foremanMechanics` and injected-runner test seams from the `test-refactor-backfill` history; they are absent from this checkout's HEAD.
2. Establish the common-registry boundary: dedicated user-level launch registry, `--no-extensions` plus explicit role extension, and an allowlist for any additional provider extensions. Record its policy revision.
3. Add pure selection types, exact common-registry resolution, thinking-capability validation, and role-specific persisted fields. Choose one source, then fail closed if it is invalid; do not substitute.
4. Extend `create_task` with optional `workerModel` and `start_verifier` with optional `verifierModel`; update their prompt descriptions with the concise rubric and justification rather than embedding product IDs.
5. Pass exact `--provider`, `--model`, and `--thinking` flags. Persist requested and actual child selection; return and display the effective selection.
6. Add deterministic tests for explicit selection, omitted-selection source order, unavailable explicit/default/active selections all failing closed, unsupported thinking, shell quoting, Worker/Verifier divergence, legacy records, and conflicting selection on Verifier reuse. Add a trusted target-project extension that registers/overrides a provider and prove v1 ignores it; prove an allowlisted provider has identical metadata in validator and child. Do not make paid model calls in the default suite.
7. Add a live smoke test with two inexpensive authenticated models: create a Worker and Verifier, inspect their session assistant metadata/Bash environment, and prove the persisted effective selections match. Include one invalid model and prove no worktree/tab is created. Include a target worktree with different project defaults/provider registration and prove exact selection plus the common-registry boundary hold.
8. Add outcome telemetry before tuning thresholds. Keep profile mappings in user-level Foreman configuration and review them when catalogues, pricing, or measured reliability change.

## Decision summary

Use the existing Pi CLI process launch as the enforcement boundary. Give Foreman explicit per-role model/thinking parameters, validate them through a registry demonstrably shared with the child—not Foreman's context-dependent registry—persist requested and observed results, and fail visibly rather than substituting or accepting Pi's arbitrary final fallback. Select capability profiles with hard compatibility/context filters plus the risk-weighted rubric above; use latency and cost to choose within an adequate tier. Treat Verifier independence as a measurable assurance strategy, not a rule that every task must spawn another agent.
