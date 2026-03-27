# Orchestrator Memory System — Architecture Design

## Overview

A file-based, multi-layered memory system that persists learnings across workers and sessions. Workers inherit memory at spawn time and can write new memories mid-task. Memories are markdown files with YAML frontmatter, organized by scope (user, project, worker).

---

## The Problem

When a worker discovers something — "the correct SSH key is `~/.ssh/cluster_rsa`", "Adam optimizer was worse than SGD", "batch size >1024 OOMs on A100" — that knowledge dies with the worker. The next worker starts from scratch. There's no way to accumulate learnings across workers or sessions.

---

## Memory Layers

```
┌─────────────────────────────────────────────────────────────┐
│                     USER MEMORY (global)                     │
│  ~/.claude-orchestrator/memory/user/                         │
│                                                             │
│  SSH hosts, credentials info, environment details           │
│  Preferences (model choices, coding style)                  │
│  Cross-project knowledge                                    │
│                                                             │
│  Injected into EVERY worker regardless of project           │
└─────────────────────────────────────────────────────────────┘
        │
        │  inherits
        ▼
┌─────────────────────────────────────────────────────────────┐
│               PROJECT MEMORY (per project)                   │
│  ~/.claude-orchestrator/projects/<name>/memory/              │
│                                                             │
│  What worked, what didn't (experiments, approaches)         │
│  Architecture decisions with rationale                      │
│  Environment specifics (cluster paths, tools, configs)      │
│  Current state, blockers, goals                             │
│                                                             │
│  Injected into workers spawned with --project <name>        │
└─────────────────────────────────────────────────────────────┘
        │
        │  inherits
        ▼
┌─────────────────────────────────────────────────────────────┐
│                WORKER MEMORY (per worker)                     │
│  ~/.claude-orchestrator/workers/<name>/memory/               │
│                                                             │
│  Task-local notes, errors encountered                       │
│  Intermediate findings                                      │
│  EPHEMERAL — dies with worker unless promoted               │
│                                                             │
│  Written by the worker during its task                      │
└─────────────────────────────────────────────────────────────┘
        │
        │  selective promotion
        ▼
┌─────────────────────────────────────────────────────────────┐
│              CROSS-PROJECT PATTERNS (global)                  │
│  ~/.claude-orchestrator/memory/patterns/                     │
│                                                             │
│  Recurring patterns across projects                         │
│  "SSH to university clusters needs ProxyJump"               │
│  Manually curated or consolidated                           │
│                                                             │
│  Injected alongside user memory                             │
└─────────────────────────────────────────────────────────────┘
```

---

## Directory Layout

```
~/.claude-orchestrator/
├── memory/                              # Global memory
│   ├── user/                            # User-level memories
│   │   ├── _index.md                    # Auto-generated table of contents
│   │   ├── ssh-config.md                # "cluster.edu uses ~/.ssh/cluster_rsa"
│   │   ├── preferences.md               # "prefers sonnet for code, haiku for monitoring"
│   │   └── slurm-environment.md         # "SLURM cluster has A100s, uses sbatch"
│   └── patterns/                        # Cross-project patterns
│       ├── _index.md
│       └── ssh-proxy-pattern.md
│
├── projects/
│   ├── ml-training.json                 # EXISTING: project metadata (unchanged)
│   └── ml-training/                     # NEW: project directory
│       └── memory/
│           ├── _index.md
│           ├── optimizer-results.md      # "SGD > Adam for ResNet-50"
│           ├── batch-size-scaling.md     # "512 is the sweet spot"
│           ├── cluster-paths.md          # "scratch at /scratch/aarusha/"
│           └── cuda-oom-warning.md       # "batch >1024 OOMs on A100 40GB"
│
├── workers/
│   └── gpu-train-005/
│       ├── meta.json                    # EXISTING
│       ├── status                       # EXISTING
│       ├── inbox/                       # EXISTING
│       ├── outbox/                      # EXISTING
│       └── memory/                      # NEW: worker scratch memory
│           └── lr-schedule-finding.md   # Ephemeral, promote if valuable
│
└── config.json                          # EXISTING
```

