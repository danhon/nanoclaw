---
name: add-project
description: Set up a project directory under ~/TARS/ that both TARS and the user can access. TARS can create new projects directly; this skill is only needed to link an existing directory from elsewhere on the Mac.
---

# Add Project Directory

TARS can create new projects directly from WhatsApp by making subdirectories under `/workspace/extra/TARS/` (which maps to `~/TARS/` on the Mac). No setup is needed for new projects.

This skill is only needed to **link an existing directory** from elsewhere on the Mac into `~/TARS/` so TARS can access it.

## Phase 1: Get details

Use AskUserQuestion to collect:
1. **Project name** — becomes `~/TARS/{name}`
2. **Existing path** — the absolute path to the directory on the Mac to link in

## Phase 2: Create symlink

```bash
ln -s /absolute/existing/path ~/TARS/{name}
```

Verify:
```bash
ls ~/TARS/{name}
```

## Phase 3: Confirm

Tell the user:

> **{name}** is now accessible to TARS at `/workspace/extra/TARS/{name}`.
>
> Tell TARS: "look at the files in `/workspace/extra/TARS/{name}`"

No restart needed — `~/TARS` is already mounted read-write into the container.

## Troubleshooting

**TARS can't see the files**: Verify the symlink is correct and the target exists:
```bash
ls -la ~/TARS/{name}
```
