import type { EditorComponent, TUI } from "@earendil-works/pi-tui";

const VIEWPORT_TUI = Symbol.for("@earendil-works/pi-tui/viewport");

interface ScrollableViewportTui extends TUI {
	readonly [VIEWPORT_TUI]?: true;
	scrollToBottom?(): void;
}

export interface PromptSubmitScrollInstallation {
	dispose(): void;
}

function restoreProperty(target: object, name: PropertyKey, descriptor: PropertyDescriptor | undefined): void {
	if (descriptor) Object.defineProperty(target, name, descriptor);
	else delete (target as Record<PropertyKey, unknown>)[name];
}

function scrollToBottom(tui: TUI): void {
	const viewport = tui as ScrollableViewportTui;
	if (viewport[VIEWPORT_TUI] !== true) return;
	const scroll = viewport.scrollToBottom;
	if (typeof scroll !== "function") return;
	try {
		scroll.call(tui);
	} catch {
		// scrollToBottom is not part of ViewportTUI's public interface. Leave
		// submission unaffected if a compatible renderer method is unavailable.
	}
}

/** Scroll the fullscreen transcript when this editor actually submits. */
export function installPromptSubmitScroll(
	editor: EditorComponent,
	tui: TUI,
): PromptSubmitScrollInstallation {
	let active = true;
	const handleDescriptor = Object.getOwnPropertyDescriptor(editor, "handleInput");
	const originalHandleInput = editor.handleInput.bind(editor);

	editor.handleInput = (data: string): void => {
		if (!active) {
			originalHandleInput(data);
			return;
		}

		const previousSubmit = editor.onSubmit;
		const wrappedSubmit = (text: string): void => {
			scrollToBottom(tui);
			previousSubmit?.(text);
		};
		editor.onSubmit = wrappedSubmit;
		try {
			originalHandleInput(data);
		} finally {
			if (editor.onSubmit === wrappedSubmit) editor.onSubmit = previousSubmit;
		}
	};

	return {
		dispose() {
			if (!active) return;
			active = false;
			restoreProperty(editor, "handleInput", handleDescriptor);
		},
	};
}
