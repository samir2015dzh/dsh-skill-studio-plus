<div align="center">

  # DSH Skill Studio

  **Auto-distill every turn · Semantic merge · DSH-native models**

  [简体中文](README.zh-CN.md) · [Features](#features) · [How merging works](#how-merging-works) · [Installation](#installation) · [Fork notes](FORK-NOTES.md)

  ![License](https://img.shields.io/badge/License-MIT-blue.svg)
  ![DSH](https://img.shields.io/badge/DSH-Plugin-0f766e.svg)
  ![Fork](https://img.shields.io/badge/Fork-zhengjy01%2Fdsh--skill--studio-6b7280.svg)
  ![Version](https://img.shields.io/badge/Version-0.4.0-2563eb.svg)
</div>

> A community fork of [zhengjy01/dsh-skill-studio](https://github.com/zhengjy01/dsh-skill-studio). Not an official DeepSeek AI product. Upstream provides skill browsing, editing, and manual extraction; this fork adds the four things unattended use needs: per-turn judgement, auto-accept, semantic merging, and models that follow DSH.

## Features

Leave it running. It decides what this turn taught, which existing skill it belongs to, and whether merging would create duplicates.

- **Per-turn worth-check**: three seconds after a turn ends, it sends a tiny YES/NO prompt (10 digests from the most recent session). Only YES triggers a full extraction. Judgement is throttled to 90s, extraction to 5 minutes.
- **Straight into the library**: accepted candidates are written to `~/.agents/skills` and load on the next turn. The review queue only fills up when a write fails (name collision and similar).
- **Merge instead of piling up files**: each candidate is compared against the whole library. Only genuinely new topics create a new skill. Real-world check: the same workflow re-worded scores just 0.07–0.24 on token similarity, so local similarity only pre-filters — the model sees the full catalog and decides.
- **Models come from DSH**: the panel offers a dropdown of providers/models configured in DSH; leave it empty to follow whichever session triggered the run. The plugin stores no API key and asks for no gateway URL.
- **"Recently added" in the panel**: the Skill Studio panel lists recently touched skills with name, description, and timestamp.
- **Clean writes**: duplicated sections are truncated, protocol residue like `MERGE:` is stripped, and any "merge" that loses a large chunk of the original is rejected.

## How merging works

A candidate passes four gates before it lands. Any gate that says no turns it into a new skill (or drops it, per rule).

```
new candidate
  │
  ├─ ① Tombstone: this name was merged away before (scan of ~/.dsh/skill-archive*/)
  │     → force-merge into the same-category skill with the largest body;
  │       if that fails, drop it — never write a duplicate again
  │
  ├─ ② Category tags: catalog reads "- [decompile] name: description"
  │     → the model sees the category before the prose
  │
  ├─ ③ Local re-check: a FOLD_INTO verdict is verified once more
  │     → same category: accept; cross-category: require similarity ≥ 0.5, else SAVE
  │
  └─ ④ The merge itself: model folds new experience into existing sections
        → duplicate sections truncated, protocol residue stripped,
          a result shorter than 60% of the original is refused
```

Categories are derived from the skill name (`gui-*` → gui, `decompiled-*` / `java-decompile-*` → decompile, `portable-*` / `offline-*` → portable, …). `CATEGORY_ALIASES` lives in `lib/extractor.js`; one line extends it.

## Installation

The plugin is installed into the DSH profile with a `link:`, so code edits need no republish.

1. Clone anywhere:

```bash
git clone <this-repo> D:/dsh-plugins/dsh-skill-studio
```

2. Register it in the profile `package.json`:

```json
{
  "dependencies": { "dsh-skill-studio": "link:D:/dsh-plugins/dsh-skill-studio" },
  "dsh": { "profile": { "bundles": ["dsh-skill-studio"] } }
}
```

3. Junction it into `node_modules`:

```powershell
New-Item -ItemType Junction `
  -Path "$env:DSH_PROFILE_DIR\node_modules\dsh-skill-studio" `
  -Target "D:\dsh-plugins\dsh-skill-studio"
```

4. Restart DSH and open **Settings → Skill Studio**.

## Configuration

Config file: `~/.dsh/dsh-skill-studio/extractor.json` (mode 0600).

```json
{
  "enabled": true,
  "autoPerTurn": true,
  "intervalMinutes": 60,
  "windowDays": 7,
  "maxCandidatesPerRun": 3,
  "autoAccept": true,
  "mergeThreshold": 0.2,
  "skillLanguage": "auto",
  "agentSkillDir": "C:\\Users\\<you>\\.agents\\skills",
  "provider": "",
  "model": ""
}
```

| Key | Purpose |
| --- | --- |
| `autoPerTurn` | Run the YES/NO judgement at the end of every turn |
| `intervalMinutes` | Fallback sweep interval; `0` disables it and relies on per-turn only |
| `autoAccept` | Write straight into the library instead of the review queue |
| `mergeThreshold` | Local similarity pre-filter (the merge decision itself is the model's) |
| `skillLanguage` | `auto` / `zh` / `en`; code, commands, and paths are never translated |
| `provider` / `model` | Empty = follow the session; or pick one in the panel |

The legacy `llmBaseUrl` / `llmApiKey` / `llmModel` fields still work as an HTTP fallback for hosts without `ctx.llm`. Leave them empty in normal use.

## Tools

| Tool | Purpose |
| --- | --- |
| `skillmgr_list` | List every skill with source, state, and group |
| `skillmgr_get` | Read one skill in full |
| `skillmgr_save` | Write a whole SKILL.md back |
| `skillmgr_policy` | Toggle model/user invocation |
| `skillmgr_extract_run` | Run one extraction now |
| `skillmgr_extract_status` | Switches, interval, queue depth, last run |
| `skillmgr_extract_config` | Change configuration |
| `skillmgr_extract_list` / `_accept` / `_reject` | Work the queue (usually empty with auto-accept on) |

HTTP routes live under `/api/dsh-skill-studio/*` — that is what the panel talks to.

## Debugging

Every model response is dumped to:

```
~/.dsh/dsh-skill-studio/last-llm-raw.txt
```

When parsing fails, read that file first: truncated JSON, markdown fences, or an off-topic answer are immediately distinguishable.

Two regression scripts, neither touches the real library:

```bash
node scripts/e2e-preview.mjs    # extract → judge → merge → accept, 6 assertions
node scripts/e2e-tombstone.mjs  # tombstone beats the model's verdict (it says SAVE, then KEEP)
```

## Differences from upstream

The full list is in [FORK-NOTES.md](FORK-NOTES.md) (15 entries). Highlights:

1. Model calls go through `ctx.llm.prepareCall()`; no stored credentials
2. Per-turn YES/NO judgement, auto-accept into the library
3. Semantic merging: category tags, model verdict, local re-check, tombstones
4. Merge hygiene: dedupe, residue stripping, short-body rejection
5. Panel: "recently added" list and a model dropdown
6. Truncation salvage for extraction output, `maxTokens` raised to 8000

## License

MIT, same as upstream. Upstream copyright belongs to zhengjy01.
