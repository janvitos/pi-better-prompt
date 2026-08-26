import type { EditorComponent } from "@earendil-works/pi-tui";

export interface TextPosition {
	line: number;
	col: number;
}

export interface TextRange {
	start: TextPosition;
	end: TextPosition;
}

interface EditorState {
	lines: string[];
	cursorLine: number;
	cursorCol: number;
}

interface LayoutLine {
	logicalLine: number;
	startCol: number;
	length: number;
}

interface EditorSnapshot {
	state: EditorState;
	pastes: Map<number, string>;
	pasteCounter: number;
}

interface SelectableEditor extends EditorComponent {
	state: EditorState;
	lastWidth: number;
	scrollOffset: number;
	paddingX: number;
	lastAction: unknown;
	preferredVisualCol: unknown;
	snappedFromCursorCol: unknown;
	historyIndex?: number;
	historyDraft?: unknown;
	pastes: Map<number, string>;
	pasteCounter: number;
	undoStack: { readonly length: number };
	tui: { requestRender(): void };
	moveCursor(deltaLine: number, deltaCol: number): void;
	moveToLineStart(): void;
	moveToLineEnd(): void;
	buildVisualLineMap(width: number): LayoutLine[];
	pushUndoSnapshot(): void;
	undo(): void;
	cancelAutocomplete(): void;
	exitHistoryBrowsing(): void;
	expandPasteMarkers(text: string): string;
	insertTextAtCursor?(text: string): void;
}

export type EditorConstructor = new (...args: any[]) => EditorComponent;

export interface SelectionDependencies {
	baseEditor: EditorConstructor;
	matchesKey(data: string, key: string): boolean;
	matchesAction(data: string, action: string): boolean;
	decodePrintable(data: string): string | undefined;
	visibleWidth(text: string): number;
	sliceByColumn(text: string, start: number, width: number, strict?: boolean): string;
	copyText(text: string): Promise<void>;
	onCopyError(error: unknown): void;
}

export interface PromptSelection {
	supported: boolean;
	clear(): void;
	dispose(): void;
}

interface RenderRegistration {
	anchor?: TextPosition;
	deps: SelectionDependencies;
}

interface RenderHook {
	original: (this: EditorComponent, width: number) => string[];
	wrapped: (this: EditorComponent, width: number) => string[];
	registrations: WeakMap<object, RenderRegistration>;
	count: number;
}

