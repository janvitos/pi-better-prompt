import assert from "node:assert/strict";
import test from "node:test";
import type { EditorComponent } from "@earendil-works/pi-tui";
import {
	comparePositions,
	extractRange,
	installPromptSelection,
	normalizeRange,
	type EditorConstructor,
	type SelectionDependencies,
} from "./selection.ts";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

class FakeEditor implements EditorComponent {
	state = { lines: [""], cursorLine: 0, cursorCol: 0 };
	lastWidth = 80;
	scrollOffset = 0;
	paddingX = 0;
	lastAction: unknown = null;
	preferredVisualCol: unknown = null;
	snappedFromCursorCol: unknown = null;
	pastes = new Map<number, string>();
	pasteCounter = 0;
	historyIndex = -1;
	historyDraft: unknown = null;
	undoStack: Array<{
		state: { lines: string[]; cursorLine: number; cursorCol: number };
		pastes: Map<number, string>;
		pasteCounter: number;
	}> = [];
	changes: string[] = [];
	handled: string[] = [];
	submissions: string[] = [];
	renders = 0;
	autocompleteCancelled = 0;
	tui = { requestRender: () => { this.renders++; } };
	onSubmit = (text: string) => { this.submissions.push(text); };
	onChange = (text: string) => { this.changes.push(text); };