---

## Memory File Format

Every memory file is markdown with YAML frontmatter:

```markdown
---
id: optimizer-comparison
title: SGD outperforms Adam for ResNet-50 on ImageNet
category: experiment-result
tags: [optimizer, sgd, adam, resnet-50]
created: 2026-03-27T19:05:03Z
updated: 2026-03-27T19:05:03Z
source: worker:gpu-train-002
confidence: high
---

## Finding

SGD with cosine annealing consistently outperforms Adam for ResNet-50.

## Evidence

- Run-002 (Adam, lr=0.001): 72.1% top-1
- Run-003 (SGD, lr=0.1, cosine): 74.2% top-1
- Run-005 (SGD, lr=0.1, cosine, batch 512): 76.8% top-1

## Implication

Use SGD with cosine annealing as the default optimizer.
```

### Frontmatter Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Unique slug, also the filename (without .md) |
| `title` | string | Yes | One-line summary for index listing |
| `category` | enum | Yes | See categories below |
| `tags` | string[] | No | Free-form tags for filtering |
| `created` | ISO 8601 | Yes | Creation timestamp |
| `updated` | ISO 8601 | Yes | Last modification timestamp |
| `source` | string | No | Origin: `user`, `worker:<name>`, `main-session`, `consolidation` |
| `confidence` | enum | No | `high`, `medium`, `low` |
| `supersedes` | string | No | ID of memory this replaces |
| `expires` | ISO 8601 | No | TTL for ephemeral facts |

### Categories

| Category | Use For | Examples |
|----------|---------|----------|
| `environment` | SSH hosts, paths, cluster details, tool configs | "cluster.edu uses sbatch not srun" |
| `experiment-result` | What was tried, what happened, metrics | "SGD > Adam, 76.8% vs 72.1%" |
| `decision` | Architectural/strategic choices with rationale | "Using ResNet-50 because..." |
| `preference` | User preferences for tools, style, workflow | "Prefers sonnet for code work" |
| `procedure` | How-to guides, deployment steps, workflows | "To submit a SLURM job: sbatch..." |
| `warning` | Pitfalls, things that break, known issues | "Batch >1024 OOMs on A100 40GB" |
| `reference` | Factual info, API docs, config values | "SLURM partition names: gpu, cpu" |

---

## The Index File (`_index.md`)

Each memory directory has an auto-generated `_index.md`. This is what gets injected into worker system prompts — compact, one-line-per-entry.

```markdown
# Memory: ml-training

## Experiment Results
- [optimizer-comparison](optimizer-comparison.md) — SGD outperforms Adam for ResNet-50
- [batch-size-scaling](batch-size-scaling.md) — Batch 512 best accuracy/speed tradeoff

## Environment
- [cluster-paths](cluster-paths.md) — Scratch dirs, checkpoints, data on cluster

## Decisions
- [optimizer-choice](optimizer-choice.md) — Using SGD with cosine annealing (not Adam)

## Warnings
- [cuda-oom](cuda-oom.md) — Batch >1024 OOMs on A100 40GB
```

A project with 50 memories produces an index of ~60-80 lines (~2KB). User + project combined stays under 200 lines — fits comfortably in a system prompt.

---

## How Memory Flows

### At Spawn Time (worker gets memory)

