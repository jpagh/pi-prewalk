/**
 * Prewalk Extension
 *
 * Ported from oh-my-pi (github.com/can1357/oh-my-pi): the "prewalk" behaviour.
 *
 * Prewalk lets a strong model do the planning and then hands the mechanical
 * implementation off to a fast/cheap model. It is a one-way switch, armed
 * either at startup (`--prewalk` / `--prewalk-into <model>`) or mid-session
 * via the `/prewalk` command, and it fires at the first `edit`/`write` once a
 * todo list exists (the "todo gate").
 *
 * How it works, per assistant turn boundary (`turn_end`):
 *   1. A hidden deep-plan nudge is steered in so the strong model commits to a
 *      complete plan and seeds a todo list before touching code.
 *   2. A safety-net "continue" nudge re-arms one extra turn after a text-only
 *      reply so a plan-only turn never ends the run with no code written.
 *   3. Once the todo list exists AND the model makes its first edit/write, the
 *      session switches to the fast target model and a verification checklist
 *      is steered in. The plan nudge is scrubbed from the LLM context at the
 *      switch (the fast model inherits the plan, not the nudge).
 *
 * Bash is deliberately NOT a trigger tool (it doubles as exploration), and the
 * `todo` call itself is deliberately NOT a trigger (firing there hands the fast
 * model the whole implementation cold).
 *
 * Install:
 *   pi install npm:pi-prewalk
 * or try it without installing:
 *   pi -e npm:pi-prewalk
 *
 * Usage:
 *   pi --prewalk                     # arm at startup, default target (GLM-5.2 on baseten)
 *   pi --prewalk-into anthropic/...  # arm at startup, explicit target
 *   /prewalk                         # arm now, default target (GLM-5.2 on baseten)
 *   /prewalk <provider/model|model>  # arm now, explicit target
 *   /prewalk off                     # disarm
 *   /prewalk status                  # show current state
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Hidden plan nudge; scrubbed from the LLM context once the switch happens. */
const PREWALK_PLAN_MESSAGE_TYPE = "prewalk-plan";
/** Hidden safety-net nudge forcing one more turn after a text-only reply. */
const PREWALK_CONTINUE_MESSAGE_TYPE = "prewalk-continue";
/** Hidden "verify before finishing" checklist steered in at the switch. */
const PREWALK_CHECKLIST_MESSAGE_TYPE = "prewalk-checklist";

/**
 * Tools whose first successful call triggers the switch — once the todo gate
 * is open. Bash is excluded (it doubles as exploration and fires turn-1
 * switches in practice). `todo` is NOT a trigger: firing at todo init hands
 * the fast model 100% of the implementation with zero started work.
 */
const PREWALK_ACTION_TOOLS: Record<string, true> = {
	edit: true,
	write: true,
};

/**
 * Default target model when none is given (upstream's `@smol` role has no
 * analogue here). GLM-5.2 on baseten — a fast/cheap implementation model.
 * Falls back to the cheapest available model if this one has no configured key.
 */
const DEFAULT_PREWALK_TARGET = { provider: "baseten", id: "zai-org/GLM-5.2" };

const PREWALK_PLAN_PROMPT = `Stop and write the complete plan in your NEXT reply — before any further exploration. You have already seen enough to commit to a plan; do not defer this.

First, state the plan itself, explicitly and comprehensively:

- Every remaining step in execution order, with the exact files, symbols, commands, and checks involved.
- Known risks, edge cases, and how you will verify each step actually landed (specific commands, expected outputs). Never modify tests or verification assets to make checks pass.
- What is already done, stated briefly, so no step gets repeated.

Be thorough and concrete — this plan is the reference for the remainder of the run. You may verify details with tools after the plan is written, never before.

Then, only once the plan above is complete, in the SAME reply, capture it as a todo list (the todo tool): 5-9 items, one per MEANINGFUL step, each naming its concrete target and its verification. Only steps that change or verify code belong on the list — no reporting, bookkeeping, cleanup-ceremony, or release-note items. The todo list serves the task, never the reverse: when reality disagrees with an item, fix the actual problem rather than working the checklist.

This is a checkpoint, not a final answer: do not end your turn on the plan alone — after recording the todo list, continue the task; do not stop here.`;

