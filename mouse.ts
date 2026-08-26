import type { EditorComponent } from "@earendil-works/pi-tui";

// Click-to-caret is adapted from pi-starline's MIT-licensed mouse implementation:
// https://github.com/Andy8647/pi-starline/tree/main/extensions/starline/mouse

interface MouseEvent {
	button: number;
	x: number;
	y: number;
	release?: boolean;
}

interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

interface LayoutBox {
	component?: unknown;
	rect: Rect;
	clip?: Rect;
	children?: readonly LayoutBox[];
	lines?: readonly string[];
	lineOffset?: number;
}

interface VisualLine {
	logicalLine: number;
	startCol: number;
	length: number;
}

interface GraphemeSegment {
	segment: string;
	index: number;
}

interface EditorInternals {
	state: { lines: string[]; cursorLine: number; cursorCol: number };
	buildVisualLineMap(width: number): VisualLine[];
	segment?(text: string, mode: "grapheme"): Iterable<GraphemeSegment>;
	lastWidth?: number;
	scrollOffset?: number;
	paddingX?: number;
	preferredVisualCol?: number | null;
	snappedFromCursorCol?: number | null;
	lastAction?: unknown;
	cancelAutocomplete?(): void;
	exitHistoryBrowsing?(): void;
}

interface MouseReceiver {
	currentLayout?: { root: LayoutBox };
	terminal?: { rows?: number };
	hasOverlay?(): boolean;
}

interface MouseTarget {
	handleSelectionMouseEvent(this: MouseReceiver, event: MouseEvent): void;
	[key: symbol]: unknown;
}

interface MousePatchState {
	original: MouseTarget["handleSelectionMouseEvent"];
	wrapped: MouseTarget["handleSelectionMouseEvent"];
	handler?: (receiver: MouseReceiver, event: MouseEvent) => void;
	token: object;
}

export interface PromptMouseDependencies {
	cursorMarker: string;
	visibleWidth(text: string): number;
}

export interface PromptMouseInstallation {
	dispose(): void;
}

interface ActiveEditor {
	component: EditorComponent;
	clearSelection(): void;
}

let activeEditor: ActiveEditor | undefined;
const fallbackSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const MOUSE_PATCH = Symbol.for("@janvitos/pi-better-prompt/mouse-patch");

export function setActiveMouseEditor(editor: ActiveEditor | undefined): void {
	activeEditor = editor;
}

function rectContains(rect: Rect, x: number, y: number): boolean {
	return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

function boxesAt(root: LayoutBox, x: number, y: number): LayoutBox[] {
	const path: LayoutBox[] = [];
	let current: LayoutBox | undefined = root;
	while (current && rectContains(current.rect, x, y) && (!current.clip || rectContains(current.clip, x, y))) {
		path.push(current);
		current = current.children?.find(
			(child) => rectContains(child.rect, x, y) && (!child.clip || rectContains(child.clip, x, y)),
		);
	}
	return path;
}

function hosts(component: unknown, editor: unknown): boolean {
	if (typeof component !== "object" || component === null) return false;
	const children = (component as { children?: unknown }).children;
	return Array.isArray(children) && children.includes(editor);
}

function editorBoxFor(root: LayoutBox | undefined, editor: unknown): LayoutBox | undefined {
	if (!root) return undefined;
	if (root.component === editor || hosts(root.component, editor)) return root;
	for (const child of root.children ?? []) {
		const found = editorBoxFor(child, editor);
		if (found) return found;
	}
	return undefined;
}

function asEditorInternals(value: unknown): EditorInternals | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const editor = value as Partial<EditorInternals>;
	if (
		!editor.state ||
		!Array.isArray(editor.state.lines) ||
		typeof editor.state.cursorLine !== "number" ||
		typeof editor.state.cursorCol !== "number" ||
		typeof editor.buildVisualLineMap !== "function"
	) {
		return undefined;
	}
	return editor as EditorInternals;
}

function resolveEditorInternals(root: unknown): EditorInternals | undefined {
	const queue = [root];
	const seen = new Set<unknown>();
	while (queue.length > 0) {
		const value = queue.shift();
		if (typeof value !== "object" || value === null || seen.has(value)) continue;
		seen.add(value);
		const editor = asEditorInternals(value);
		if (editor) return editor;
		const candidate = value as { base?: unknown; children?: unknown };
		if (candidate.base) queue.push(candidate.base);
		if (Array.isArray(candidate.children)) queue.push(...candidate.children);
	}
	return undefined;
}

function segments(editor: EditorInternals, text: string): Iterable<GraphemeSegment> {
	try {
		return editor.segment?.(text, "grapheme") ?? fallbackSegmenter.segment(text);
	} catch {
		return fallbackSegmenter.segment(text);
	}
}

function stringIndexAtCell(
	editor: EditorInternals,
	text: string,
	cell: number,
	visibleWidth: (text: string) => number,
): number {
	if (cell <= 0) return 0;
	let column = 0;
	for (const entry of segments(editor, text)) {
		const width = visibleWidth(entry.segment);
		if (cell < column + width) return entry.index;
		column += width;
	}
	return text.length;
}

