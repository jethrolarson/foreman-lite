# Chatgpt conversatin that led to this project

learning about agent teams https://code.claude.com/docs/en/sub-agents
agent-teams.md

Need to understand how to use them and when.

My basic vision. I have foreman agent do delegation and I use it for vision and orchestration so I'm staying operating at director level and it spawns child agents to complete tasks. I know I get most of that with subagents (not with teams) but the ui for subagents kind of sucks. There's warnings that agent teams use more tokens but it seems like if I'm kind of using them like subagents they'll have similar performance characteristics

Yeah. I think your mental model is basically right, with one important distinction:

You're not really choosing between "subagents" and "teams" based on whether the work is parallel. You're choosing based on whether the workers need to be persistent, addressable participants in the orchestration.

Anthropic's current model is roughly:

Subagent: "Go do this task and bring me the result."
Team: "You are now a member of this ongoing group of workers; you have a task list and can communicate with the other workers."
Lead: your director/foreman who decomposes and synthesizes.

And that maps unusually well onto what you're describing.

Your architecture

I'd picture yours as:

                    YOU
                     │
              vision / intent
                     │
                     ▼
               ┌──────────┐
               │ FOREMAN  │
               │          │
               │ planning │
               │ judgment │
               │ routing  │
               └────┬─────┘
                    │
          ┌─────────┼─────────┐
          ▼         ▼         ▼
       worker     worker     worker
       ──────     ──────     ──────
       implement  research   review
          │         │         │
          └─────────┼─────────┘
                    ▼
                FOREMAN
                 synthesis
                    │
                    ▼
                   YOU

That's hierarchical orchestration, rather than a genuinely collaborative team.

And you're right that ordinary subagents already give you most of the computational architecture.

The interesting reason to use teams in your case is the interface and persistence model.

The UI thing is actually meaningful

A normal subagent is essentially a function call:

Here's a task → disappear into another context → give me a result.

That's great computationally, but lousy if you're trying to operate at the director level.

A team gives you something more like an org chart you can inhabit.

You can have:

FOREMAN
├── architect
├── implementer
├── tester
└── reviewer

and actually inspect those workers, message them, see their state, and let them communicate. Claude's team architecture explicitly provides separate contexts, a shared task list, and a mailbox for agent-to-agent communication.

That's a different interaction model, even if much of the underlying work could have been done by subagents.

But there's a catch with your "same performance characteristics" idea

I'd phrase it as:

Similar worker economics, different coordination economics.

Suppose your foreman launches three independent workers:

Foreman
├── Worker A: investigate X
├── Worker B: implement Y
└── Worker C: test Z

If those are genuinely independent, the computational work is pretty similar whether they're subagents or teammates.

You're paying for:

3 × worker context

either way.

But teams introduce additional potential consumption:

worker contexts

- task coordination
- messages
- cross-agent context transfer
- potentially redundant investigation

Anthropic explicitly warns that teams use significantly more tokens because each teammate has its own context window.

So I wouldn't expect:

teams = subagents + UI

to be literally true in cost.

It's more like:

teams = subagents + an organizational communication substrate

And that substrate only pays for itself when you actually exploit it.

Where I think your idea gets particularly interesting

Your foreman doesn't necessarily need to do much.

You want to move yourself from:

"Claude, implement this feature."

toward:

"Here's the product direction. Figure out the work."

Then the foreman does:

interpret intent
↓
decompose
↓
assign
↓
monitor
↓
resolve conflicts
↓
synthesize
↓
present decision/results

That's much closer to a director/manager agent than a conventional coding agent.

And then the team UI becomes useful because you're effectively looking at the organization, rather than watching one agent recursively disappear into tasks.

The really important question becomes:

Does the foreman need its workers to talk to one another?

If no:

                 Foreman
                /   |   \
               A    B    C

Subagents are probably the cleaner abstraction.

