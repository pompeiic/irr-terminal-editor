# Incursion Red River — Terminal Editor

Online editor for the in-game hacking terminals (`UIRRTerminalSetup` data assets). Companion to the in-engine
**Terminal Sync** (`UIRRTerminalSyncLibrary`, `IIRExtendedEditor` module): Unreal **exports** every terminal
asset into the JSON files in this repo, this page **edits** them, and Unreal **imports** them back onto the
assets. The game never reads this repo — changes ship with the next build.

- **Editor:** https://pompeiic.github.io/irr-terminal-editor/editor.html
- **Files:**
  - `Schema.json` — every class, struct, enum, tag and asset choice the forms are built from. Written by Unreal on
    every sync; never edit it by hand.
  - `Terminals/<AssetName>.json` — one per terminal asset (`DA_Terminal_IGC`, …).
  - `Workflow.json` — editor-owned edit history. Unreal never reads it.

## Workflow

1. **Unreal ↔ repo:** IRR menu → **Terminals → Sync**. It downloads this repo, imports web edits onto the
   assets (and saves them), exports every terminal plus the schema, and uploads the result. **Download + Import**
   only pulls. The repo is configured in Project Settings → IRR → Terminal Sync, the token in
   Editor Preferences → IRR → Terminal Sync (User) — left empty, the Item Sync (User) token is used.
2. **Edit here:**
   - **Files** — the folder tree. Add, rename (subfolders follow), move or delete folders (deleting removes
     the subtree), set entry requirements, and add, move, duplicate or delete files. Each file lists the
     commands it **answers** (`Responses`, keyed by command tag) with the conditions and sequences that
     play. The tag chip shows which keyword the player types, or turns red when no command answers it.
   - **Commands** — keyword, aliases, tag, argument (change directory, go back, file command, login, hack,
     or a Blueprint argument) and the success/fail sequences.
   - **Users** — login names and passwords; the first user is logged in at start.
   - **Settings** — everything else on the asset: presentation, boot and error sequences, timings, hacking.
   - **Console** — runs the terminal against the edited data the way the game does: commands, aliases, paths,
     requirements, file responses, login. Sequences print their text; widgets and mission events are only
     named. Toggles force folder requirements and file conditions to pass or fail.
   - **History** — commits made from this page.
   - The problem strip under the tabs runs the same checks as the asset's Data Validation in Unreal, plus a
     warning for tags the project does not define. **Validate all** checks every terminal.
   - **+ New terminal** starts blank or from a copy. It is created in Unreal (under the folder in
     `Schema.json` → `newTerminalFolder`) on the next sync, and can be renamed or deleted here until then.
3. **Changes → Commit** writes the changed terminal files and the history.

## Editing rules (enforced by the importer)

- **Existing terminals cannot be deleted or renamed here** — do that in Unreal. Removing a file from the repo
  does not delete the asset; the next sync writes it back.
- **Texts keep their localization key** when you edit them. New texts get a key on import. Copies (new
  terminal from a copy, duplicated files and commands) drop the keys, so they translate separately.
  String-table texts are read-only.
- **Drift guard:** every terminal carries a `sourceHash` of the asset at export. If the asset was edited in
  Unreal after that, the sync skips the import for that terminal (and doesn't overwrite your web edit on
  upload) instead of silently reverting one side. Force the import from Unreal, or redo the edit. Never touch
  `sourceHash`.
- The page commits against the file version it loaded. If Unreal synced in the meantime, the commit is refused
  — reload and redo the edit.
- Unknown tags and unknown fields are dropped on import (with a warning in the sync report). Unknown classes
  fail that terminal's import.
- `Command` (the Blueprint-resolved command object) and other Unreal-only state never appear here.

## One-time setup: your editor token

Same flow as the item editor. The **Commit** button needs a personal access token — stored **only in your
browser** (`irr_terminal_pat`), only able to touch this repo's files.

1. Be a **collaborator** on this repo (repo → Settings → Collaborators) and accept the invite.
2. github.com → avatar → **Settings** → **Developer settings** → **Personal access tokens** →
   **Tokens (classic)** → **Generate new token (classic)**.
3. Note: `terminal-editor` · Expiration: 1 year · Scopes: **`public_repo`** only.
4. Copy the `ghp_…` string, paste it into the editor's top-right field, click **Remember**.

The repo **owner** can use a fine-grained token instead (Only select repositories → this repo;
Permissions → Contents: Read and write).

Without a token the page still loads (through the GitHub API, 60 requests an hour), so you can edit and use the
console, but not commit.

## Rules

- Commit, then sync in Unreal soon after — the longer web edits sit unsynced, the more drift-guard conflicts
  you'll hit.
- The validation workflow only rejects malformed JSON, not broken terminals; use **Validate all**.
- Never hand-edit `schemaSoftVersion` / `schemaHardVersion`, `asset` or `sourceHash`.
