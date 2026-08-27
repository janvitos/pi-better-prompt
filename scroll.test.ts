import assert from "node:assert/strict";
import test from "node:test";
import type { EditorComponent, TUI } from "@earendil-works/pi-tui";
import { installPromptSubmitScroll } from "./scroll.ts";

const VIEWPORT_TUI = Symbol.for("@earendil-works/pi-tui/viewport");

class FakeEditor implements EditorComponent {
	text = "prompt";
	onSubmit?: (text: string) => void;
	onChange?: (text: string) => void;

	getText(): string { return this.text; }
	setText(text: string): void { this.text = text; }
	handleInput(data: string): void {
		if (data === "submit") {
			const submitted = this.text;
			this.text = "";
			this.onSubmit?.(submitted);
		} else if (data === "newline") {
			this.text += "\n";
		}
	}
	render(): string[] { return []; }
	invalidate(): void {}
}

function fakeTui(options: { viewport?: boolean; scroll?: () => void } = {}): TUI {
	return {
		...(options.viewport ? { [VIEWPORT_TUI]: true } : {}),
		...(options.scroll ? { scrollToBottom: options.scroll } : {}),
	} as unknown as TUI;
}

test("scrolls before delegating an actual fullscreen submission", () => {
	const order: string[] = [];
	const editor = new FakeEditor();
	const originalSubmit = (text: string) => order.push(`submit:${text}`);
	editor.onSubmit = originalSubmit;
	installPromptSubmitScroll(editor, fakeTui({
		viewport: true,
		scroll: () => order.push("scroll"),
	}));

	editor.handleInput("submit");

	assert.deepEqual(order, ["scroll", "submit:prompt"]);
	assert.equal(editor.onSubmit, originalSubmit);
});

test("does not scroll when Enter inserts a newline instead of submitting", () => {
	let scrolls = 0;
	const editor = new FakeEditor();
	installPromptSubmitScroll(editor, fakeTui({
		viewport: true,
		scroll: () => scrolls++,
	}));

	editor.handleInput("newline");

	assert.equal(scrolls, 0);
	assert.equal(editor.getText(), "prompt\n");
});

test("leaves non-viewport and incompatible renderers unaffected", () => {
	for (const tui of [
		fakeTui({ scroll: () => assert.fail("regular TUI must not scroll") }),
		fakeTui({ viewport: true }),
		fakeTui({ viewport: true, scroll: () => { throw new Error("unsupported"); } }),
	]) {
		const editor = new FakeEditor();
		let submitted = "";
		editor.onSubmit = (text) => { submitted = text; };
		installPromptSubmitScroll(editor, tui);
		assert.doesNotThrow(() => editor.handleInput("submit"));
		assert.equal(submitted, "prompt");
	}
});

test("dispose restores the original editor input handler", () => {
	const editor = new FakeEditor();
	const originalHandleInput = editor.handleInput;
	let scrolls = 0;
	const installation = installPromptSubmitScroll(editor, fakeTui({
		viewport: true,
		scroll: () => scrolls++,
	}));

	installation.dispose();
	installation.dispose();
	editor.handleInput("submit");

	assert.equal(editor.handleInput, originalHandleInput);
	assert.equal(scrolls, 0);
});