	getText(): string { return this.state.lines.join("\n"); }
	setText(text: string): void {
		this.state.lines = text.split("\n");
		this.state.cursorLine = this.state.lines.length - 1;
		this.state.cursorCol = this.state.lines.at(-1)?.length ?? 0;
	}
	insertTextAtCursor(text: string): void {
		if (!text) return;
		this.pushUndoSnapshot();
		this.insert(text);
	}
	handleInput(data: string): void {
		if (data === "left") return this.moveCursor(0, -1);
		if (data === "right") return this.moveCursor(0, 1);
		if (data === "backspace") {
			if (this.state.cursorCol === 0) return;
			this.pushUndoSnapshot();
			const line = this.state.lines[this.state.cursorLine] ?? "";
			this.state.lines[this.state.cursorLine] = line.slice(0, this.state.cursorCol - 1) + line.slice(this.state.cursorCol);
			this.state.cursorCol--;
			this.onChange?.(this.getText());
			return;
		}
		if (data === "delete") {
			const line = this.state.lines[this.state.cursorLine] ?? "";
			if (this.state.cursorCol >= line.length) return;
			this.pushUndoSnapshot();
			this.state.lines[this.state.cursorLine] = line.slice(0, this.state.cursorCol) + line.slice(this.state.cursorCol + 1);
			this.onChange?.(this.getText());
			return;
		}
		if (data === "newline") {
			this.pushUndoSnapshot();
			return this.insert("\n");
		}
		if (data === "submit") {
			const text = this.getText();
			this.state = { lines: [""], cursorLine: 0, cursorCol: 0 };
			this.onChange?.("");
			this.onSubmit?.(text);
			return;
		}
		if (data === "yank") {
			this.pushUndoSnapshot();
			return this.insert("YANK");
		}
		if (data.startsWith("\x1b[200~") && data.endsWith("\x1b[201~")) {
			this.pushUndoSnapshot();
			return this.insert(data.slice(6, -6));
		}
		if (data.length === 1 && data.charCodeAt(0) >= 32) {
			this.pushUndoSnapshot();
			this.insert(data);
			return;
		}
		this.handled.push(data);
	}
	render(width: number): string[] {
		this.lastWidth = width;
		return ["─".repeat(width), ...this.state.lines, "─".repeat(width)];
	}
	invalidate(): void {}
	moveCursor(deltaLine: number, deltaCol: number): void {
		if (deltaLine) this.state.cursorLine = Math.max(0, Math.min(this.state.lines.length - 1, this.state.cursorLine + deltaLine));
		const line = this.state.lines[this.state.cursorLine] ?? "";
		if (deltaCol < 0 && this.state.cursorCol > 0) {
			const parts = [...segmenter.segment(line.slice(0, this.state.cursorCol))];
			this.state.cursorCol -= parts.at(-1)?.segment.length ?? 1;
		} else if (deltaCol > 0 && this.state.cursorCol < line.length) {
			this.state.cursorCol += [...segmenter.segment(line.slice(this.state.cursorCol))][0]?.segment.length ?? 1;
		}
		this.state.cursorCol = Math.min(this.state.cursorCol, line.length);
	}
	moveToLineStart(): void { this.state.cursorCol = 0; }
	moveToLineEnd(): void { this.state.cursorCol = (this.state.lines[this.state.cursorLine] ?? "").length; }
	buildVisualLineMap(): Array<{ logicalLine: number; startCol: number; length: number }> {
		return this.state.lines.map((line, logicalLine) => ({ logicalLine, startCol: 0, length: line.length }));
	}
	pushUndoSnapshot(): void {
		this.undoStack.push(structuredClone({
			state: this.state,
			pastes: this.pastes,
			pasteCounter: this.pasteCounter,
		}));
	}
	undo(): void {
		const value = this.undoStack.pop();
		if (!value) return;
		this.state = value.state;
		this.pastes = value.pastes;
		this.pasteCounter = value.pasteCounter;
		this.onChange?.(this.getText());
	}
	cancelAutocomplete(): void { this.autocompleteCancelled++; }
	exitHistoryBrowsing(): void { this.historyIndex = -1; this.historyDraft = null; }
	expandPasteMarkers(text: string): string {
		return text.replace(/\[paste #(\d+)( (\+\d+ lines|\d+ chars))?\]/g, (match, id) => this.pastes.get(Number(id)) ?? match);
	}

	private insert(text: string): void {
		const line = this.state.lines[this.state.cursorLine] ?? "";
		const before = line.slice(0, this.state.cursorCol);
		const after = line.slice(this.state.cursorCol);
		const inserted = text.split("\n");
		if (inserted.length === 1) {
			this.state.lines[this.state.cursorLine] = before + text + after;
			this.state.cursorCol += text.length;
		} else {
			this.state.lines.splice(this.state.cursorLine, 1, before + inserted[0], ...inserted.slice(1, -1), inserted.at(-1)! + after);
			this.state.cursorLine += inserted.length - 1;
			this.state.cursorCol = inserted.at(-1)!.length;
		}
		this.onChange?.(this.getText());
	}
}

const ACTIONS: Record<string, string> = {
	copy: "tui.input.copy",
	left: "tui.editor.cursorLeft",
	right: "tui.editor.cursorRight",
	up: "tui.editor.cursorUp",
	down: "tui.editor.cursorDown",
	backspace: "tui.editor.deleteCharBackward",
	delete: "tui.editor.deleteCharForward",
	newline: "tui.input.newLine",
	submit: "tui.input.submit",
	yank: "tui.editor.yank",
};

function dependencies(
	copied: string[],
	options: {
		copyText?: (text: string) => Promise<void>;
		onCopyError?: (error: unknown) => void;
	} = {},
): SelectionDependencies {
	return {
		baseEditor: FakeEditor as unknown as EditorConstructor,
		matchesKey: (data, key) => data === key,
		matchesAction: (data, action) => ACTIONS[data] === action,
		decodePrintable: (data) => data.length === 1 && data.charCodeAt(0) >= 32 ? data : undefined,
		visibleWidth: (text) => text.replace(/\x1b\[[0-9;]*m/g, "").length,
		sliceByColumn: (text, start, width) => text.slice(start, start + width),
		copyText: options.copyText ?? (async (text) => { copied.push(text); }),
		onCopyError: options.onCopyError ?? (() => undefined),
	};
}

test("normalizes and extracts forward, backward, multiline, and Unicode ranges", () => {
	assert.equal(comparePositions({ line: 0, col: 2 }, { line: 1, col: 0 }) < 0, true);
	assert.deepEqual(
		normalizeRange({ line: 1, col: 2 }, { line: 0, col: 1 }),
		{ start: { line: 0, col: 1 }, end: { line: 1, col: 2 } },
	);
	assert.equal(extractRange(["a😀b", "second"], { start: { line: 0, col: 1 }, end: { line: 1, col: 3 } }), "😀b\nsec");
});

test("Shift+Arrow selects graphemes, Ctrl+C copies, typing replaces, and undo is atomic", async () => {
	const copied: string[] = [];
	const editor = new FakeEditor();
	editor.setText("hello😀");
	const installed = installPromptSelection(editor, dependencies(copied));
	assert.equal(installed.supported, true);

	editor.handleInput("shift+left");
	editor.handleInput("shift+left");
	editor.handleInput("copy");
	await Promise.resolve();
	assert.deepEqual(copied, ["o😀"]);

	editor.handleInput("X");
	assert.equal(editor.getText(), "hellX");
	assert.equal(editor.undoStack.length, 1);
	editor.undo();
	assert.equal(editor.getText(), "hello😀");
	editor.handleInput("ctrl+shift+z");
	assert.equal(editor.getText(), "hellX");
});

test("selection deletion, directional collapse, Escape, newline, and submit follow editor conventions", () => {
	const editor = new FakeEditor();
	editor.setText("alpha");
	installPromptSelection(editor, dependencies([]));

	editor.handleInput("shift+home");
	editor.handleInput("right");
	assert.deepEqual(editor.state, { lines: ["alpha"], cursorLine: 0, cursorCol: 5 });
	editor.handleInput("shift+home");
	editor.handleInput("escape");
	editor.setText("alpha");
	editor.handleInput("backspace");
	assert.equal(editor.getText(), "alph");

	editor.setText("alpha");
	editor.handleInput("shift+home");
	editor.handleInput("newline");
	assert.equal(editor.getText(), "\n");
	editor.undo();
	assert.equal(editor.getText(), "alpha");

	editor.handleInput("shift+home");
	editor.handleInput("submit");
	assert.deepEqual(editor.submissions, ["alpha"]);
});

test("copy expands selected paste markers and replacement retains untouched markers", async () => {
	const copied: string[] = [];
	const editor = new FakeEditor();
	const first = "[paste #1 12 chars]";
	const second = "[paste #2 11 chars]";
	editor.setText(`${first} ${second}`);
	editor.pastes.set(1, "expanded one");
	editor.pastes.set(2, "expanded two");
	editor.state.cursorCol = first.length;
	installPromptSelection(editor, dependencies(copied));

	editor.handleInput("shift+home");
	editor.handleInput("copy");
	await Promise.resolve();
	assert.deepEqual(copied, ["expanded one"]);
	editor.handleInput("X");
	assert.equal(editor.getText(), `X ${second}`);
	assert.equal(editor.pastes.has(1), false);
	assert.equal(editor.pastes.get(2), "expanded two");
});

test("programmatic insertion replaces a selection atomically and setText clears it", async () => {
	const copied: string[] = [];
	const editor = new FakeEditor();
	editor.setText("alpha");
	installPromptSelection(editor, dependencies(copied));
	editor.handleInput("shift+home");
	editor.insertTextAtCursor?.("paste");
	assert.equal(editor.getText(), "paste");
	assert.equal(editor.undoStack.length, 1);
	editor.undo();
	assert.equal(editor.getText(), "alpha");

	editor.handleInput("shift+home");
	editor.setText("replacement");
	editor.handleInput("copy");
	await Promise.resolve();
	assert.deepEqual(copied, []);
});

test("Ctrl+A selects the full prompt and Ctrl+X cuts it as one undoable edit", async () => {
	const copied: string[] = [];
	const editor = new FakeEditor();
	editor.setText("first\nsecond😀");
	installPromptSelection(editor, dependencies(copied));

	editor.handleInput("ctrl+a");
	const rendered = editor.render(20);
	assert.match(rendered[1]!, /\x1b\[7mfirst\x1b\[27m/);
	assert.match(rendered[2]!, /\x1b\[7msecond😀\x1b\[27m/);
	editor.handleInput("ctrl+x");
	await Promise.resolve();
	assert.deepEqual(copied, ["first\nsecond😀"]);
	assert.equal(editor.getText(), "");
	assert.equal(editor.undoStack.length, 1);

	editor.handleInput("ctrl+z");
	assert.equal(editor.getText(), "first\nsecond😀");
	editor.handleInput("ctrl+shift+z");
	assert.equal(editor.getText(), "");
});

test("Ctrl+Z and Ctrl+Shift+Z support repeated undo/redo and invalidate redo on edits", () => {
	const editor = new FakeEditor();
	installPromptSelection(editor, dependencies([]));
	editor.handleInput("A");
	editor.handleInput("B");
	assert.equal(editor.getText(), "AB");

	editor.handleInput("ctrl+z");
	assert.equal(editor.getText(), "A");
	editor.handleInput("ctrl+z");
	assert.equal(editor.getText(), "");
	const handledAfterUndo = editor.handled.length;
	editor.handleInput("ctrl+z");
	assert.equal(editor.getText(), "");
	assert.equal(editor.handled.length, handledAfterUndo);
	editor.handleInput("ctrl+shift+z");
	assert.equal(editor.getText(), "A");
	editor.handleInput("ctrl+shift+z");
	assert.equal(editor.getText(), "AB");

	editor.handleInput("ctrl+z");
	editor.handleInput("X");
	assert.equal(editor.getText(), "AX");
	editor.handleInput("ctrl+shift+z");
	assert.equal(editor.getText(), "AX");
	assert.equal(editor.handled.at(-1), "ctrl+shift+z");
});

test("Ctrl+X preserves Pi fallthrough while Ctrl+Z is consumed without undo history", () => {
	const editor = new FakeEditor();
	editor.setText("prompt");
	installPromptSelection(editor, dependencies([]));
	editor.handleInput("ctrl+x");
	assert.equal(editor.getText(), "prompt");
	assert.equal(editor.handled.at(-1), "ctrl+x");

	editor.setText("");
	const handledBeforeUndo = editor.handled.length;
	editor.handleInput("ctrl+z");
	assert.equal(editor.handled.length, handledBeforeUndo);
});

test("cut preserves text on clipboard failure or stale asynchronous selection", async () => {
	const errors: unknown[] = [];
	const failed = new FakeEditor();
	failed.setText("keep me");
	installPromptSelection(failed, dependencies([], {
		copyText: async () => { throw new Error("clipboard unavailable"); },
		onCopyError: (error) => { errors.push(error); },
	}));
	failed.handleInput("ctrl+a");
	failed.handleInput("ctrl+x");
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(failed.getText(), "keep me");
	assert.equal(errors.length, 1);

	let resolveCopy: (() => void) | undefined;
	const stale = new FakeEditor();
	stale.setText("old text");
	installPromptSelection(stale, dependencies([], {
		copyText: () => new Promise<void>((resolve) => { resolveCopy = resolve; }),
	}));
	stale.handleInput("ctrl+a");
	stale.handleInput("ctrl+x");
	stale.handleInput("N");
	assert.equal(stale.getText(), "N");
	resolveCopy?.();
	await Promise.resolve();
	assert.equal(stale.getText(), "N");
});

test("cut expands paste markers and undo restores their registry", async () => {
	const copied: string[] = [];
	const editor = new FakeEditor();
	const marker = "[paste #1 12 chars]";
	editor.setText(marker);
	editor.pastes.set(1, "expanded one");
	editor.pasteCounter = 1;
	installPromptSelection(editor, dependencies(copied));
	editor.handleInput("ctrl+a");
	editor.handleInput("ctrl+x");
	await Promise.resolve();
	assert.deepEqual(copied, ["expanded one"]);
	assert.equal(editor.getText(), "");
	assert.equal(editor.pastes.size, 0);

	editor.handleInput("ctrl+z");
	assert.equal(editor.getText(), marker);
	assert.equal(editor.pastes.get(1), "expanded one");
	assert.equal(editor.pasteCounter, 1);
	editor.handleInput("ctrl+shift+z");
	assert.equal(editor.getText(), "");
	assert.equal(editor.pastes.size, 0);
});

test("render hook highlights registered editors and is reference-counted on dispose", () => {
	const first = new FakeEditor();
	const second = new FakeEditor();
	first.setText("first");
	second.setText("second");
	const firstUndo = first.undo;
	const firstInstalled = installPromptSelection(first, dependencies([]));
	const secondInstalled = installPromptSelection(second, dependencies([]));
	first.handleInput("shift+home");
	second.handleInput("shift+home");
	assert.match(first.render(10)[1]!, /\x1b\[7mfirst\x1b\[27m/);
	assert.match(second.render(10)[1]!, /\x1b\[7msecond\x1b\[27m/);

	firstInstalled.dispose();
	assert.equal(first.render(10)[1], "first");
	assert.equal(first.undo, firstUndo);
	assert.match(second.render(10)[1]!, /\x1b\[7msecond\x1b\[27m/);
	secondInstalled.dispose();
	secondInstalled.dispose();
	assert.equal(second.render(10)[1], "second");
});

test("unsupported editors degrade without patching input", () => {
	let handled = 0;
	const editor: EditorComponent = {
		getText: () => "",
		setText: () => undefined,
		handleInput: () => { handled++; },
		render: () => [],
		invalidate: () => undefined,
	};
	const installed = installPromptSelection(editor, dependencies([]));
	assert.equal(installed.supported, false);
	editor.handleInput("shift+left");
	assert.equal(handled, 1);
});
