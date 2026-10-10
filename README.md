# pi-sop

SOP library for pi coding agents — **git-synced, machine-shared, agent-discoverable**.

Every pi session re-explores the same workflows: deploy steps, incident fixes,
project quirks. pi-sop turns them into a shared SOP library that all your
agents (across all your machines) read automatically and write back through git.

## How it works

```
~/sop-library/            ← your private git repo (single source of truth)
├── MANIFEST.md           ← human/agent readable index
└── sop/
    └── <name>.md         ← each SOP: frontmatter (name, description,
                             triggers, last_verified) + body

~/.pi/agent/extensions/   ← this extension (installed on every machine)
```

The extension provides four things:

| Capability | Mechanism |
|---|---|
| **Auto sync** | `session_start` runs `git pull --rebase` (best-effort, offline-safe); on a new machine it can clone the configured repo in the background |
| **SOP → skills** | `resources_discover` registers `sop/` as a skill path; agents load SOPs by task relevance, no reminder needed |
| **Write back** | `sop_save` tool: agent writes an SOP, updates MANIFEST, commits & pushes |
| **Lookup** | `/sop <keyword>` command: grep the library for humans |

## SOP format

```markdown
---
name: deploy-mysql-replica
description: USE FOR deploying MySQL replicas, setting up replication, GTID config
triggers: mysql replica, 主从, GTID
last_verified: 2026-09-21
---

# Deploy MySQL replica

1. ...
```

## Install

```bash
# from npm
pi install npm:pi-sop

# or from git
pi install git:github.com/zzjcool/pi-sop
```

Create or clone your SOP library on the first machine (or use `/sop init`). Its git remote is saved as the machine-independent `repo` setting. On other machines, if the configured `libDir` does not exist, pi-sop falls back to `~/sop-library` and automatically clones `repo` there in the background; the current session is never blocked and the new skills take effect on the next session.

```bash
git clone git@github.com:<you>/sop-library.git ~/sop-library
```

## Design rules (baked into the extension)

- Agents **create new** SOPs freely; **revising others' SOPs** produces a commit
  you review — never force-push, never rewrite history.
- All git operations are best-effort: offline machines degrade to read-only
  local cache, never blocking session start. Automatic clone is attempted once
  per process only when the library path is missing; it never overwrites an
  existing or empty directory and never scaffolds a malformed clone.
- `~/.pi/agent/pi-sop.json` keeps machine-private `libDir` separate from the
  machine-independent `repo` Git remote. A dead `libDir` from another machine is
  bypassed in favor of the local default; a usable library's origin can fill in
  a missing `repo` setting automatically.
- `last_verified` frontmatter lets agents (and you) spot stale SOPs.

## Status

- [x] Project scaffold
- [x] Core extension (sync / skills / sop_save / /sop)
- [x] Multi-machine field test (rebase/conflict/autoInit flows verified end-to-end)
- [x] npm publish

MIT © zzjcool
