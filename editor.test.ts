import assert from "node:assert/strict";
import test from "node:test";
import type { EditorComponent } from "@earendil-works/pi-tui";
import { installGlobalHistory } from "./editor.ts";

class FakeEditor implements EditorComponent {
	history: string[] = [];
	text = "";
	customMarker = "preserved";
	onSubmit?: (text: string) => void;
	onChange?: (text: string) => void;

	addToHistory(input: string): void {
		const value = input.trim();
		if (value && this.history[0] !== value) this.history.unshift(value);
	}
	getText(): string { return this.text; }
	setText(text: string): void { this.text = text; }
	handleInput(): void {}
	render(): string[] { return []; }
	invalidate(): void {}
}

test("clears session history and seeds global entries oldest to newest", () => {
	const editor = new FakeEditor();
	editor.addToHistory("session prompt");
	const installed = installGlobalHistory(editor, ["oldest", "middle", "newest"]);
	assert.equal(installed.editor, editor);
	assert.equal(editor.customMarker, "preserved");
	assert.deepEqual(editor.history, ["newest", "middle", "oldest"]);
});

test("blocks Pi session restoration and accepts explicit interactive prompts", () => {
	const editor = new FakeEditor();
	const installed = installGlobalHistory(editor, ["global"]);
	editor.addToHistory?.("session restoration");
	assert.deepEqual(editor.history, ["global"]);
	installed.addInteractive("typed prompt");
	assert.deepEqual(editor.history, ["typed prompt", "global"]);
});

test("dispose restores the editor history method", () => {
	const editor = new FakeEditor();
	const installed = installGlobalHistory(editor, []);
	installed.dispose();
	editor.addToHistory?.("after dispose");
	assert.deepEqual(editor.history, ["after dispose"]);
	installed.addInteractive("ignored");
	assert.deepEqual(editor.history, ["after dispose"]);
});

test("supports editor components without a public history implementation", () => {
	const editor: EditorComponent = {
		getText: () => "",
		setText: () => undefined,
		handleInput: () => undefined,
		render: () => [],
		invalidate: () => undefined,
	};
	const installed = installGlobalHistory(editor, ["one"]);
	assert.equal(installed.editor, editor);
	assert.doesNotThrow(() => installed.addInteractive("two"));
});