```
orch spawn gpu-train ~/ml "Train model" --project ml-training
       │
       ▼
  1. Read ~/.claude-orchestrator/memory/user/_index.md
  2. Read ~/.claude-orchestrator/projects/ml-training/memory/_index.md
  3. Read ~/.claude-orchestrator/memory/patterns/_index.md
  4. Inject all three into system prompt as template variables
  5. Worker sees compact indexes, can read full files on demand
       │
       ▼
  Worker system prompt includes:

  ## Memory
  ### User Memory (global)
  - [ssh-config](ssh-config.md) — cluster.edu uses ~/.ssh/cluster_rsa
  - [preferences](preferences.md) — prefers sonnet for code, haiku for monitoring

  ### Project Memory (ml-training)
  - [optimizer-comparison](optimizer-comparison.md) — SGD > Adam for ResNet-50
  - [batch-size-scaling](batch-size-scaling.md) — Batch 512 is sweet spot
  - [cuda-oom](cuda-oom.md) — Batch >1024 OOMs on A100 40GB
```

### During Work (worker writes memory)

```
  Worker discovers: "Learning rate warmup for 5 epochs prevents divergence"
       │
       ▼
  1. Worker creates file:
     ~/.claude-orchestrator/projects/ml-training/memory/lr-warmup.md
     (with YAML frontmatter + finding)

  2. Worker signals orchestrator:
     curl POST localhost:9111/memory
     {"worker":"gpu-train","action":"add","layer":"project","id":"lr-warmup","project":"ml-training"}

  3. HTTP handler rebuilds _index.md for ml-training project memory

  4. Next worker spawned in ml-training gets this memory in its index
```

### At Completion (memory review)

```
  Worker finishes, posts event:"done" to /notify
       │
       ▼
  HTTP handler checks: does workers/gpu-train/memory/ have files?
       │
       ├── No files → normal completion, no memory action
       │
       └── Has files → include in completion notification:
           "Worker gpu-train finished. 2 unpromoted memories found."
           Main session or user reviews and promotes selectively.
```

### Promotion (worker → project/user)

```
  orch memory promote gpu-train lr-warmup --to ml-training
       │
       ▼
  1. Copy workers/gpu-train/memory/lr-warmup.md
     → projects/ml-training/memory/lr-warmup.md
  2. Update source field: "worker:gpu-train → promoted:gpu-train"
  3. Rebuild projects/ml-training/memory/_index.md
  4. Notify: "Memory 'lr-warmup' promoted to ml-training"
```

---

## Deduplication

**Problem:** Two workers discover "SSH key is `~/.ssh/cluster_rsa`" and both write it.

**Solution:**
1. **Filename = ID.** If both write `ssh-key.md`, second overwrites first. Content is the same — harmless.
2. **`supersedes` field.** If a memory updates an older finding, set `supersedes: old-id`. Index rebuild marks old one as superseded.
3. **No automated dedup.** Semantic duplicates with different IDs are handled by human curation. In practice, workers run different tasks and rarely discover the same thing.

---

## Worker System Prompt Integration

Updated `templates/default.md` adds a Memory section:

```markdown
{{#if MEMORY_CONTEXT}}
## Memory

Persistent memory across sessions. Below are indexes of available memories.
Read full files when relevant: {{ORCH_HOME}}/memory/user/<id>.md or
{{ORCH_HOME}}/projects/{{PROJECT_NAME}}/memory/<id>.md

### User Memory
{{USER_MEMORY_INDEX}}

{{#if PROJECT_MEMORY_INDEX}}
### Project Memory ({{PROJECT_NAME}})
{{PROJECT_MEMORY_INDEX}}
{{/if}}

{{#if PATTERNS_MEMORY_INDEX}}
### Patterns
{{PATTERNS_MEMORY_INDEX}}
{{/if}}

### Writing Memories
When you discover something valuable, create a memory file:

For project learnings:
  {{ORCH_HOME}}/projects/{{PROJECT_NAME}}/memory/<id>.md

For your local notes:
  {{ORCH_HOME}}/workers/{{WORKER_NAME}}/memory/<id>.md

Format:
  ---
  id: <slug>
  title: <one-line summary>
  category: environment|experiment-result|decision|preference|procedure|warning|reference
  tags: [relevant, tags]
  created: <ISO 8601>
  source: worker:{{WORKER_NAME}}
  confidence: high|medium|low
  ---
  <detailed content>

After creating, signal the orchestrator:
  curl -sf -X POST http://localhost:{{CHANNEL_PORT}}/memory \
    -H "Content-Type: application/json" \
    -d '{"worker":"{{WORKER_NAME}}","action":"add","layer":"project","id":"<id>","project":"{{PROJECT_NAME}}"}'
{{/if}}
```

