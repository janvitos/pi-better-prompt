# Pi Global Prompt History

OpenCode-style global prompt history for the [Pi coding agent](https://github.com/earendil-works/pi).

Pi normally reconstructs Up/Down history from the active session. This extension instead keeps one text history shared across sessions and projects, so `/new` no longer leaves prompt navigation empty.

## Policy

- Global across Pi sessions and working directories for the current user.
- Retains the newest **100** prompts.
- Trims surrounding whitespace and ignores empty prompts.
- Suppresses identical consecutive entries; the same prompt can appear again after a different entry.
- Persists interactive prompts before skill or prompt-template expansion.
- Persists `!` and `!!` user shell commands.
- Uses oldest-to-newest seeding so Up retrieves the newest entry first.
- Skips malformed JSONL records and rewrites valid retained records on load.
- Uses a lock and atomic replacement to avoid lost updates between simultaneous Pi processes.

## Requirements

- Pi 0.84.1 or newer
- Node.js 22.6 or newer
- TUI mode

## Install

```bash
pi install npm:@janvitos/pi-prompt-history
```

For local development:

```bash
pi -e /path/to/pi-prompt-history/index.ts
```

Restart Pi after installation, or run `/reload` in an existing session.

## Storage

History is stored at:

```text
~/.pi/agent/prompt-history.jsonl
```

If `PI_CODING_AGENT_DIR` changes Pi's agent directory, the file follows that directory. Each line is a versioned JSON record:

```json
{"version":1,"input":"Review this implementation"}
```

The file is created with user-only permissions where supported. Its contents are sensitive: prompts from unrelated projects are intentionally collected in one place and can become visible through Up/Down navigation in any project.

To reset history, exit all Pi processes and remove the file and any abandoned lock:

```bash
rm -f ~/.pi/agent/prompt-history.jsonl ~/.pi/agent/prompt-history.jsonl.lock
```

## Custom editor compatibility

The extension loads history during `session_start`, then waits until Pi's subsequent `resources_discover` phase to decorate the editor factory selected by other extensions. This makes it load-order independent with conventional custom editors—including `@janvitos/pi-plan-build`, which configures its editor during `session_start`.

Both orders therefore work:

```bash
pi -e /path/to/pi-plan-build/index.ts -e /path/to/pi-prompt-history/index.ts
pi -e /path/to/pi-prompt-history/index.ts -e /path/to/pi-plan-build/index.ts
```

The history decorator preserves `pi-plan-build`'s mode badge and Tab behavior while replacing session-derived history with global history. It can fully clear pre-seeded history from Pi's built-in `Editor` and `CustomEditor`. A third-party editor with a different private history implementation can receive global entries, but Pi currently exposes no public API with which to clear that editor's pre-existing entries.

**Residual limitation:** Pi's editor API is last-writer-wins rather than true middleware. An unusual extension that replaces the editor during or after `resources_discover`—instead of the documented `session_start` pattern—can still overwrite the history-enabled editor. Pi provides no notification with which to reapply the decorator. Deferring also recreates the selected editor once during startup/reload; Pi preserves its text, but private transient state such as cursor position or undo state may reset.

## Differences from OpenCode

This extension follows OpenCode TUI's global-storage model, but intentionally adapts it to Pi:

| Behavior | OpenCode TUI | This extension |
|---|---|---|
| Scope | Global | Global |
| Retention | 50 | 100 |
| Format | Structured prompt and parts | Text only |
| Attachments | Restored | Not stored |
| Cleared drafts | Some are retained | Not retained |
| Shell input | Mode and parts retained | Canonical `!`/`!!` text |
| Slash commands | Retained | Built-in and extension commands are not retained |

Pi handles slash commands before its extension `input` event and does not expose a general submitted-command event. Images are also omitted because Pi's public editor-history API accepts text only.

## Non-TUI modes

The package installs editor behavior only in TUI mode. RPC-, JSON-, print-, and extension-injected prompts are not added to global history.

## Development

```bash
npm test
npm pack --dry-run
```

Tests cover corruption recovery, normalization, retention, duplicate handling, concurrent writers, stale locks, editor seeding, session-history suppression, and custom editor preservation.

## License

MIT
