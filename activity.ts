import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type Activity = "thinking" | "searching" | "reading" | "writing" | "running" | "responding" | "working";
type SetWorkingMessage = (message?: string) => void;

const MESSAGES: Record<Activity, string> = {
	thinking: "Thinking...",
	searching: "Searching...",
	reading: "Reading...",
	writing: "Writing...",
	running: "Running...",
	responding: "Responding...",
	working: "Working...",
};

const SEARCH_TOOLS = new Set(["web_search", "grep", "find", "ls"]);
const READ_TOOLS = new Set(["read", "url_context"]);
const WRITE_TOOLS = new Set(["write", "edit"]);
const RUN_TOOLS = new Set(["bash", "powershell"]);

export function classifyToolActivity(toolName: string): Activity {
	if (SEARCH_TOOLS.has(toolName)) return "searching";
	if (READ_TOOLS.has(toolName)) return "reading";
	if (WRITE_TOOLS.has(toolName)) return "writing";
	if (RUN_TOOLS.has(toolName)) return "running";
	return "working";
}

export class ActivityStatus {
	private readonly activeTools = new Map<string, Activity>();
	private displayed: string | undefined;

	private show(activity: Activity, setMessage: SetWorkingMessage): void {
		const message = MESSAGES[activity];
		if (message === this.displayed) return;
		this.displayed = message;
		setMessage(message);
	}

	private showActiveTools(setMessage: SetWorkingMessage): void {
		const activities = new Set(this.activeTools.values());
		this.show(activities.size === 1 ? [...activities][0]! : "working", setMessage);
	}

	start(setMessage: SetWorkingMessage): void {
		this.activeTools.clear();
		this.show("thinking", setMessage);
	}

	messageUpdate(eventType: string, setMessage: SetWorkingMessage): void {
		if (eventType === "thinking_start" || eventType === "thinking_delta" || eventType === "thinking_end") {
			this.show("thinking", setMessage);
		} else if (eventType === "text_start" || eventType === "text_delta" || eventType === "text_end") {
			this.show("responding", setMessage);
		} else if (eventType.startsWith("toolcall_")) {
			this.show("working", setMessage);
		}
	}

	toolStart(toolCallId: string, toolName: string, setMessage: SetWorkingMessage): void {
		this.activeTools.set(toolCallId, classifyToolActivity(toolName));
		this.showActiveTools(setMessage);
	}

	toolEnd(toolCallId: string, setMessage: SetWorkingMessage): void {
		this.activeTools.delete(toolCallId);
		if (this.activeTools.size > 0) this.showActiveTools(setMessage);
		else this.show("thinking", setMessage);
	}

	reset(setMessage: SetWorkingMessage): void {
		this.activeTools.clear();
		this.displayed = undefined;
		setMessage();
	}
}

function setMessage(ctx: ExtensionContext): SetWorkingMessage {
	return (message) => ctx.ui.setWorkingMessage(message);
}

export function installActivityStatus(pi: ExtensionAPI): void {
	const status = new ActivityStatus();

	pi.on("agent_start", (_event, ctx) => {
		if (ctx.mode === "tui") status.start(setMessage(ctx));
	});
	pi.on("turn_start", (_event, ctx) => {
		if (ctx.mode === "tui") status.start(setMessage(ctx));
	});
	pi.on("message_update", (event, ctx) => {
		if (ctx.mode === "tui") status.messageUpdate(event.assistantMessageEvent.type, setMessage(ctx));
	});
	pi.on("tool_execution_start", (event, ctx) => {
		if (ctx.mode === "tui") status.toolStart(event.toolCallId, event.toolName, setMessage(ctx));
	});
	pi.on("tool_execution_end", (event, ctx) => {
		if (ctx.mode === "tui") status.toolEnd(event.toolCallId, setMessage(ctx));
	});
	pi.on("agent_settled", (_event, ctx) => {
		if (ctx.mode === "tui") status.reset(setMessage(ctx));
	});
	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.mode === "tui") status.reset(setMessage(ctx));
	});
}