---

## CLI Commands

```
orch memory list [--user] [--project <name>] [--worker <name>] [--patterns]
  Show memory index for specified layer(s). Default: all.

orch memory show <layer>:<id>
  Show full memory file. E.g.: orch memory show project:ml-training:optimizer-comparison

orch memory rebuild [--user] [--project <name>] [--all]
  Rebuild _index.md files by scanning directories.

orch memory promote <worker-name> <id> --to <project-name|user>
  Copy memory from worker to project or user layer.

orch memory add <layer> <id> <title> --category <cat> [--tags tag1,tag2]
  Create a memory file interactively (opens editor or writes template).
```

---

## HTTP Endpoints

Added to the companion server (`channel/src/http.ts`):

```
POST /memory
{
  "worker": "gpu-train-005",
  "action": "add" | "update" | "promote",
  "layer": "project" | "worker" | "user",
  "id": "lr-warmup",
  "project": "ml-training"       // required if layer=project
}

Response: 200 OK + {"indexed": true}
```

---

## MCP Tools

Added to companion server (`channel/src/tools.ts`):

```
memory_status(layer, project?, worker?)
  → Returns the _index.md content for the specified layer
```

---

## Implementation Phases

### Phase 1: Format + Manual Memory
- Create directory structure
- Write index rebuild function in `bin/orch`
- Add `orch memory list`, `show`, `rebuild`, `add`
- Create a few seed memories by hand
- **Result:** You can manually manage memories. Workers can't read or write them yet.

### Phase 2: Spawn-Time Injection
- Modify `cmd_spawn` to read `_index.md` files
- Add `USER_MEMORY_INDEX`, `PROJECT_MEMORY_INDEX`, `PATTERNS_MEMORY_INDEX` template variables
- Update `templates/default.md` with memory section
- Auto-rebuild indexes at spawn time
- **Result:** Workers automatically get memory in their system prompt. Read-only.

### Phase 3: Worker Writes
- Add `/memory` HTTP endpoint
- Add memory-writing instructions to template
- Create `workers/<name>/memory/` at spawn time
- Index rebuild on write signal
- **Result:** Workers can create memories mid-task. Full read-write loop.

### Phase 4: Promotion + Completion
- Add `orch memory promote` command
- Add promotion logic to `/memory` endpoint
- On worker completion, check for unpromoted memories
- Add `memory_status` MCP tool
- **Result:** Full memory lifecycle.

### Phase 5: Discord + Patterns (polish)
- Memory queries from Discord
- Promotion commands from Discord
- Pattern extraction (manual/semi-automated)
- Memory consolidation tooling
- **Result:** Complete system.

---

## What Won't Change

These fundamentals are stable across all phases:

- **File format:** YAML frontmatter + markdown. New optional fields are non-breaking.
- **Directory layout:** `memory/user/`, `projects/<name>/memory/`, `workers/<name>/memory/`, `memory/patterns/`
- **Index pattern:** `_index.md` as auto-generated TOC, compact one-line-per-entry
- **Worker interaction:** Write files + POST signal. Same pattern as inbox/outbox.
- **Template variables:** `MEMORY_CONTEXT`, `USER_MEMORY_INDEX`, `PROJECT_MEMORY_INDEX`, `PATTERNS_MEMORY_INDEX`
- **Categories:** The 7 categories cover the space. New ones can be added without breaking.
- **ID = filename:** The id field matches the filename (minus .md). This is the dedup key.