If yes:

                 Foreman
                /   |   \
               A ↔ B ↔ C
                \  |  /
                 \ | /

Teams become substantially more interesting.

For example:

Architect discovers that the implementation plan conflicts with an existing abstraction.

Instead of:

Architect → Foreman → Implementer

you can have:

Architect → Implementer
↑ ↓
└── Reviewer

The workers can resolve some of that coordination without making the foreman the message router for every interaction. That's specifically one of the architectural differences Anthropic calls out.

There's another important distinction: persistent workers

This is probably the feature I'd pay the most attention to for your use case.

A subagent is naturally:

task-shaped

"Analyze this module."

A teammate can become:

role-shaped

"You are the frontend engineer on this project."

That's a profound difference for a director-level workflow.

You could conceptually have:

                 FOREMAN
                    │
       ┌────────────┼────────────┐
       │            │            │

ARCHITECT BUILDER CRITIC
│ │ │
└────────────┼────────────┘
│
FOREMAN

The architect isn't merely executing task 17. It can accumulate a working understanding of its domain and communicate that understanding.

That's where teams start looking less like parallel tool calls and more like an AI organization.

And I think there's a subtle danger in your model

If the foreman is doing all the communication:

A → Foreman → B
B → Foreman → A

you've recreated subagents with extra overhead.

The team should earn its keep by allowing:

A ↔ B
A ↔ C
B ↔ C

without requiring the foreman to mediate every interaction.

Otherwise the "team" is basically:

expensive subagents with a nicer dashboard.

Which may still be worthwhile for exactly the reason you identified—the UI changes how you operate the system—but it's important to distinguish that from the actual capability advantage.

So I'd use this decision rule
Situation Use
One isolated piece of work Subagent
Research → report back Subagent
Independent parallel tasks Subagents
Cheap specialist worker Subagent
Worker needs to remain addressable Team
Workers need to communicate Team
Shared evolving task graph Team
Multiple agents iteratively challenge each other Team
You want to supervise an organization Team
You want to stay at director/foreman level Team is very compelling

The last two are not really technical advantages. They're human-interface advantages.

And that seems particularly relevant to your vision: you're trying to make the scarce resource be your judgment, not your ability to sit there and shepherd an LLM through 47 implementation steps.

One correction to be aware of from the current docs: teammates don't inherit the lead's conversation history. They have independent contexts and communicate explicitly through messages/task state. That's actually pretty compatible with your director model: the foreman becomes the institutional memory and coordination layer, rather than everybody getting the whole meeting transcript.

Claude Code subagents documentation · Claude Code agent teams documentation

Yes. I think we were using context to mean at least three different things, which is probably why the architecture kept shifting underneath us.

I'd separate these:

Concept Meaning
Thread The conversation/process boundary.
Working memory The accumulated message/tool history available to the model.
Task state Durable information about the task: files, decisions, ADRs, handoff, status.
Role The currently active behavioral instruction.
Agent invocation One model execution under a particular role.

Then the architecture becomes cleaner:

DIRECTOR THREAD
│
└── FOREMAN
│
├── TASK A
│ ├── working memory
│ ├── durable task state
│ └── active role: Engineer
│
├── TASK B
│ ├── working memory
│ ├── durable task state
│ └── active role: Validator
│
└── TASK C
├── working memory
├── durable task state
└── active role: Researcher

And then /clear specifically means:

discard working memory while retaining task state.

That's much more precise than "discard context."

Likewise, the fresh-reviewer operation is:

create a new working-memory instance from the task's durable state.

Not "create a new context."

And role switching is:

change the active role over the same working memory.

That gives us three distinct transformations:

ROLE SWITCH
working memory ────────────────► same working memory
Engineer → Validator

FORK
task state ────────────────► new working memory
├──────────────► Reviewer
└──────────────► Engineer

RECYCLE
working memory ──checkpoint──► task state
│
└──────────────────────► discarded