function snapToSegmentBoundary(editor: EditorInternals, text: string, col: number): number {
	for (const entry of segments(editor, text)) {
		const end = entry.index + entry.segment.length;
		if (col > entry.index && col < end) return entry.index;
	}
	return col;
}

function isPrimaryPress(event: unknown): event is MouseEvent {
	if (typeof event !== "object" || event === null) return false;
	const candidate = event as Partial<MouseEvent>;
	return (
		typeof candidate.button === "number" &&
		typeof candidate.x === "number" &&
		typeof candidate.y === "number" &&
		!candidate.release &&
		(candidate.button & (3 | 32 | 64)) === 0
	);
}

function moveCaret(
	receiver: MouseReceiver,
	event: MouseEvent,
	deps: PromptMouseDependencies,
): boolean {
	const active = activeEditor;
	if (!active || receiver.hasOverlay?.()) return false;
	const root = receiver.currentLayout?.root;
	const box = editorBoxFor(root, active.component);
	if (!root || !box || !boxesAt(root, event.x, event.y).includes(box)) return false;
	const editor = resolveEditorInternals(active.component);
	const rows = receiver.terminal?.rows;
	if (!editor || typeof rows !== "number") return false;

	const width = Math.max(1, editor.lastWidth ?? box.rect.width);
	const visualLines = editor.buildVisualLineMap(width);
	const scrollOffset = Math.max(0, editor.scrollOffset ?? 0);
	const cursorVisualRow = visualLines.findIndex(
		(line) =>
			line.logicalLine === editor.state.cursorLine &&
			editor.state.cursorCol >= line.startCol &&
			editor.state.cursorCol <= line.startCol + line.length,
	);
	const renderedCursorRow = box.lines?.findIndex((line) => line.includes(deps.cursorMarker)) ?? -1;
	const visibleCursorRow = cursorVisualRow - scrollOffset;
	const contentTop = renderedCursorRow >= 0 && visibleCursorRow >= 0
		? box.rect.y + renderedCursorRow - (box.lineOffset ?? 0) - visibleCursorRow
		: box.rect.y + 1;
	const contentRows = Math.min(
		Math.max(0, visualLines.length - scrollOffset),
		Math.max(5, Math.floor(rows * 0.3)),
		Math.max(0, box.rect.y + box.rect.height - contentTop),
	);
	const visualRow = event.y - contentTop;
	if (visualRow < 0 || visualRow >= contentRows) return false;
	const visual = visualLines[scrollOffset + visualRow];
	if (!visual) return false;

	const logicalText = editor.state.lines[visual.logicalLine] ?? "";
	const visualText = logicalText.slice(visual.startCol, visual.startCol + visual.length);
	const maxPadding = Math.max(0, Math.floor((box.rect.width - 1) / 2));
	const textColumn = Math.min(Math.max(0, editor.paddingX ?? 0), maxPadding);
	const cell = Math.max(0, event.x - box.rect.x - textColumn);
	const relativeCol = stringIndexAtCell(editor, visualText, cell, deps.visibleWidth);
	const col = snapToSegmentBoundary(editor, logicalText, visual.startCol + relativeCol);

	editor.cancelAutocomplete?.();
	editor.exitHistoryBrowsing?.();
	editor.state.cursorLine = visual.logicalLine;
	editor.state.cursorCol = Math.max(0, Math.min(logicalText.length, col));
	editor.preferredVisualCol = null;
	editor.snappedFromCursorCol = null;
	editor.lastAction = null;
	active.clearSelection();
	return true;
}

function isMousePatchState(value: unknown): value is MousePatchState {
	const state = value as Partial<MousePatchState> | undefined;
	return Boolean(state && typeof state.original === "function" && typeof state.wrapped === "function");
}

export function installPromptMouse(
	target: object,
	deps: PromptMouseDependencies,
): PromptMouseInstallation {
	const mouseTarget = target as MouseTarget;
	let state = mouseTarget[MOUSE_PATCH];
	if (!isMousePatchState(state)) {
		const original = mouseTarget.handleSelectionMouseEvent;
		if (typeof original !== "function") return { dispose() {} };
		const created: MousePatchState = {
			original,
			wrapped(this: MouseReceiver, event: MouseEvent): void {
				created.handler?.(this, event);
				Reflect.apply(created.original, this, [event]);
			},
			token: {},
		};
		state = created;
		try {
			mouseTarget.handleSelectionMouseEvent = created.wrapped;
			mouseTarget[MOUSE_PATCH] = created;
		} catch {
			return { dispose() {} };
		}
	}

	const activeState = state as MousePatchState;
	const token = {};
	activeState.token = token;
	activeState.handler = (receiver, event) => {
		if (isPrimaryPress(event)) moveCaret(receiver, event, deps);
	};
	let active = true;
	return {
		dispose() {
			if (!active) return;
			active = false;
			if (activeState.token !== token) return;
			activeState.handler = undefined;
			try {
				mouseTarget.handleSelectionMouseEvent = activeState.original;
				mouseTarget[MOUSE_PATCH] = undefined;
			} catch {
				// A stale dynamic TUI reference is already detached from the live renderer.
			}
		},
	};
}
