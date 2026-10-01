# Pi Better Prompt

OpenCode-style global prompt history, familiar keyboard text editing, and simple activity statuses for the [Pi coding agent](https://github.com/earendil-works/pi).

Pi normally reconstructs Up/Down history from the active session. This extension instead keeps one text history shared across sessions and projects, so `/new` no longer leaves prompt navigation empty. It also adds selection, clipboard, undo, and redo shortcuts to Pi's main prompt editor, keeps submitted prompts visible in fullscreen mode, and replaces the generic working message with the agent's current activity.

## Policy

- Global across Pi sessions and working directories for the current user.
- Retains the newest **100** prompts.
- Trims surrounding whitespace and ignores empty prompts.
- Suppresses identical consecutive entries; the same prompt can appear again after a different entry.
- Persists interactive prompts before skill or prompt-template expansion.
- Persists submitted slash commands before Pi dispatches them, including built-in commands that bypass Pi's `input` event.
- Persists `!` and `!!` user shell commands.
- Uses oldest-to-newest seeding so Up retrieves the newest entry first.
- Skips malformed JSONL records and rewrites valid retained records on load.
- Uses a lock and atomic replacement to avoid lost updates between simultaneous Pi processes.

## Prompt editing

| Action | Behavior |
| --- | --- |
| `Shift+Left/Right` | Extend the selection by one grapheme |
| `Shift+Up/Down` | Extend across visual lines, including wrapped text |
| `Shift+Home/End` | Extend to the logical line start/end |
| `Left/Up` | Collapse to the start of the selection |
| `Right/Down` | Collapse to the end of the selection |
| `Escape` | Clear the selection without interrupting Pi |
| `Ctrl+A` | Select the entire prompt |
| `Ctrl+C` | Copy the selected prompt text |
| `Ctrl+X` | Cut the selected prompt text |
| `Ctrl+Z` | Undo a prompt edit; do nothing when no undo is available |
| `Ctrl+Shift+Z` | Redo an undone prompt edit |
| Primary click | Move the caret within prompt text in fullscreen mode |

Typing, pasting, inserting a newline, yanking, Backspace/Delete, and Pi's word/line deletion commands replace or remove the active range as expected. Replacement and cut are each a single undo unit. A new edit after undo clears redo history. Bare Enter retains Pi's normal submit behavior and does not delete selected text. `Ctrl+X` without a selection retains Pi's assistant-message copy action. While this extension is active, `Ctrl+Z` is reserved for prompt undo and never triggers Pi's suspend action.

Selection is grapheme-aware and supports Unicode, multiline prompts, and visual wrapping. Large collapsed-paste markers remain atomic; copying one copies its expanded contents.

Terminal support for modified navigation sequences varies. Modern terminals with the Kitty keyboard protocol work best; Pi also recognizes common legacy Shift+Arrow sequences.

When the prompt is submitted while the fullscreen transcript is scrolled up, the extension automatically returns the transcript to the bottom before Pi handles the submission. It observes actual editor submissions, so Enter combinations that insert a newline do not change transcript position. Regular terminal mode retains the terminal's native scrolling behavior.

Click-to-caret works only in Pi's fullscreen TUI. It supports Pi's active built-in or custom editor, including wrapped, scrolled, padded, multiline, and Unicode prompt text. Other clicks retain Pi's transcript selection, hyperlink, and scrollbar behavior. Because Pi does not expose component mouse events to extensions, this feature uses guarded fullscreen renderer internals adapted from [pi-starline](https://github.com/Andy8647/pi-starline); incompatible Pi versions safely leave it disabled.

## Activity status

While the agent is active, Pi's working row uses a compact one-word status:

- `Thinking...` while waiting for or processing model output
- `Searching...` while searching the web or project
- `Reading...` while reading files or web sources
- `Writing...` while writing or editing files
- `Running...` while executing shell commands
- `Responding...` while streaming response text
- `Working...` for unknown tools or mixed parallel operations

The status contains no filenames, queries, commands, or tool counts. Pi hides the working row normally when the agent becomes idle. Activity statuses are TUI-only.

## Requirements

- Pi 0.84.2 or newer
- Node.js 22.6 or newer
- TUI mode

## Install

```bash
pi install npm:@janvitos/pi-better-prompt
```

For local development:

```bash
pi -e /path/to/pi-better-prompt/index.ts
```

Restart Pi after installation, or run `/reload` in an existing session.

### Migrating from pi-prompt-history

Remove the old package before installing the renamed one:

```bash
pi remove npm:@janvitos/pi-prompt-history
pi install npm:@janvitos/pi-better-prompt
```

The existing `prompt-history.jsonl` storage path is intentionally unchanged, so saved prompt history carries over automatically.

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
pi -e /path/to/pi-plan-build/index.ts -e /path/to/pi-better-prompt/index.ts
pi -e /path/to/pi-better-prompt/index.ts -e /path/to/pi-plan-build/index.ts
```

The decorator preserves `pi-plan-build`'s mode badge and Tab behavior while adding selection and replacing session-derived history with global history. Selection is enabled for Pi's built-in `Editor`, `CustomEditor`, and subclasses that retain Pi's editor runtime shape. A non-standard third-party editor safely falls back to history-only behavior.

The extension can fully clear pre-seeded history from Pi's built-in editors. A third-party editor with a different private history implementation can receive global entries, but Pi currently exposes no public API with which to clear that editor's pre-existing entries.

**Residual limitation:** Pi's editor API is last-writer-wins rather than true middleware. An unusual extension that replaces the editor during or after `resources_discover`—instead of the documented `session_start` pattern—can still overwrite the decorated editor. Pi provides no notification with which to reapply the decorator. Deferring also recreates the selected editor once during startup/reload; Pi preserves its text, but private transient state such as cursor position or undo state may reset.

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
| Slash commands | Retained | Submitted slash commands are retained as text |

Pi handles built-in slash commands before its extension `input` event. This extension records submitted slash commands at the TUI editor boundary before dispatch; extension slash commands also pass through the normal input path and are deduplicated. Images are omitted because Pi's public editor-history API accepts text only.

## Non-TUI modes

The package installs editor behavior only in TUI mode. RPC-, JSON-, print-, and extension-injected prompts are not added to global history.

## Development

```bash
npm test
npm pack --dry-run
```

Tests cover corruption recovery, normalization, retention, duplicate handling, concurrent writers, stale locks, editor seeding, session-history suppression, custom editor preservation, activity transitions and parallel tools, selection ranges, fullscreen submit scrolling and click positioning, Unicode, cut/copy safety, undo/redo, paste markers, rendering, and cleanup.

## License

MIT