I think working memory is the term we were reaching for whenever we said "context" in the token-cost / /clear discussion.

And task state is what we were reaching for when we talked about handoffs and ADRs.

That distinction is important enough that I'd revise the one-pager around it.

yes that works, and put the key in the doc too

Yes. I’d make that terminology explicit near the top, because otherwise “context” will inevitably creep back in and blur the architecture.

Task-Oriented Agent Teams with Ephemeral Roles
Thesis

Build an agent orchestration system where the task is the unit of work, not the agent or role.

The user operates at a director level through a persistent Director → Foreman thread. The foreman decomposes work into bounded tasks. Each task has durable state and a disposable working-memory history. Roles are activated within tasks as needed and do not persist independently.

The system combines the useful parts of subagents and agent teams with explicit lifecycle management.

Terminology

The word context is deliberately avoided because it conflates several distinct concepts.

Thread

A conversation/process boundary.

Examples:

Director thread
Task thread

A thread may have a long-lived conversation history, but that history is not necessarily permanent.

Working Memory

The accumulated model-visible conversation state for a task.

This includes:

messages
reasoning history
tool calls/results
conversational interaction
transient discoveries

Working memory is expensive and disposable.

/clear discards working memory.

Task State

The durable state describing what is known about a task.

This includes:

requirements
current status
decisions
ADRs
rejected alternatives
relevant files/artifacts
test results
unresolved questions
handoff information
agent memory (if enabled)

Task state survives working-memory destruction.

Role

The currently active behavioral instruction and capabilities assigned to a task.

Examples:

Engineer
Validator
Researcher
Architect

Roles are ephemeral. A role does not own persistent memory.

Agent Invocation

A model execution under a particular role with access to some working memory and task state.

An invocation may change the task's state, emit lifecycle events, or be discarded.

Foreman

The persistent orchestration role that manages tasks, roles, working-memory lifecycle, and escalation to the director.

Director

The persistent high-level interaction between the user and the foreman.

The director should operate primarily on goals, priorities, status, and decisions rather than implementation-level working memory.

Core Model
USER
│
DIRECTOR THREAD
user + foreman
│
task orchestration
│
┌───────────────┼───────────────┐
▼ ▼ ▼
TASK A TASK B TASK C
│ │ │
task state task state task state
│ │ │
working memory working memory working memory
│ │ │
Engineer Engineer Researcher
│ │ │
/done /done /done
│ │ │
Validator Validator Engineer

The important distinction is:

Task state is durable. Working memory is disposable. Roles are ephemeral.

Roles Are Modes, Not Agents

A role is a system prompt + capabilities temporarily assigned to a task.

For example:

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

The Engineer does not become a persistent Engineer agent.

The Validator does not maintain an independent identity.

The task owns the work; the role is simply the current operating mode.

This permits role switching without rebuilding working memory.

Three Working-Memory Operations
Reuse

Change the active role while retaining the same working memory.

working memory
│
├── Engineer
│
└── Validator

Use when accumulated reasoning is valuable.

Example:

Engineer implements → Validator reviews the implementation.

Fork

Create new working memory from durable task state.

             task state
                 │
        ┌────────┴────────┐
        ▼                 ▼

working memory A working memory B
Engineer Reviewer

Use when independent judgment is valuable.

The new worker gets the relevant task state, but does not inherit the entire conversational trajectory.

This deliberately trades rehydration cost for cognitive independence.

Forman decides on workflow step completion

Recycle

Checkpoint durable task state, then discard working memory.

working memory
│
│ checkpoint
▼
task state
│
└──────► working memory discarded

Use when the accumulated working memory is no longer worth its token/latency cost.

Recycle is a resource-management operation, not a synonym for task completion.

Task agent may /checkpoint
Foreman decides if wiping working memory at checkpoint or workflow step end.

Lifecycle Signals

Agents emit explicit semantic lifecycle events rather than relying on ordinary stop events.

