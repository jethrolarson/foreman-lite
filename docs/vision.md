# Task-Oriented Agent Teams with Ephemeral Roles

## Thesis

Build an agent orchestration system where **the task is the unit of work, not the agent or role**.

The user operates at a director level through a persistent **Director → Foreman** thread. The foreman decomposes work into bounded tasks. Each task has durable state and a disposable working-memory history. Roles are activated within tasks as needed and do not persist independently.

The system combines the useful parts of subagents and agent teams with explicit lifecycle management.

---

# Terminology

The word **context** is deliberately avoided because it conflates several distinct concepts.

### Thread

A conversation/process boundary.

Examples:

- Director thread
- Task thread

A thread may have a long-lived conversation history, but that history is not necessarily permanent.

### Working Memory

The accumulated model-visible conversation state for a task.

This includes:

- messages
- reasoning history
- tool calls/results
- conversational interaction
- transient discoveries

Working memory is **expensive and disposable**.

`/clear` discards working memory.

### Task State

The durable state describing what is known about a task.

This includes:

- requirements
- current status
- decisions
- ADRs
- rejected alternatives
- relevant files/artifacts
- test results
- unresolved questions
- handoff information
- agent memory (if enabled)

Task state survives working-memory destruction.

### Role

The currently active behavioral instruction and capabilities assigned to a task.

Examples:

- Engineer
- Validator
- Researcher
- Architect

Roles are **ephemeral**. A role does not own persistent memory.

### Agent Invocation

A model execution under a particular role with access to some working memory and task state.

An invocation may change the task's state, emit lifecycle events, or be discarded.

### Foreman

The persistent orchestration role that manages tasks, roles, working-memory lifecycle, and escalation to the director.

### Director

The persistent high-level interaction between the user and the foreman.

The director should operate primarily on goals, priorities, status, and decisions rather than implementation-level working memory.

---

# Core Model

```text
                         USER
                          │
                   DIRECTOR THREAD
                    user + foreman
                          │
                   task orchestration
                          │
          ┌───────────────┼───────────────┐
          ▼               ▼               ▼
       TASK A           TASK B           TASK C
          │               │               │
     task state      task state      task state
          │               │               │
    working memory   working memory   working memory
          │               │               │
       Engineer        Engineer       Researcher
          │               │               │
       /done           /done          /done
          │               │               │
      Validator       Validator      Engineer
```

The important distinction is:

> **Task state is durable. Working memory is disposable. Roles are ephemeral.**

---

# Roles Are Modes, Not Agents

A role is a system prompt + capabilities temporarily assigned to a task.

For example:

```text
Task #17
  │
  ▼
Engineer
  │
 /done
  │
  ▼
Validator
  │
 /fail
  │
  ▼
Engineer
  │
 /done
  │
  ▼
Validator
  │
 /pass
  │
  ▼
Task complete
```

The Engineer does not become a persistent Engineer agent.

The Validator does not maintain an independent identity.

The **task owns the work**; the role is simply the current operating mode.

This permits role switching without rebuilding working memory.

---

# Three Working-Memory Operations

## Reuse

Change the active role while retaining the same working memory.

```text
working memory
      │
      ├── Engineer
      │
      └── Validator
```

Use when accumulated reasoning is valuable.

Example:

> Engineer implements → Validator reviews the implementation.

---

## Fork

Create new working memory from durable task state.

```text
             task state
                 │
        ┌────────┴────────┐
        ▼                 ▼
 working memory A    working memory B
    Engineer           Reviewer
```

Use when independent judgment is valuable.

The new worker gets the relevant task state, but does not inherit the entire conversational trajectory.

This deliberately trades rehydration cost for cognitive independence.

_Forman decides on workflow step completion_

---

## Recycle

Checkpoint durable task state, then discard working memory.

```text
working memory
      │
      │ checkpoint
      ▼
  task state
      │
      └──────► working memory discarded
```

Use when the accumulated working memory is no longer worth its token/latency cost.

**Recycle is a resource-management operation, not a synonym for task completion.**

**_Task agent may /checkpoint_**
**_Foreman decides if wiping working memory at checkpoint or workflow step end._**

---

# Lifecycle Signals

Agents emit explicit semantic lifecycle events rather than relying on ordinary stop events.

