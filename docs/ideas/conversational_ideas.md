🤖 ROBOT'S OPINION

Technologically, I think this is **not primarily an “agent team” implementation**. It's a small **orchestration runtime sitting on top of Claude Code's agent primitives**.

Claude Code already gives you most of the raw machinery: custom subagents have their own context windows and system prompts, can have hooks, models, tools, memory, and worktree isolation; agent teams add inter-agent communication and a shared task list. ([Claude][1])

The missing thing is your **task/lifecycle layer**.

### The runtime model

I'd make the core data model roughly:

```ts
type Task = {
  id: string;

  // Durable
  state: TaskState;

  // Ephemeral
  workingMemory?: WorkingMemory;

  // Current operating mode
  role?: Role;

  lifecycle: LifecycleState;
};

type TaskState = {
  title: string;
  description: string;
  status: "active" | "blocked" | "complete";
  decisions: Decision[];
  artifacts: ArtifactRef[];
  unresolved: string[];
  handoff?: string;
};

type Role = {
  name: string;
  systemPrompt: string;
  tools?: ToolConfig;
  model?: Model;
  lifecycle: LifecycleDefinition;
};

type WorkingMemory = {
  threadId: string;
  providerSessionId: string;
};
```

The key is that **`WorkingMemory` is a replaceable pointer**, not the task itself.

So:

```text
Task
 ├── TaskState ─────────────── durable
 │
 └── WorkingMemory ─────────── disposable
          │
          └── Role ─────────── ephemeral
```

### Technologically, a task thread is basically a Claude session

For the first prototype, I wouldn't build a model runtime at all.

I'd use Claude Code's **Agent SDK / programmatic interface** to create and manage sessions. Claude's current subagent system already gives each subagent an independent context window and custom system prompt. ([Claude][1])

Your runtime becomes the thing that says:

```text
createTask()
    ↓
spawn session
    ↓
role = engineer
    ↓
receive events
    ↓
/done
    ↓
switch role
    ↓
same session OR new session
```

The interesting operation is therefore:

```ts
switchRole(task, validator);
```

which conceptually means:

```text
existing task
     │
     ├── task state
     │
     └── existing working memory
               │
               ▼
        new system prompt
             Validator
```

Whether Claude Code exposes a clean primitive for **replacing the system prompt of an existing subagent session** is one of the first things I'd test. If it doesn't, your runtime may have to emulate role switching by starting a new invocation with reconstructed history—which would undermine one of your central hypotheses.

That's probably the first technical spike I'd do.

### `/done` is just an event

You don't need some elaborate agent protocol initially.

The role prompt says:

```text
When your implementation is ready for validation,
emit exactly:

/done
```

Your orchestrator watches the model's output stream for that event.

Then:

```ts
switch (event.type) {
  case "done":
    await foreman.decide(task);
    break;

  case "pass":
    await complete(task);
    break;

  case "fail":
    await assign(task, "engineer");
    break;

  case "checkpoint":
    await checkpoint(task);
    break;
}
```

The important part is that **a normal model completion isn't an event**.

A stop hook should not mean anything semantically.

### The Foreman is another persistent session

This is the part that makes the architecture nice.

You have:

```text
Director session
        │
        ▼
   Foreman session
        │
        ├── Task 1
        ├── Task 2
        └── Task 3
```

The foreman gets **task metadata**, not the full task working memories.

So its prompt might periodically receive:

```json
{
  "tasks": [
    {
      "id": "17",
      "role": "engineer",
      "working_memory_tokens": 142000,
      "state": "done",
      "tests": "passing",
      "unresolved": 1
    }
  ]
}
```

Then it decides:

```text
reuse
fork
checkpoint
recycle
close
escalate
```

This is where your "how does it know whether to wipe?" question becomes an actual programmable interface rather than an abstract problem.

### Task state should live outside Claude

I'd make the durable state boring.

Probably:

```text
.claude/
  orchestration/
    tasks/
      17/
        task.json
        handoff.md
        adr/
          001-cache-strategy.md
        artifacts/
```

Or a SQLite database if you want proper querying.

The critical point is that **Claude's conversation history isn't your database**.

That's what makes `/clear` safe.

```text
Task state
    │
    ├── ADRs
    ├── handoff
    ├── status
    ├── decisions
    └── artifacts

Working memory
    │
    └── Claude session
```

Kill the session and the task still exists.

### Forking is particularly easy conceptually

When the foreman wants independent judgment:

```text
task.state
    │
    ├───────────────┐
    ▼               ▼
session A        session B
Engineer         Validator
```

Both sessions get a generated prompt containing the relevant task state.

This is actually where Claude's existing **forking/subagent machinery** may be useful, because Claude Code explicitly supports separate contexts and also has conversation forks. ([Claude][1])

### Teams become optional

This is the part I'd test rather than decide architecturally up front.

Claude Code's agent teams are specifically designed for agents that communicate with one another, whereas ordinary subagents are independent contexts that return results to their parent. ([Claude][1])

Your runtime could therefore initially be:

```text
Foreman
   │
   ├── Claude subagent/session
   ├── Claude subagent/session
   └── Claude subagent/session
```

and only use actual Claude **teams** when you discover a task where direct peer communication is useful.

In other words:

> **Team is a possible execution topology, not the fundamental data model.**

### The first prototype could be surprisingly small

I'd build only five things:

```text
1. Task registry
2. Task → Claude session mapping
3. Role definitions
4. Lifecycle event parser
5. Foreman dashboard
```

And four operations:

```text
spawn(task, role)
switch(task, role)
fork(task, role)
recycle(task)
```

Everything else can initially be Claude Code conventions.

The really important experiment isn't whether you can make this work. **You obviously can.**

It's whether the model actually makes good decisions about:

> **reuse working memory vs. fork vs. recycle**

without the system becoming more cumbersome than your current handoff + `/clear` workflow.

That's the part I'd treat as the research question.

[1]: https://code.claude.com/docs/en/sub-agents "Create custom subagents - Claude Code Docs"