Examples:

/done
/pass
/fail
/checkpoint

The meaning is role-specific.

Engineer:

/done = implementation is ready for validation

Validator:

/pass = implementation satisfies validation criteria
/fail = concrete problems remain

Ordinary conversation does not trigger lifecycle transitions.

If the user asks:

Why did you choose this abstraction?

the Engineer answers and continues.

A stop event after that answer is not a checkpoint.

Foreman Responsibilities

The foreman owns lifecycle decisions, not implementation reasoning.

It can inspect task metadata such as:

Task: caching refactor
Role: Engineer
Working memory: 142k tokens
Task state: 4k
State: /done
Tests: passing
Unresolved questions: 1

The foreman can decide:

continue the current role
switch roles
fork an independent worker
request checkpointing
recycle working memory
close the task
escalate to the director

The foreman does not need to load the entire working memory to make resource/lifecycle decisions.

Checkpointing

Checkpointing is semantic serialization, not generic summarization.

The active role should identify information that future work would otherwise have to rediscover:

Decision
Context / motivation
Alternatives considered
Rejected alternatives
Consequences
Current state
Unresolved questions

Lightweight Nygard-style ADRs are a preferred durable format because they preserve negative knowledge:

We chose X, and Y was considered but rejected because Z.

This prevents new working-memory instances from repeatedly rediscovering settled arguments.

The checkpoint question is:

If this working memory disappeared, what would a future agent desperately need to know?

not:

How do I summarize this conversation?

Validation

Validation is a first-class lifecycle transition.

The default path can reuse working memory:

Engineer → Validator

because the validator may benefit from understanding how the implementation was developed.

When independent judgment is valuable, the foreman can fork:

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

The system therefore treats continuity and independence as explicit choices.

(editor note: how will forman know when independent judgement is valuable?)

Director-Level UI

The director should primarily see task state and lifecycle, not internal model reasoning.

TASKS

● Auth refactor Engineer 143k waiting validation
● Cache redesign Validator 82k reviewing
● API cleanup — 0k complete
● UI migration Engineer 61k blocked

FOREMAN
4 active tasks
1 awaiting validation
1 blocked
1 ready to close

The director interacts with the foreman and intervenes when judgment or priority is required.

Implementation details remain inside task working memory.

Lifecycle Example
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
Design Principle

Don't make agents persistent. Make the things worth remembering persistent.

The system should optimize separately for:

working memory — continuity and local reasoning
task state — durable organizational knowledge
roles — temporary cognitive modes
threads — bounded conversational processes
foreman — lifecycle and coordination
director — goals, priorities, and judgment

The initial implementation should remain deliberately simple.

Explicit lifecycle signals plus foreman decisions are sufficient to test whether this architecture produces a better balance of:

context continuity
independent judgment
token cost
rehydration cost
context-window pressure
validation quality
director-level visibility

The terminology change makes the design substantially less ambiguous. In particular, working memory vs. task state gives you a clean vocabulary for discussing /clear, handoffs, forks, and persistence without accidentally treating them as the same operation.

good vision document. Now what is it technologically?

Technologically, I think this is not primarily an “agent team” implementation. It's a small orchestration runtime sitting on top of Claude Code's agent primitives.

Claude Code already gives you most of the raw machinery: custom subagents have their own context windows and system prompts, can have hooks, models, tools, memory, and worktree isolation; agent teams add inter-agent communication and a shared task list.

The missing thing is your task/lifecycle layer.

The runtime model

I'd make the core data model roughly:

type Task = {
id: string

// Durable
state: TaskState

// Ephemeral
workingMemory?: WorkingMemory

// Current operating mode
role?: Role

lifecycle: LifecycleState
}

type TaskState = {
title: string
description: string
status: "active" | "blocked" | "complete"
decisions: Decision[]
artifacts: ArtifactRef[]
unresolved: string[]
handoff?: string
}

