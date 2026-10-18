# Changelog

## 0.8.0 — the library is a directory, not a skill set

**Breaking.** SOPs are no longer registered as pi skills.

Registering `sop/` as a skill path meant every SOP contributed its name,
description and location to the system prompt on *every* request, so context
cost grew linearly with the library. That is the wrong shape for a knowledge
base meant to keep growing.

The library is now a plain directory that the agent browses:

- `sop_search` (new tool) finds SOPs by name / triggers / description / body and
  returns file paths.
- `read` opens the file.

Prompt cost is one tool description — constant, regardless of SOP count. In a
real measurement the skills block dropped from 16,203 to 6,898 characters (the
remainder belongs to other packages).

Removed along with the skill path:

- `skillMode` (`all` / `index` / `auto`) and the `before_agent_start` index
  injection — an intermediate design that did not take effect in a live session
- `lib/index-skill.ts`
- `include_hidden` / the `[已隐藏]` marker: with no skills there is nothing to
  hide, and a stale flag must never make a file unsearchable

### Also fixed

- **`sop_save` no longer destroys unknown frontmatter keys.** It used to rewrite
  a SOP from the four fields it models, silently dropping anything else —
  including fields a future pi version might rely on. Unknown keys now round-trip
  through `SopDoc.extra`.
- **Frontmatter is written through pi's own YAML parser, verify-then-quote.**
  An unquoted `description` containing `: ` (e.g. `GitHub: org/repo`,
  `pi: make run`) is invalid YAML. pi's skill loader treats that as "not a
  skill" and emits no diagnostic for root-level `.md` files, so such a SOP
  vanished silently: present in MANIFEST, findable by `/sop`, invisible to the
  agent. Values are now emitted plain, read back through pi's parser, and fall
  back to a JSON string literal unless the round trip is exact.
- `frontmatterIssue` / `scanSopDir` report such files as issues, surfaced by
  `session_start`, `/sop status` and `/sop init`.
- Boolean frontmatter values are emitted as bare tokens, not quoted strings.

### Upgrade notes

Nothing to do for existing libraries — the directory layout, MANIFEST format and
`pi-sop.json` schema are unchanged. A `disable-model-invocation` line in a SOP
now has no effect and may be deleted.

## 0.7.0 — index mode

Added `skillMode` to collapse the library into a single synthetic index skill.
Superseded by 0.8.0; never published.

## 0.6.0 — sop_search

Added the `sop_search` tool and preserved unknown frontmatter keys.

## 0.4.0 — machine-independent config

`repo` setting + background auto-clone, so a synced `pi-sop.json` no longer dies
on a machine where the absolute `libDir` does not exist.

## 0.3.0

Automatic resolution of SOP-area sync conflicts. Last version published to npm
before 0.8.0.

## 0.2.0

Project-scoped SOPs (`projects/<host>/<org>/<repo>/`) and multi-language
conventions.

## 0.1.0

Initial release: sync, skill registration, `sop_save`, `/sop`.