const renderHooks = new WeakMap<object, RenderHook>();
const PASTE_MARKER = /\[paste #(\d+)( (\+\d+ lines|\d+ chars))?\]/g;
const DELETION_ACTIONS = [
	"tui.editor.deleteCharBackward",
	"tui.editor.deleteCharForward",
	"tui.editor.deleteWordBackward",
	"tui.editor.deleteWordForward",
	"tui.editor.deleteToLineStart",
	"tui.editor.deleteToLineEnd",
] as const;
const REPLACEMENT_ACTIONS = ["tui.input.newLine", "tui.editor.yank", "tui.editor.yankPop"] as const;

export function comparePositions(a: TextPosition, b: TextPosition): number {
	return a.line === b.line ? a.col - b.col : a.line - b.line;
}

export function normalizeRange(a: TextPosition, b: TextPosition): TextRange | undefined {
	if (comparePositions(a, b) === 0) return undefined;
	return comparePositions(a, b) < 0 ? { start: a, end: b } : { start: b, end: a };
}

export function extractRange(lines: readonly string[], range: TextRange): string {
	if (range.start.line === range.end.line) {
		return (lines[range.start.line] ?? "").slice(range.start.col, range.end.col);
	}
	return [
		(lines[range.start.line] ?? "").slice(range.start.col),
		...lines.slice(range.start.line + 1, range.end.line),
		(lines[range.end.line] ?? "").slice(0, range.end.col),
	].join("\n");
}

function position(editor: SelectableEditor): TextPosition {
	return { line: editor.state.cursorLine, col: editor.state.cursorCol };
}

function isSelectableEditor(editor: EditorComponent, deps: SelectionDependencies): editor is SelectableEditor {
	if (!(editor instanceof deps.baseEditor)) return false;
	const value = editor as Partial<SelectableEditor>;
	return Boolean(
		value.state &&
		Array.isArray(value.state.lines) &&
		typeof value.state.cursorLine === "number" &&
		typeof value.state.cursorCol === "number" &&
		typeof value.moveCursor === "function" &&
		typeof value.moveToLineStart === "function" &&
		typeof value.moveToLineEnd === "function" &&
		typeof value.buildVisualLineMap === "function" &&
		typeof value.pushUndoSnapshot === "function" &&
		typeof value.undo === "function" &&
		value.undoStack &&
		typeof value.undoStack.length === "number" &&
		value.pastes instanceof Map &&
		typeof value.pasteCounter === "number" &&
		typeof value.cancelAutocomplete === "function" &&
		typeof value.exitHistoryBrowsing === "function" &&
		typeof value.expandPasteMarkers === "function" &&
		value.tui &&
		typeof value.tui.requestRender === "function",
	);
}

function reverseVideo(text: string): string {
	const reasserted = text.replace(/\x1b\[[0-?]*[ -/]*m/g, (code) => `${code}\x1b[7m`);
	return `\x1b[7m${reasserted}\x1b[27m`;
}

function highlightSelection(
	editor: SelectableEditor,
	lines: string[],
	anchor: TextPosition | undefined,
	deps: SelectionDependencies,
): string[] {
	if (!anchor) return lines;
	const range = normalizeRange(anchor, position(editor));
	if (!range || lines.length < 3) return lines;

	const visualLines = editor.buildVisualLineMap(editor.lastWidth);
	const offset = Math.max(0, editor.scrollOffset);
	const bodyCount = Math.min(visualLines.length - offset, lines.length - 2);
	const result = [...lines];
	for (let bodyIndex = 0; bodyIndex < bodyCount; bodyIndex++) {
		const visual = visualLines[offset + bodyIndex];
		if (!visual || visual.logicalLine < range.start.line || visual.logicalLine > range.end.line) continue;
		const logicalText = editor.state.lines[visual.logicalLine] ?? "";
		const visualStart = visual.startCol;
		const visualEnd = visual.startCol + visual.length;
		const selectedStart = Math.max(visualStart, visual.logicalLine === range.start.line ? range.start.col : 0);
		const selectedEnd = Math.min(
			visualEnd,
			visual.logicalLine === range.end.line ? range.end.col : logicalText.length,
		);
		if (selectedEnd <= selectedStart) continue;

		const startColumn = editor.paddingX + deps.visibleWidth(logicalText.slice(visualStart, selectedStart));
		const selectedWidth = deps.visibleWidth(logicalText.slice(selectedStart, selectedEnd));
		if (selectedWidth <= 0) continue;
		const rendered = result[bodyIndex + 1] ?? "";
		const renderedWidth = deps.visibleWidth(rendered);
		const before = deps.sliceByColumn(rendered, 0, startColumn, true);
		const selected = deps.sliceByColumn(rendered, startColumn, selectedWidth, true);
		const after = deps.sliceByColumn(rendered, startColumn + selectedWidth, Math.max(0, renderedWidth - startColumn - selectedWidth), true);
		result[bodyIndex + 1] = `${before}${reverseVideo(selected)}${after}`;
	}
	return result;
}

function registerRenderHook(
	editor: SelectableEditor,
	registration: RenderRegistration,
	deps: SelectionDependencies,
): () => void {
	const prototype = deps.baseEditor.prototype as EditorComponent & { render: (width: number) => string[] };
	let hook = renderHooks.get(prototype);
	if (!hook) {
		const original = prototype.render;
		const registrations = new WeakMap<object, RenderRegistration>();
		const wrapped = function (this: EditorComponent, width: number): string[] {
			const rendered = original.call(this, width);
			const current = registrations.get(this);
			return current && isSelectableEditor(this, current.deps)
				? highlightSelection(this, rendered, current.anchor, current.deps)
				: rendered;
		};
		hook = { original, wrapped, registrations, count: 0 };
		prototype.render = wrapped;
		renderHooks.set(prototype, hook);
	}
	hook.registrations.set(editor, registration);
	hook.count++;
	let active = true;
	return () => {
		if (!active) return;
		active = false;
		hook!.registrations.delete(editor);
		hook!.count--;
		if (hook!.count === 0) {
			if (prototype.render === hook!.wrapped) prototype.render = hook!.original;
			renderHooks.delete(prototype);
		}
	};
}

function captureSnapshot(editor: SelectableEditor): EditorSnapshot {
	return structuredClone({
		state: editor.state,
		pastes: editor.pastes,
		pasteCounter: editor.pasteCounter,
	});
}

function restoreSnapshot(editor: SelectableEditor, snapshot: EditorSnapshot): void {
	Object.assign(editor.state, snapshot.state);
	editor.pastes = snapshot.pastes;
	editor.pasteCounter = snapshot.pasteCounter;
	editor.lastAction = null;
	editor.preferredVisualCol = null;
	editor.snappedFromCursorCol = null;
	editor.cancelAutocomplete();
	editor.exitHistoryBrowsing();
	editor.onChange?.(editor.getText());
	editor.tui.requestRender();
}

function sameRange(a: TextRange | undefined, b: TextRange): boolean {
	return Boolean(
		a &&
		a.start.line === b.start.line &&
		a.start.col === b.start.col &&
		a.end.line === b.end.line &&
		a.end.col === b.end.col,
	);
}

function replaceRange(editor: SelectableEditor, range: TextRange, notify: boolean): void {
	const startLine = editor.state.lines[range.start.line] ?? "";
	const endLine = editor.state.lines[range.end.line] ?? "";
	editor.state.lines.splice(
		range.start.line,
		range.end.line - range.start.line + 1,
		startLine.slice(0, range.start.col) + endLine.slice(range.end.col),
	);
	editor.state.cursorLine = range.start.line;
	editor.state.cursorCol = range.start.col;
	editor.preferredVisualCol = null;
	editor.snappedFromCursorCol = null;
	editor.lastAction = null;

	const retained = new Set<number>();
	for (const line of editor.state.lines) {
		for (const match of line.matchAll(PASTE_MARKER)) retained.add(Number(match[1]));
	}
	for (const id of editor.pastes.keys()) if (!retained.has(id)) editor.pastes.delete(id);
	if (notify) editor.onChange?.(editor.getText());
}

function ownDescriptor(target: object, name: PropertyKey): PropertyDescriptor | undefined {
	return Object.getOwnPropertyDescriptor(target, name);
}

function restoreProperty(target: object, name: PropertyKey, descriptor: PropertyDescriptor | undefined): void {
	if (descriptor) Object.defineProperty(target, name, descriptor);
	else delete (target as Record<PropertyKey, unknown>)[name];
}

export function installPromptSelection(editor: EditorComponent, deps: SelectionDependencies): PromptSelection {
	if (!isSelectableEditor(editor, deps)) return { supported: false, clear() {}, dispose() {} };

	let active = true;
	let suppressSnapshots = 0;
	const redoStack: EditorSnapshot[] = [];
	const registration: RenderRegistration = { deps };
	const unregisterRender = registerRenderHook(editor, registration, deps);
	const handleDescriptor = ownDescriptor(editor, "handleInput");
	const setTextDescriptor = ownDescriptor(editor, "setText");
	const insertDescriptor = ownDescriptor(editor, "insertTextAtCursor");
	const snapshotDescriptor = ownDescriptor(editor, "pushUndoSnapshot");
	const undoDescriptor = ownDescriptor(editor, "undo");
	const originalHandleInput = editor.handleInput.bind(editor);
	const originalSetText = editor.setText.bind(editor);
	const originalInsert = editor.insertTextAtCursor?.bind(editor);
	const originalPushSnapshot = editor.pushUndoSnapshot.bind(editor);
	const originalUndo = editor.undo.bind(editor);

	const clear = (): void => {
		if (!registration.anchor) return;
		registration.anchor = undefined;
		editor.tui.requestRender();
	};
	const range = (): TextRange | undefined => registration.anchor
		? normalizeRange(registration.anchor, position(editor))
		: undefined;
	const pushEditSnapshot = (): void => {
		redoStack.length = 0;
		originalPushSnapshot();
	};
	const performUndo = (): boolean => {
		if (editor.undoStack.length === 0) return false;
		const before = captureSnapshot(editor);
		const undoLength = editor.undoStack.length;
		registration.anchor = undefined;
		originalUndo();
		if (editor.undoStack.length >= undoLength) return false;
		redoStack.push(before);
		editor.tui.requestRender();
		return true;
	};
	const performRedo = (): boolean => {
		const snapshot = redoStack.pop();
		if (!snapshot) return false;
		registration.anchor = undefined;
		originalPushSnapshot();
		restoreSnapshot(editor, snapshot);
		return true;
	};
	const move = (data: string): boolean => {
		let action: (() => void) | undefined;
		if (deps.matchesKey(data, "shift+left")) action = () => editor.moveCursor(0, -1);
		else if (deps.matchesKey(data, "shift+right")) action = () => editor.moveCursor(0, 1);
		else if (deps.matchesKey(data, "shift+up")) action = () => editor.moveCursor(-1, 0);
		else if (deps.matchesKey(data, "shift+down")) action = () => editor.moveCursor(1, 0);
		else if (deps.matchesKey(data, "shift+home")) action = () => editor.moveToLineStart();
		else if (deps.matchesKey(data, "shift+end")) action = () => editor.moveToLineEnd();
		if (!action) return false;
		if (!registration.anchor) {
			registration.anchor = position(editor);
			editor.cancelAutocomplete();
		}
		action();
		editor.tui.requestRender();
		return true;
	};
	const deleteSelection = (notify: boolean): TextRange | undefined => {
		const selected = range();
		if (!selected) return undefined;
		editor.cancelAutocomplete();
		editor.exitHistoryBrowsing();
		pushEditSnapshot();
		replaceRange(editor, selected, notify);
		registration.anchor = undefined;
		return selected;
	};
	const replaceThenHandle = (data: string): void => {
		if (!deleteSelection(false)) {
			originalHandleInput(data);
			return;
		}
		suppressSnapshots++;
		const pendingBefore = suppressSnapshots;
		originalHandleInput(data);
		// A split bracketed paste does not snapshot until its closing chunk.
		// Other no-op insertions (for example yank with an empty kill ring) must
		// not leak suppression into the next unrelated edit.
		if (
			suppressSnapshots === pendingBefore &&
			!(data.includes("\x1b[200~") && !data.includes("\x1b[201~"))
		) {
			suppressSnapshots--;
		}
		editor.tui.requestRender();
	};

	editor.pushUndoSnapshot = () => {
		if (suppressSnapshots > 0) {
			suppressSnapshots--;
			return;
		}
		pushEditSnapshot();
	};
	editor.undo = () => {
		performUndo();
	};

	editor.handleInput = (data: string): void => {
		if (!active) return originalHandleInput(data);
		if (deps.matchesKey(data, "ctrl+a")) {
			editor.cancelAutocomplete();
			registration.anchor = { line: 0, col: 0 };
			editor.state.cursorLine = editor.state.lines.length - 1;
			editor.state.cursorCol = editor.state.lines.at(-1)?.length ?? 0;
			editor.preferredVisualCol = null;
			editor.snappedFromCursorCol = null;
			editor.lastAction = null;
			editor.tui.requestRender();
			return;
		}
		if (deps.matchesKey(data, "ctrl+shift+z")) {
			if (!performRedo()) originalHandleInput(data);
			return;
		}
		if (deps.matchesKey(data, "ctrl+z")) {
			performUndo();
			return;
		}
		if (move(data)) return;
		const selected = range();
		if (!selected) {
			if (registration.anchor && deps.matchesKey(data, "escape")) {
				clear();
				return;
			}
			registration.anchor = undefined;
			originalHandleInput(data);
			return;
		}

		if (deps.matchesKey(data, "ctrl+x")) {
			const capturedText = editor.getText();
			const capturedRange = structuredClone(selected);
			const displayed = extractRange(editor.state.lines, capturedRange);
			const expanded = editor.expandPasteMarkers(displayed);
			void deps.copyText(expanded)
				.then(() => {
					if (!active || editor.getText() !== capturedText || !sameRange(range(), capturedRange)) return;
					deleteSelection(true);
					editor.tui.requestRender();
				})
				.catch(deps.onCopyError);
			return;
		}
		if (deps.matchesAction(data, "tui.input.copy")) {
			const displayed = extractRange(editor.state.lines, selected);
			const expanded = editor.expandPasteMarkers(displayed);
			void deps.copyText(expanded).catch(deps.onCopyError);
			return;
		}
		if (deps.matchesKey(data, "escape")) {
			clear();
			return;
		}
		if (
			deps.matchesAction(data, "tui.editor.cursorLeft") ||
			deps.matchesAction(data, "tui.editor.cursorUp")
		) {
			editor.state.cursorLine = selected.start.line;
			editor.state.cursorCol = selected.start.col;
			clear();
			return;
		}
		if (
			deps.matchesAction(data, "tui.editor.cursorRight") ||
			deps.matchesAction(data, "tui.editor.cursorDown")
		) {
			editor.state.cursorLine = selected.end.line;
			editor.state.cursorCol = selected.end.col;
			clear();
			return;
		}
		if (DELETION_ACTIONS.some((action) => deps.matchesAction(data, action))) {
			deleteSelection(true);
			editor.tui.requestRender();
			return;
		}
		const replacement =
			REPLACEMENT_ACTIONS.some((action) => deps.matchesAction(data, action)) ||
			data.includes("\x1b[200~") ||
			deps.decodePrintable(data) !== undefined;
		if (replacement) {
			replaceThenHandle(data);
			return;
		}

		// Submit and non-editing app actions keep their normal behavior, but must
		// not leave a stale logical range if the editor changes underneath us.
		clear();
		if (deps.matchesAction(data, "tui.input.submit")) redoStack.length = 0;
		originalHandleInput(data);
	};

	editor.setText = (text: string): void => {
		registration.anchor = undefined;
		redoStack.length = 0;
		originalSetText(text);
	};
	if (originalInsert) {
		editor.insertTextAtCursor = (text: string): void => {
			if (text && range()) {
				deleteSelection(false);
				suppressSnapshots++;
			}
			originalInsert(text);
			editor.tui.requestRender();
		};
	}

	return {
		supported: true,
		clear,
		dispose() {
			if (!active) return;
			active = false;
			unregisterRender();
			restoreProperty(editor, "handleInput", handleDescriptor);
			restoreProperty(editor, "setText", setTextDescriptor);
			restoreProperty(editor, "insertTextAtCursor", insertDescriptor);
			restoreProperty(editor, "pushUndoSnapshot", snapshotDescriptor);
			restoreProperty(editor, "undo", undoDescriptor);
		},
	};
}