type Role = {
name: string
systemPrompt: string
tools?: ToolConfig
model?: Model
lifecycle: LifecycleDefinition
}

type WorkingMemory = {
threadId: string
providerSessionId: string
}

The key is that WorkingMemory is a replaceable pointer, not the task itself.

So:

Task
├── TaskState ─────────────── durable
│
└── WorkingMemory ─────────── disposable
│
└── Role ─────────── ephemeral
Technologically, a task thread is basically a Claude session

For the first prototype, I wouldn't build a model runtime at all.

I'd use Claude Code's Agent SDK / programmatic interface to create and manage sessions. Claude's current subagent system already gives each subagent an independent context window and custom system prompt.

Your runtime becomes the thing that says:

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

The interesting operation is therefore:

switchRole(task, validator)

which conceptually means:

existing task
│
├── task state
│
└── existing working memory
│
▼
new system prompt
Validator

Whether Claude Code exposes a clean primitive for replacing the system prompt of an existing subagent session is one of the first things I'd test. If it doesn't, your runtime may have to emulate role switching by starting a new invocation with reconstructed history—which would undermine one of your central hypotheses.

That's probably the first technical spike I'd do.

/done is just an event

You don't need some elaborate agent protocol initially.

The role prompt says:

When your implementation is ready for validation,
emit exactly:

/done

Your orchestrator watches the model's output stream for that event.

Then:

switch (event.type) {
case "done":
await foreman.decide(task)
break

case "pass":
await complete(task)
break

case "fail":
await assign(task, "engineer")
break

case "checkpoint":
await checkpoint(task)
break
}

The important part is that a normal model completion isn't an event.

A stop hook should not mean anything semantically.

The Foreman is another persistent session

This is the part that makes the architecture nice.

You have:

Director session
│
▼
Foreman session
│
├── Task 1
├── Task 2
└── Task 3

The foreman gets task metadata, not the full task working memories.

So its prompt might periodically receive:

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

Then it decides:

reuse
fork
checkpoint
recycle
close
escalate

This is where your "how does it know whether to wipe?" question becomes an actual programmable interface rather than an abstract problem.

Task state should live outside Claude

I'd make the durable state boring.

Probably:

.claude/
orchestration/
tasks/
17/
task.json
handoff.md
adr/
001-cache-strategy.md
artifacts/

Or a SQLite database if you want proper querying.

The critical point is that Claude's conversation history isn't your database.

That's what makes /clear safe.

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

Kill the session and the task still exists.

Forking is particularly easy conceptually

When the foreman wants independent judgment:

task.state
│
├───────────────┐
▼ ▼
session A session B
Engineer Validator

Both sessions get a generated prompt containing the relevant task state.

This is actually where Claude's existing forking/subagent machinery may be useful, because Claude Code explicitly supports separate contexts and also has conversation forks.

Teams become optional

This is the part I'd test rather than decide architecturally up front.

Claude Code's agent teams are specifically designed for agents that communicate with one another, whereas ordinary subagents are independent contexts that return results to their parent.

Your runtime could therefore initially be:

Foreman
│
├── Claude subagent/session
├── Claude subagent/session
└── Claude subagent/session

and only use actual Claude teams when you discover a task where direct peer communication is useful.

In other words:

Team is a possible execution topology, not the fundamental data model.

The first prototype could be surprisingly small

I'd build only five things:

1. Task registry
2. Task → Claude session mapping
3. Role definitions
4. Lifecycle event parser
5. Foreman dashboard

And four operations:

spawn(task, role)
switch(task, role)
fork(task, role)
recycle(task)

Everything else can initially be Claude Code conventions.

The really important experiment isn't whether you can make this work. You obviously can.

It's whether the model actually makes good decisions about:

reuse working memory vs. fork vs. recycle

without the system becoming more cumbersome than your current handoff + /clear workflow.

That's the part I'd treat as the research question.