const PREWALK_CONTINUE_PROMPT = `Continue the task now — do not end your turn here.`;

const PREWALK_CHECKLIST_PROMPT = `Before you consider this task finished, verify:

- Consistency: if you changed a pattern, signature, or check in one place, grep for every other call site or duplicate copy that needs the identical change. A fix applied to only some of the matching sites is still a failure.
- Scope: if your diff does more than the minimal change needed to resolve the issue, confirm you have not altered behavior for any case outside the reported issue. Prefer the smallest correct diff over a broader rewrite.
- Verification: run the full test module or file the issue lives in, not just the one test you expect to flip. A change that breaks a sibling test is not a fix.

Do not claim the task is complete until you have done these three checks.`;

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

interface ArmedPrewalk {
	target: Model<Api>;
	thinkingLevel?: ThinkingLevel;
}

function modelLabel(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

function modelsAreEqual(a: Model<Api> | undefined, b: Model<Api>): boolean {
	return a !== undefined && a.provider === b.provider && a.id === b.id;
}

function totalCost(model: Model<Api>): number {
	return (model.cost?.input ?? 0) + (model.cost?.output ?? 0);
}

/**
 * Resolve the target model. With a spec (`provider/id` or a bare `id`) find the
 * matching available model. Without a spec, default to GLM-5.2 on baseten; if
 * that model has no configured key, fall back to the cheapest available model
 * other than the current one (preferring models with a known non-zero price so
 * a mispriced/free stub is not chosen ahead of a real cheap model).
 */
async function resolveTarget(
	ctx: ExtensionContext,
	spec: string | undefined,
): Promise<{ model?: Model<Api>; error?: string; warning?: string }> {
	const available = (await ctx.modelRegistry.getAvailable()) as Model<Api>[];
	if (available.length === 0) {
		return { error: "No models with configured API keys are available" };
	}

	if (spec) {
		const query = spec.trim().toLowerCase();
		let match: Model<Api> | undefined;
		if (query.includes("/")) {
			const slash = query.indexOf("/");
			const provider = query.slice(0, slash);
			const id = query.slice(slash + 1);
			// Model ids can themselves contain slashes (e.g. "zai-org/GLM-5.2"),
			// so fall back to matching the whole query as a bare id.
			match =
				available.find((m) => m.provider.toLowerCase() === provider && m.id.toLowerCase() === id) ??
				available.find((m) => m.id.toLowerCase() === query);
		} else {
			match =
				available.find((m) => m.id.toLowerCase() === query) ??
				available.find((m) => m.id.toLowerCase().includes(query));
		}
		if (!match) {
			return { error: `No available model matches "${spec}"` };
		}
		return { model: match };
	}

	const current = ctx.model as Model<Api> | undefined;
	const candidates = available.filter((m) => !modelsAreEqual(current, m));
	if (candidates.length === 0) {
		return { error: "No available model to prewalk into (only the current model has a configured key)" };
	}

	const isDefault = (m: Model<Api>): boolean =>
		m.provider.toLowerCase() === DEFAULT_PREWALK_TARGET.provider &&
		m.id.toLowerCase() === DEFAULT_PREWALK_TARGET.id.toLowerCase();
	const preferred = candidates.find(isDefault);
	if (preferred) {
		return { model: preferred };
	}

	const byCost = (a: Model<Api>, b: Model<Api>): number =>
		totalCost(a) - totalCost(b) || (a.cost?.output ?? 0) - (b.cost?.output ?? 0);
	const priced = candidates.filter((m) => totalCost(m) > 0).sort(byCost);
	const chosen = priced[0] ?? candidates.slice().sort(byCost)[0];
	// The default was excluded above either because it has no configured key or
	// because it is already the active model — say which so the warning is not
	// misleading when the key is in fact present.
	const defaultLabel = `${DEFAULT_PREWALK_TARGET.provider}/${DEFAULT_PREWALK_TARGET.id}`;
	const warning = available.some(isDefault)
		? `Default ${defaultLabel} is already the active model; using ${modelLabel(chosen)} instead.`
		: `Default ${defaultLabel} has no configured key; using ${modelLabel(chosen)} instead.`;
	return { model: chosen, warning };
}

export default function prewalkExtension(pi: ExtensionAPI) {
	let armed: ArmedPrewalk | undefined;
	let planInjected = false;
	let continuePending = false;
	let todoSeen = false;

	pi.registerFlag("prewalk", {
		description: "Arm prewalk: switch to a fast/cheap model at the first edit/write (todo-gated)",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("prewalk-into", {
		description: "Arm prewalk into a specific model (provider/id or id)",
		type: "string",
	});

	function resetState(): void {
		armed = undefined;
		planInjected = false;
		continuePending = false;
		todoSeen = false;
	}

	function steerPlanNudge(): void {
		pi.sendMessage(
			{
				customType: PREWALK_PLAN_MESSAGE_TYPE,
				content: PREWALK_PLAN_PROMPT,
				display: false,
			},
			{ deliverAs: "steer" },
		);
	}

	/**
	 * Arm prewalk and immediately steer the plan nudge — an explicit arm means
	 * "start this now". A no-op with a notice when already armed.
	 */
	function arm(target: Model<Api>, thinkingLevel: ThinkingLevel | undefined, ctx: ExtensionContext): void {
		if (armed) {
			ctx.ui.notify(
				`Prewalk: already armed for ${modelLabel(armed.target)}, waiting for the first edit/write.`,
				"info",
			);
			return;
		}
		armed = { target, thinkingLevel };
		planInjected = true;
		continuePending = true;
		steerPlanNudge();
		ctx.ui.notify(
			`Prewalk: armed for ${modelLabel(target)} — will switch at the first edit/write once the todo list exists.`,
			"info",
		);
	}

	// Startup arming from --prewalk / --prewalk-into.
	pi.on("session_start", async (_event, ctx) => {
		resetState();
		const into = pi.getFlag("prewalk-into");
		const enabled = pi.getFlag("prewalk") === true || (typeof into === "string" && into.length > 0);
		if (!enabled) return;
		const spec = typeof into === "string" && into.length > 0 ? into : undefined;
		const resolved = await resolveTarget(ctx, spec);
		if (resolved.error || !resolved.model) {
			ctx.ui.notify(`Prewalk: ${resolved.error ?? "could not resolve target model"}`, "warning");
			return;
		}
		if (resolved.warning) {
			ctx.ui.notify(`Prewalk: ${resolved.warning}`, "warning");
		}
		arm(resolved.model, undefined, ctx);
	});

	pi.registerCommand("prewalk", {
		description: "Switch to a fast/cheap model at the first edit/write (todo-gated)",
		handler: async (args, ctx) => {
			const arg = args?.trim() ?? "";
			if (arg === "off" || arg === "disable") {
				if (!armed) {
					ctx.ui.notify("Prewalk: not armed.", "info");
					return;
				}
				armed = undefined;
				continuePending = false;
				planInjected = false;
				ctx.ui.notify("Prewalk: disarmed.", "info");
				return;
			}
			if (arg === "status") {
				ctx.ui.notify(
					armed
						? `Prewalk: armed for ${modelLabel(armed.target)} (todo seen: ${todoSeen}).`
						: "Prewalk: not armed.",
					"info",
				);
				return;
			}
			const resolved = await resolveTarget(ctx, arg.length > 0 ? arg : undefined);
			if (resolved.error || !resolved.model) {
				ctx.ui.notify(`Prewalk: ${resolved.error ?? "could not resolve target model"}`, "error");
				return;
			}
			if (resolved.warning) {
				ctx.ui.notify(`Prewalk: ${resolved.warning}`, "warning");
			}
			arm(resolved.model, undefined, ctx);
		},
	});

	// One-way switch advanced at each completed assistant-turn boundary.
	pi.on("turn_end", async (event, ctx) => {
		if (!armed) return;
		const message = event.message;
		if (!message || message.role !== "assistant") return;

		const toolResults = event.toolResults ?? [];
		if (toolResults.some((result) => !result.isError && result.toolName === "todo")) {
			todoSeen = true;
		}

		// The plan nudge asks for a prose plan before implementation, but the
		// agent loop treats each text-only reply as terminal. Tool progress
		// re-arms one continuation so split flows (plan → todo → prose → read →
		// prose → edit) survive; two consecutive text-only replies end naturally.
		const hasToolResults = toolResults.length > 0;
		if (planInjected && hasToolResults) {
			continuePending = true;
		} else if (continuePending) {
			continuePending = false;
			pi.sendMessage(
				{
					customType: PREWALK_CONTINUE_MESSAGE_TYPE,
					content: PREWALK_CONTINUE_PROMPT,
					display: false,
				},
				{ deliverAs: "steer" },
			);
		}

		// Todo gate: wait until a todo list exists AND the model actually starts
		// implementing (first edit/write). If the todo tool is not even active,
		// the gate is considered open so the switch cannot deadlock.
		const todoGateOpen = todoSeen || !pi.getActiveTools().includes("todo");
		const action = todoGateOpen
			? toolResults.find((result) => !result.isError && PREWALK_ACTION_TOOLS[result.toolName])
			: undefined;

		if (!action) {
			if (!planInjected) {
				planInjected = true;
				continuePending = true;
				steerPlanNudge();
				ctx.ui.notify("Prewalk: injected deep-plan nudge.", "info");
			}
			return;
		}

		const target = armed.target;
		if (modelsAreEqual(ctx.model as Model<Api> | undefined, target)) {
			armed = undefined;
			continuePending = false;
			return;
		}

		const switched = await pi.setModel(target);
		if (!switched) {
			ctx.ui.notify(`Prewalk: no API key for ${modelLabel(target)}; staying on current model.`, "warning");
			armed = undefined;
			continuePending = false;
			return;
		}
		if (armed.thinkingLevel) {
			pi.setThinkingLevel(armed.thinkingLevel);
		}
		armed = undefined;
		ctx.ui.notify(`Prewalk: switched to ${modelLabel(target)} after first ${action.toolName} call.`, "info");
		pi.sendMessage(
			{
				customType: PREWALK_CHECKLIST_MESSAGE_TYPE,
				content: PREWALK_CHECKLIST_PROMPT,
				display: false,
			},
			{ deliverAs: "steer" },
		);
	});

	// The plan and continue nudges are one-shot steers meant to be seen only
	// during the planning phase, while prewalk is armed and waiting for the
	// first edit/write. Once the switch fires (or prewalk otherwise stands
	// down) `armed` is cleared, so from then on scrub both from the LLM context
	// — the model inherits the plan they produced, not the nudges themselves
	// (the verification checklist is deliberately left in place). Keying off
	// `armed` (rather than a separate flag) keeps the scrub durable across
	// session reloads, where `session_start` leaves `armed` undefined and the
	// nudges would otherwise resurface from history.
	pi.on("context", async (event) => {
		if (armed) return;
		const messages = event.messages.filter(
			(m) =>
				!(
					m.role === "custom" &&
					(m.customType === PREWALK_PLAN_MESSAGE_TYPE || m.customType === PREWALK_CONTINUE_MESSAGE_TYPE)
				),
		);
		if (messages.length === event.messages.length) return;
		return { messages };
	});
}