Examples:

```text
/done
/pass
/fail
/checkpoint
```

The meaning is role-specific.

Engineer:

```text
/done = implementation is ready for validation
```

Validator:

```text
/pass = implementation satisfies validation criteria
/fail = concrete problems remain
```

Ordinary conversation does not trigger lifecycle transitions.

If the user asks:

> Why did you choose this abstraction?

the Engineer answers and continues.

A stop event after that answer is not a checkpoint.

---

# Foreman Responsibilities

The foreman owns **lifecycle decisions**, not implementation reasoning.

It can inspect task metadata such as:

```text
Task: caching refactor
Role: Engineer
Working memory: 142k tokens
Task state: 4k
State: /done
Tests: passing
Unresolved questions: 1
```

The foreman can decide:

- continue the current role
- switch roles
- fork an independent worker
- request checkpointing
- recycle working memory
- close the task
- escalate to the director

The foreman does not need to load the entire working memory to make resource/lifecycle decisions.

---

# Checkpointing

Checkpointing is **semantic serialization**, not generic summarization.

The active role should identify information that future work would otherwise have to rediscover:

```text
Decision
Context / motivation
Alternatives considered
Rejected alternatives
Consequences
Current state
Unresolved questions
```

Lightweight Nygard-style ADRs are a preferred durable format because they preserve **negative knowledge**:

> We chose X, and Y was considered but rejected because Z.

This prevents new working-memory instances from repeatedly rediscovering settled arguments.

The checkpoint question is:

> **If this working memory disappeared, what would a future agent desperately need to know?**

not:

> How do I summarize this conversation?

---

# Validation

Validation is a first-class lifecycle transition.

The default path can reuse working memory:

```text
Engineer → Validator
```

because the validator may benefit from understanding how the implementation was developed.

When independent judgment is valuable, the foreman can fork:

```text
                TASK STATE
                    │
             ┌──────┴──────┐
             ▼             ▼
       Working Memory A  Working Memory B
          Engineer          Reviewer
             │                │
             └───────┬────────┘
                     ▼
                  Foreman
```

The system therefore treats **continuity and independence as explicit choices**.

(editor note: how will foreman know when independent judgement is valuable?)

---

# Director-Level UI

The director should primarily see **task state and lifecycle**, not internal model reasoning.

```text
TASKS

● Auth refactor       Engineer      143k   waiting validation
● Cache redesign      Validator      82k   reviewing
● API cleanup         —               0k   complete
● UI migration        Engineer       61k   blocked

FOREMAN
4 active tasks
1 awaiting validation
1 blocked
1 ready to close
```

The director interacts with the foreman and intervenes when judgment or priority is required.

Implementation details remain inside task working memory.

---

# Lifecycle Example

```text
DIRECTOR
    │
    │ "Implement caching layer"
    ▼
FOREMAN
    │
    │ create task
    ▼
TASK
    │
    │ role = Engineer
    ▼
WORKING MEMORY
    │
    ├── investigation
    ├── implementation
    ├── tests
    └── user interaction
    │
   /done
    │
    ▼
FOREMAN
    │
    ├── reuse working memory ──────► Validator
    │
    ├── fork working memory ───────► Independent Validator
    │
    └── continue Engineer
    │
    ▼
VALIDATION
    │
   /fail ───────────────► Engineer
    │
   /pass
    │
    ▼
TASK COMPLETE
    │
    ├── update task state
    ├── produce durable artifacts
    └── recycle working memory when appropriate
    │
    ▼
FOREMAN
    │
    ▼
DIRECTOR
```

---

# Design Principle

> **Don't make agents persistent. Make the things worth remembering persistent.**

The system should optimize separately for:

- **working memory** — continuity and local reasoning
- **task state** — durable organizational knowledge
- **roles** — temporary cognitive modes
- **threads** — bounded conversational processes
- **foreman** — lifecycle and coordination
- **director** — goals, priorities, and judgment

The initial implementation should remain deliberately simple.

Explicit lifecycle signals plus foreman decisions are sufficient to test whether this architecture produces a better balance of:

- context continuity
- independent judgment
- token cost
- rehydration cost
- context-window pressure
- validation quality
- director-level visibility
