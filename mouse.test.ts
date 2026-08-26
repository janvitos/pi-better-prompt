import assert from "node:assert/strict";
import test from "node:test";
import {
	installPromptMouse,
	setActiveMouseEditor,
} from "./mouse.ts";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const CURSOR_MARKER = "\x1b_pi:c\x07";

class FakeEditor {
	state = { lines: [""], cursorLine: 0, cursorCol: 0 };
	lastWidth = 20;
	scrollOffset = 0;
	paddingX = 2;
	preferredVisualCol: number | null = 8;
	snappedFromCursorCol: number | null = 8;
	lastAction: unknown = "type-word";
	cancelled = 0;
	exited = 0;
	visualLines?: Array<{ logicalLine: number; startCol: number; length: number }>;

	render(): string[] { return []; }
	invalidate(): void {}
	handleInput(): void {}
	getText(): string { return this.state.lines.join("\n"); }
	setText(text: string): void {
		this.state.lines = text.split("\n");
		this.state.cursorLine = this.state.lines.length - 1;
		this.state.cursorCol = this.state.lines.at(-1)?.length ?? 0;
	}
	buildVisualLineMap(): Array<{ logicalLine: number; startCol: number; length: number }> {
		return this.visualLines ?? this.state.lines.map((line, logicalLine) => ({
			logicalLine,
			startCol: 0,
			length: line.length,
		}));
	}
	segment(text: string): Iterable<Intl.SegmentData> { return segmenter.segment(text); }
	cancelAutocomplete(): void { this.cancelled++; }
	exitHistoryBrowsing(): void { this.exited++; }
}

function fixture(editor: FakeEditor) {
	const fallback: unknown[] = [];
	const prototype = {
		handleSelectionMouseEvent(event: unknown) { fallback.push(event); },
	};
	const box = {
		component: { children: [editor] },
		rect: { x: 5, y: 10, width: 20, height: 6 },
		clip: { x: 5, y: 10, width: 20, height: 6 },
		children: [],
		lines: undefined as readonly string[] | undefined,
	};
	const receiver = Object.assign(Object.create(prototype) as typeof prototype, {
		currentLayout: {
			root: {
				component: {},
				rect: { x: 0, y: 0, width: 80, height: 30 },
				clip: { x: 0, y: 0, width: 80, height: 30 },
				children: [box],
			},
		},
		terminal: { rows: 30 },
		hasOverlay: (): boolean => false,
	});
	const tuiReference = new Proxy({} as typeof receiver, {
		get: (_target, property) => {
			const value = Reflect.get(receiver, property, receiver);
			return typeof value === "function" ? (...args: unknown[]) => Reflect.apply(value, receiver, args) : value;
		},
		set: (_target, property, value) => Reflect.set(receiver, property, value, receiver),
		getPrototypeOf: () => Reflect.getPrototypeOf(receiver),
	});
	return { prototype, receiver, tuiReference, box, fallback };
}

const width = (text: string): number => text === "😀" ? 2 : [...text].length;

test("moves the active padded custom editor caret and preserves Pi mouse handling", () => {
	const editor = new FakeEditor();
	editor.setText("abcdef");
	const current = fixture(editor);
	let cleared = 0;
	setActiveMouseEditor({ component: editor, clearSelection: () => { cleared++; } });
	const original = current.prototype.handleSelectionMouseEvent;
	const installed = installPromptMouse(current.tuiReference, { cursorMarker: CURSOR_MARKER, visibleWidth: width });

	current.receiver.handleSelectionMouseEvent({ button: 0, x: 9, y: 11, release: false });
	assert.deepEqual({ line: editor.state.cursorLine, col: editor.state.cursorCol }, { line: 0, col: 2 });
	assert.equal(cleared, 1);
	assert.equal(editor.cancelled, 1);
	assert.equal(editor.exited, 1);
	assert.equal(editor.preferredVisualCol, null);
	assert.equal(editor.snappedFromCursorCol, null);
	assert.equal(current.fallback.length, 1);

	installed.dispose();
	assert.equal(current.prototype.handleSelectionMouseEvent, original);
	setActiveMouseEditor(undefined);
});

test("finds text rows inside pi-plan-build-style custom editor chrome", () => {
	const editor = new FakeEditor();
	editor.setText("abcdef");
	const current = fixture(editor);
	current.box.rect.height = 8;
	current.box.clip.height = 8;
	current.box.lines = [
		"────────────────────",
		"│                   │",
		`│ abcdef${CURSOR_MARKER}            │`,
		"│                   │",
		"metadata             │",
		"╰───────────────────╯",
		"",
	];
	setActiveMouseEditor({ component: editor, clearSelection() {} });
	installPromptMouse(current.tuiReference, { cursorMarker: CURSOR_MARKER, visibleWidth: width });

	current.receiver.handleSelectionMouseEvent({ button: 0, x: 9, y: 12, release: false });
	assert.deepEqual({ line: editor.state.cursorLine, col: editor.state.cursorCol }, { line: 0, col: 2 });
	setActiveMouseEditor(undefined);
});

test("maps wrapped, scrolled, and wide-character prompt clicks", () => {
	const editor = new FakeEditor();
	editor.setText("abcde\na😀b");
	editor.visualLines = [
		{ logicalLine: 0, startCol: 0, length: 3 },
		{ logicalLine: 0, startCol: 3, length: 2 },
		{ logicalLine: 1, startCol: 0, length: 4 },
	];
	editor.scrollOffset = 1;
	const current = fixture(editor);
	setActiveMouseEditor({ component: editor, clearSelection() {} });
	installPromptMouse(current.tuiReference, { cursorMarker: CURSOR_MARKER, visibleWidth: width });

	current.receiver.handleSelectionMouseEvent({ button: 0, x: 8, y: 12, release: false });
	assert.deepEqual({ line: editor.state.cursorLine, col: editor.state.cursorCol }, { line: 1, col: 1 });
	setActiveMouseEditor(undefined);
});

test("ignores borders, overlays, other buttons, and clicks outside the editor", () => {
	const editor = new FakeEditor();
	editor.setText("prompt");
	const current = fixture(editor);
	let cleared = 0;
	setActiveMouseEditor({ component: editor, clearSelection: () => { cleared++; } });
	installPromptMouse(current.tuiReference, { cursorMarker: CURSOR_MARKER, visibleWidth: width });

	current.receiver.handleSelectionMouseEvent({ button: 0, x: 9, y: 10, release: false });
	current.receiver.handleSelectionMouseEvent({ button: 2, x: 9, y: 11, release: false });
	current.receiver.handleSelectionMouseEvent({ button: 0, x: 1, y: 1, release: false });
	current.receiver.hasOverlay = () => true;
	current.receiver.handleSelectionMouseEvent({ button: 0, x: 9, y: 11, release: false });
	assert.equal(cleared, 0);
	assert.equal(editor.state.cursorCol, 6);
	assert.equal(current.fallback.length, 4);
	setActiveMouseEditor(undefined);
});
