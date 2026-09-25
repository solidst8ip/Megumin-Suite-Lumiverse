// ─────────────────────────────────────────────────────────────────────────────
// workflowAuto.js — automatic ComfyUI workflow formatting & smart node binding.
//
// Two jobs the tab used to leave to the user:
//
//   1. FORMATTING. A workflow pasted in from ComfyUI usually arrives in the
//      *editor* (UI) format — { nodes: [...], links: [...] } — but the /prompt
//      endpoint only accepts the *API* format — { "id": { class_type, inputs } }.
//      normalizeWorkflow() detects what it was given and converts it, so an
//      import "just works" instead of failing with a cryptic rejection.
//
//   2. BINDING. Generation used to drive a workflow purely through %placeholder%
//      tokens the user hand-placed in the JSON ("%prompt%", "%seed%", ...).
//      bindWorkflow() keeps those tokens working, then goes further: it traces
//      the graph's links to find the positive/negative prompt encoders, the
//      sampler(s), the checkpoint loader, LoRA loaders, the latent-size node and
//      the CLIP-skip node — whatever node *types* the workflow happens to use —
//      and writes the tab's settings into them. A Flux workflow, an SDXL
//      workflow and an SD1.5 workflow all get driven with no hand-editing.
//
// Everything here is pure (no DOM, no spindle, no jQuery) so it is unit-tested
// directly with `bun test`.
//
// ── Node-type tables ─────────────────────────────────────────────────────────
// These name the *input keys* ComfyUI's API format uses. They are stable across
// ComfyUI versions because /prompt validates against them; a custom node with
// the same input names is bound the same way, which is what "any type of node"
// means here — binding is by (class_type, input name), never by node id.
// ─────────────────────────────────────────────────────────────────────────────

// Sampler node types, and which of their inputs each tab setting drives.
const SAMPLER_TYPES = new Set([
    "KSampler",
    "KSamplerAdvanced",
    "SamplerCustom",
    "SamplerCustomAdvanced",
]);

// Text-encoder node types -> the input key(s) that carry the prompt text.
const ENCODER_TEXT_INPUTS = {
    "CLIPTextEncode": ["text"],
    "CLIPTextEncodeSDXL": ["text_g", "text_l"],
    "CLIPTextEncodeSDXLRefiner": ["text"],
    "CLIPTextEncodeFlux": ["text"],
    "CLIPTextEncodeHunyuanDiT": ["text"],
};

// Checkpoint-style loader types -> the input key carrying the model file.
const MODEL_LOADER_TYPES = new Set([
    "CheckpointLoaderSimple",
    "CheckpointLoader",
    "CheckpointLoaderNF4",
    "unCLIPCheckpointLoader",
]);

// Latent-size node types -> [width key, height key].
const LATENT_SIZE_TYPES = new Set([
    "EmptyLatentImage",
    "SDXLEmptyLatentImage",
    "EmptySD3LatentImage",
    "EmptyHunyuanLatentImage",
    "EmptyLTXVLatentImage",
]);

// Widget order for the UI (editor) format -> API format conversion, for the node
// types people actually import. widgets_values is positional, so without this
// table a UI-format import cannot be converted faithfully. Anything not listed
// falls back to a live /object_info lookup when one is supplied, else a warning.
const UI_WIDGET_ORDER = {
    "KSampler": ["seed", "steps", "cfg", "sampler_name", "scheduler", "denoise", "control_after_generate"],
    "KSamplerAdvanced": ["add_noise", "noise_seed", "steps", "cfg", "sampler_name", "scheduler", "start_at_step", "end_at_step", "return_with_leftover_noise"],
    "SamplerCustom": ["add_noise", "noise_seed", "cfg"],
    "CheckpointLoaderSimple": ["ckpt_name"],
    "CheckpointLoader": ["config_name", "ckpt_name"],
    "unCLIPCheckpointLoader": ["ckpt_name"],
    "LoraLoader": ["lora_name", "strength_model", "strength_clip"],
    "LoraLoaderModelOnly": ["lora_name", "strength_model"],
    "CLIPTextEncode": ["text"],
    "CLIPTextEncodeSDXL": ["width", "height", "crop_w", "crop_h", "target_width", "target_height", "text_g", "text_l"],
    "CLIPTextEncodeSDXLRefiner": ["ascore", "width", "height", "text"],
    "CLIPLoader": ["clip_name", "type"],
    "DualCLIPLoader": ["clip_name1", "clip_name2", "type"],
    "UNETLoader": ["unet_name", "weight_dtype"],
    "VAELoader": ["vae_name"],
    "EmptyLatentImage": ["width", "height", "batch_size"],
    "SDXLEmptyLatentImage": ["width", "height", "batch_size"],
    "EmptySD3LatentImage": ["width", "height", "batch_size"],
    "LatentUpscale": ["upscale_method", "width", "height", "crop"],
    "ImageScale": ["upscale_method", "width", "height", "crop"],
    "SaveImage": ["filename_prefix"],
    "CLIPSetLastLayer": ["stop_at_clip_layer"],
    "ModelSamplingFlux": ["max_shift"],
    "ModelSamplingSD3": ["shift"],
    "FluxGuidance": ["guidance"],
    "ConditioningSetArea": ["width", "height", "x", "y", "strength"],
    "ConditioningSetAreaPercentage": ["width", "height", "x", "y", "strength"],
    "ControlNetApply": ["strength"],
    "ControlNetApplyAdvanced": ["strength", "start_percent", "end_percent"],
    "ControlNetLoader": ["control_net_name"],
    "unCLIPConditioning": ["strength", "noise_augmentation"],
    "GLIGENTextBoxApply": ["x", "y", "width", "height"],
};

// ── Small helpers ────────────────────────────────────────────────────────────

const toInt = (v) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : undefined;
};
const toFloat = (v) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : undefined;
};
const nonEmpty = (v) => (typeof v === "string" && v.trim() !== "" ? v : undefined);
// A literal %token% used as a *value* (autoTokenizeWorkflow) passes through
// every coercion untouched — otherwise "%clip_skip%" would become -1.
const isTokenString = (v) => typeof v === "string" && /^%[\w]+%$/.test(v);

// ── Settings resolution ──────────────────────────────────────────────────────
// One table so the token pass and the smart pass agree on what each setting
// means. Coercions mirror the tab's historical behavior exactly.

const SETTINGS = {
    prompt:         { get: (s) => s.prompt },
    negativePrompt: { get: (s) => s.negativePrompt ?? "" },
    seed:           { get: (s) => s.seed },
    steps:          { get: (s) => toInt(s.steps) ?? 20 },
    cfg:            { get: (s) => toFloat(s.cfg) ?? 7.0 },
    denoise:        { get: (s) => toFloat(s.denoise) ?? 1.0 },
    clipSkip:       { get: (s) => -Math.abs(toInt(s.clipSkip)) || -1 },
    sampler:        { get: (s) => nonEmpty(s.sampler) || "euler" },
    scheduler:      { get: (s) => nonEmpty(s.scheduler) }, // undefined -> skipped
    model:          { get: (s) => nonEmpty(s.model) || "v1-5-pruned.ckpt" },
    width:          { get: (s) => toInt(s.width) || 512 },
    height:         { get: (s) => toInt(s.height) || 512 },
};

function resolveSetting(key, settings) {
    // A literal %token% used as a *value* (autoTokenizeWorkflow) must pass
    // through untouched — check the raw input before any coercion runs,
    // otherwise "%steps%" would already have become 20 by the time we look.
    const rawInput = settings[key];
    if (isTokenString(rawInput)) return rawInput;
    return SETTINGS[key].get(settings);
}

function resolveLoraSlot(i, settings) {
    const slot = settings.loras && settings.loras[i];
    let name = slot && typeof slot.name === "string" ? slot.name.trim() : "";
    if (isTokenString(slot && slot.name)) name = slot.name;
    else if (name === "") name = "None"; // ComfyUI's LoraLoader accepts "None"
    let weight = toFloat(slot && (slot.weight ?? slot.strengthModel)) ?? 1.0;
    if (slot && isTokenString(slot.weight)) weight = slot.weight;
    return { name, weight };
}

// token -> which setting it carries (the tab's historical contract)
const TOKEN_SETTINGS = {
    "%prompt%": "prompt",
    "%negative_prompt%": "negativePrompt",
    "%seed%": "seed",
    "%steps%": "steps",
    "%scale%": "cfg",
    "%denoise%": "denoise",
    "%clip_skip%": "clipSkip",
    "%model%": "model",
    "%sampler%": "sampler",
    "%width%": "width",
    "%height%": "height",
};
for (let i = 1; i <= 4; i++) {
    TOKEN_SETTINGS[`%lora${i}%`] = `lora:${i - 1}:name`;
    TOKEN_SETTINGS[`%lorawt${i}%`] = `lora:${i - 1}:weight`;
}

function resolveTokenTarget(target, settings) {
    if (target.startsWith("lora:")) {
        const [, idx, kind] = target.split(":");
        const slot = resolveLoraSlot(parseInt(idx, 10), settings);
        return kind === "name" ? slot.name : slot.weight;
    }
    return resolveSetting(target, settings);
}

// ── Format detection & normalization ─────────────────────────────────────────

export function detectWorkflowFormat(parsed) {
    if (Array.isArray(parsed)) {
        // A bare array of UI nodes (exported without the graph wrapper) vs. a
        // bare array of API nodes — the node shape tells them apart.
        const looksUi = parsed.length > 0 && parsed.every(
            (n) => n && typeof n === "object" && typeof n.type === "string" && n.id !== undefined,
        );
        return looksUi ? "ui-nodes" : "array";
    }
    if (parsed && typeof parsed === "object") {
        if (Array.isArray(parsed.nodes)) return "ui";
        const values = Object.values(parsed);
        if (values.length > 0 && values.some((v) => v && typeof v === "object" && typeof v.class_type === "string")) {
            return "api";
        }
    }
    return "unknown";
}

// Build a widget-name order from a live /object_info/<type> response, for node
// types with no built-in table entry. Widget order follows the input definition
// order (required, then optional); only primitive-typed inputs become widgets —
// link-typed inputs (MODEL, CONDITIONING, ...) never do.
export function widgetOrderFromObjectInfo(info, classType) {
    const node = info && info[classType];
    const input = node && node.input;
    if (!input) return null;
    const PRIMITIVE = new Set(["INT", "FLOAT", "STRING", "BOOLEAN"]);
    const order = [];
    for (const section of ["required", "optional"]) {
        const spec = input[section];
        if (!spec || typeof spec !== "object") continue;
        for (const [name, def] of Object.entries(spec)) {
            const type = Array.isArray(def) ? def[0] : def;
            if (PRIMITIVE.has(type) || Array.isArray(type)) order.push(name);
        }
    }
    return order.length > 0 ? order : null;
}

async function uiNodesToApi(nodes, links, opts, warnings) {
    const byId = new Map(nodes.map((n) => [String(n.id), n]));
    const api = {};
    const orderCache = new Map();

    for (const node of nodes) {
        const id = String(node.id);
        const classType = node.type;
        const inputs = {};

        let order = UI_WIDGET_ORDER[classType] || orderCache.get(classType);
        if (order === undefined && typeof opts.describeNodeType === "function") {
            try {
                order = await opts.describeNodeType(classType);
            } catch (e) {
                order = null;
            }
            orderCache.set(classType, order || null);
        }

        const widgetValues = Array.isArray(node.widgets_values) ? node.widgets_values : [];
        if (widgetValues.length > 0) {
            if (order && order.length > 0) {
                const n = Math.min(widgetValues.length, order.length);
                for (let i = 0; i < n; i++) inputs[order[i]] = widgetValues[i];
                if (widgetValues.length !== order.length) {
                    warnings.push(
                        `Node ${id} (${classType}): ${widgetValues.length} saved widget value(s) but ${order.length} known input(s) — mapped the first ${n}.`,
                    );
                }
            } else {
                warnings.push(
                    `Node ${id} (${classType}): unknown node type, its widget values could not be mapped and were left at defaults.`,
                );
            }
        }

        if (node.mode === 2 || node.mode === 4) {
            warnings.push(
                `Node ${id} (${classType}) is muted/bypassed in the editor — the API format executes every node, so it will run.`,
            );
        }

        const entry = { class_type: classType, inputs };
        if (node.title) entry._meta = { title: node.title };
        api[id] = entry;
    }

    // Links last: a linked input wins over any widget value mapped above.
    for (const link of links) {
        if (!Array.isArray(link) || link.length < 6) continue;
        const [, fromId, fromSlot, toId, toSlot] = link;
        const target = byId.get(String(toId));
        const slotDef = target && Array.isArray(target.inputs) ? target.inputs[toSlot] : undefined;
        const inputName = slotDef && slotDef.name;
        if (inputName && api[String(toId)]) {
            api[String(toId)].inputs[inputName] = [String(fromId), fromSlot];
        } else {
            warnings.push(`A link into node ${toId} slot ${toSlot} could not be mapped to an input name and was dropped.`);
        }
    }

    return api;
}

// Normalize any pasted/imported JSON to the API format /prompt expects.
// Returns { workflow, format, warnings }. workflow is null when unrecognized.
export async function normalizeWorkflow(parsed, opts = {}) {
    const warnings = [];
    const format = detectWorkflowFormat(parsed);

    if (format === "ui" || format === "ui-nodes") {
        const nodes = format === "ui" ? parsed.nodes : parsed;
        const links = format === "ui" && Array.isArray(parsed.links) ? parsed.links : [];
        return { workflow: await uiNodesToApi(nodes, links, opts, warnings), format, warnings };
    }

    if (format === "array") {
        const workflow = {};
        parsed.forEach((node, i) => {
            workflow[String(i)] = node;
        });
        warnings.push("The import was a bare array — node ids were assigned by position.");
        return { workflow, format, warnings };
    }

    if (format === "api") {
        const workflow = {};
        for (const [id, node] of Object.entries(parsed)) {
            if (!node || typeof node !== "object" || typeof node.class_type !== "string") {
                warnings.push(`Entry "${id}" has no class_type and was dropped.`);
                continue;
            }
            workflow[String(id)] = {
                class_type: node.class_type,
                inputs: node.inputs && typeof node.inputs === "object" ? { ...node.inputs } : {},
                ...(node._meta ? { _meta: node._meta } : {}),
            };
        }
        return { workflow, format, warnings };
    }

    return { workflow: null, format, warnings: ["Unrecognized workflow format — expected the ComfyUI API format or the editor (UI) format."] };
}

// ── Graph analysis ───────────────────────────────────────────────────────────
// Find each setting's destination nodes by tracing links, not by id.

function isSamplerType(classType) {
    return SAMPLER_TYPES.has(classType) || /ksampler/i.test(classType || "");
}

function linkTargetId(inputs, ...names) {
    if (!inputs) return null;
    for (const name of names) {
        const v = inputs[name];
        if (Array.isArray(v) && v.length >= 2) return String(v[0]);
    }
    return null;
}

function encoderTextInputs(classType) {
    if (ENCODER_TEXT_INPUTS[classType]) return ENCODER_TEXT_INPUTS[classType];
    // Custom encoder nodes still expose their prompt as `text` in practice.
    if (/cliptextencode/i.test(classType || "")) return ["text"];
    return null;
}

export function analyzeWorkflow(workflow) {
    const nodes = Object.entries(workflow || {}).map(([id, node]) => ({ id: String(id), ...(node || {}) }));
    const byId = new Map(nodes.map((n) => [n.id, n]));

    const samplers = nodes.filter((n) => isSamplerType(n.class_type));

    const positiveIds = new Set();
    const negativeIds = new Set();
    for (const s of samplers) {
        const p = linkTargetId(s.inputs, "positive", "conditioning_positive");
        const n = linkTargetId(s.inputs, "negative", "conditioning_negative");
        if (p && byId.has(p)) positiveIds.add(p);
        if (n && byId.has(n)) negativeIds.add(n);
    }

    const encoders = nodes.filter((n) => encoderTextInputs(n.class_type));
    const positiveEncoders = encoders.filter((n) => positiveIds.has(n.id));
    const negativeEncoders = encoders.filter((n) => negativeIds.has(n.id));

    const modelLoaders = nodes.filter(
        (n) => MODEL_LOADER_TYPES.has(n.class_type) || /checkpointloader/i.test(n.class_type || ""),
    );
    const loraLoaders = nodes
        .filter((n) => /loraloader/i.test(n.class_type || ""))
        .sort((a, b) => parseInt(a.id, 10) - parseInt(b.id, 10));
    const latentNodes = nodes.filter(
        (n) => LATENT_SIZE_TYPES.has(n.class_type) || (/^empty/i.test(n.class_type || "") && n.inputs && "width" in n.inputs && "height" in n.inputs),
    );
    const clipSkipNodes = nodes.filter((n) => n.class_type === "CLIPSetLastLayer");

    return { samplers, positiveEncoders, negativeEncoders, encoders, modelLoaders, loraLoaders, latentNodes, clipSkipNodes };
}

// ── Binding ──────────────────────────────────────────────────────────────────

// Write value into the first present input name, unless that input is wired to
// another node (an Array link) — never clobber a user's explicit wiring.
function setInputIfPresent(node, names, value, record) {
    if (value === undefined || !node.inputs) return false;
    for (const name of names) {
        if (name in node.inputs && !Array.isArray(node.inputs[name])) {
            node.inputs[name] = value;
            record(name);
            return true;
        }
    }
    return false;
}

// Bind the tab's settings into a workflow (deep-cloned; the input is untouched).
// Pass 1 honors explicit %token% values (the historical contract). Pass 2 binds
// whatever is left by node type and link tracing, so imported workflows work
// with no hand-placed tokens at all.
// Returns { workflow, applied, warnings }.
export function bindWorkflow(workflow, settings) {
    const out = JSON.parse(JSON.stringify(workflow || {}));
    const applied = [];
    const warnings = [];
    const consumed = new Set();
    const loraTokenNodes = new Set(); // loader node ids carrying %loraN% tokens
    const note = (setting, node, input, via) =>
        applied.push({ setting, nodeId: node.id, classType: node.class_type, input, via });

    // — Pass 1: explicit tokens —
    for (const [id, node] of Object.entries(out)) {
        if (!node || typeof node !== "object" || !node.inputs || typeof node.inputs !== "object") continue;
        const nodeRef = { id: String(id), class_type: node.class_type };
        for (const key of Object.keys(node.inputs)) {
            const val = node.inputs[key];
            if (typeof val !== "string") continue;
            const target = TOKEN_SETTINGS[val];
            if (!target) continue;
            const value = resolveTokenTarget(target, settings);
            if (value === undefined) continue;
            node.inputs[key] = value;
            consumed.add(target);
            if (target.startsWith("lora:")) loraTokenNodes.add(nodeRef.id);
            note(target, nodeRef, key, "token");
        }
    }

    // — Pass 2: smart binding for anything the tokens did not cover —
    const roles = analyzeWorkflow(out);

    for (const s of roles.samplers) {
        if (!consumed.has("seed")) {
            setInputIfPresent(s, ["seed", "noise_seed"], resolveSetting("seed", settings), (input) => note("seed", s, input, "auto"));
        }
        if (!consumed.has("steps")) {
            setInputIfPresent(s, ["steps"], resolveSetting("steps", settings), (input) => note("steps", s, input, "auto"));
        }
        if (!consumed.has("cfg")) {
            setInputIfPresent(s, ["cfg"], resolveSetting("cfg", settings), (input) => note("cfg", s, input, "auto"));
        }
        if (!consumed.has("sampler") && nonEmpty(settings.sampler)) {
            setInputIfPresent(s, ["sampler_name"], resolveSetting("sampler", settings), (input) => note("sampler", s, input, "auto"));
        }
        const scheduler = resolveSetting("scheduler", settings);
        if (scheduler !== undefined) {
            setInputIfPresent(s, ["scheduler"], scheduler, (input) => note("scheduler", s, input, "auto"));
        }
        if (!consumed.has("denoise")) {
            setInputIfPresent(s, ["denoise"], resolveSetting("denoise", settings), (input) => note("denoise", s, input, "auto"));
        }
    }
    if (roles.samplers.length === 0) warnings.push("No sampler node found — seed/steps/CFG/sampler settings were not bound.");

    // Prompt encoders: traced positive/negative first, then a documented fallback.
    if (!consumed.has("prompt")) {
        let targets = roles.positiveEncoders;
        let via = "auto";
        if (targets.length === 0 && roles.encoders.length > 0) {
            targets = [roles.encoders[0]];
            via = "auto (fallback: first encoder)";
            warnings.push("Could not trace which text encoder is the positive prompt — the first one was used. Add a %prompt% token to be explicit.");
        }
        for (const enc of targets) {
            for (const input of encoderTextInputs(enc.class_type) || []) {
                setInputIfPresent(enc, [input], resolveSetting("prompt", settings), (name) => note("prompt", enc, name, via));
            }
        }
        if (targets.length === 0) warnings.push("No text-encoder node found — the prompt was not bound.");
    }
    if (!consumed.has("negativePrompt")) {
        for (const enc of roles.negativeEncoders) {
            for (const input of encoderTextInputs(enc.class_type) || []) {
                setInputIfPresent(enc, [input], resolveSetting("negativePrompt", settings), (name) => note("negativePrompt", enc, name, "auto"));
            }
        }
        if (roles.negativeEncoders.length === 0 && roles.encoders.length > 0) {
            warnings.push("Could not trace a negative-prompt encoder — the negative prompt was not bound. Add a %negative_prompt% token to be explicit.");
        }
    }

    if (!consumed.has("model") && nonEmpty(settings.model)) {
        const model = resolveSetting("model", settings);
        let bound = false;
        for (const loader of roles.modelLoaders) {
            if (setInputIfPresent(loader, ["ckpt_name"], model, (input) => note("model", loader, input, "auto"))) bound = true;
        }
        if (!bound && roles.modelLoaders.length > 0) warnings.push("A checkpoint loader was found but has no ckpt_name input to bind.");
    }

    if (!consumed.has("width") || !consumed.has("height")) {
        const width = resolveSetting("width", settings);
        const height = resolveSetting("height", settings);
        for (const latent of roles.latentNodes) {
            if (!consumed.has("width")) setInputIfPresent(latent, ["width"], width, (input) => note("width", latent, input, "auto"));
            if (!consumed.has("height")) setInputIfPresent(latent, ["height"], height, (input) => note("height", latent, input, "auto"));
        }
        if (roles.latentNodes.length === 0) warnings.push("No latent-size node found — width/height were not bound.");
    }

    if (!consumed.has("clipSkip")) {
        for (const node of roles.clipSkipNodes) {
            setInputIfPresent(node, ["stop_at_clip_layer"], resolveSetting("clipSkip", settings), (input) => note("clipSkip", node, input, "auto"));
        }
    }

    // LoRAs: active tab slots -> LoRA loader nodes in graph order. Slots the
    // tokens already handled are skipped, as are loaders carrying %loraN%
    // tokens (so a token placement is never clobbered by slot order), and
    // surplus loaders are left untouched rather than cleared — a hand-placed
    // LoRA is never wiped.
    const activeSlots = [0, 1, 2, 3]
        .map((i) => ({ i, ...resolveLoraSlot(i, settings) }))
        .filter((s) => s.name && s.name !== "None" && !consumed.has(`lora:${s.i}:name`));
    const freeLoaders = roles.loraLoaders.filter((l) => !loraTokenNodes.has(l.id));
    freeLoaders.forEach((loader, li) => {
        const slot = activeSlots[li];
        if (!slot) return;
        setInputIfPresent(loader, ["lora_name"], slot.name, (input) => note(`lora:${slot.i}:name`, loader, input, "auto"));
        setInputIfPresent(loader, ["strength_model"], slot.weight, (input) => note(`lora:${slot.i}:weight`, loader, input, "auto"));
        setInputIfPresent(loader, ["strength_clip"], slot.weight, (input) => note(`lora:${slot.i}:weight`, loader, input, "auto"));
    });
    // Only real user selections count toward the warning — %loraN% placeholder
    // values (auto-tokenize) are not selections the user made.
    const realActive = activeSlots.filter((s) => !isTokenString(s.name));
    if (realActive.length > freeLoaders.length) {
        warnings.push(
            `${realActive.length} LoRA slot(s) are active but the workflow only has ${freeLoaders.length} free LoRA loader node(s) — the extra slot(s) were not bound.`,
        );
    }

    return { workflow: out, applied, warnings };
}

// Rewrite a workflow into the tab's canonical tokenized form: the same binding
// pass, but every setting's value is its %token%, so the JSON the user keeps
// shows exactly what the tab will drive at generation time.
export function autoTokenizeWorkflow(workflow) {
    return bindWorkflow(workflow, {
        prompt: "%prompt%",
        negativePrompt: "%negative_prompt%",
        seed: "%seed%",
        steps: "%steps%",
        cfg: "%scale%",
        denoise: "%denoise%",
        clipSkip: "%clip_skip%",
        sampler: "%sampler%",
        scheduler: "",
        model: "%model%",
        width: "%width%",
        height: "%height%",
        loras: [1, 2, 3, 4].map((i) => ({ name: `%lora${i}%`, weight: `%lorawt${i}%` })),
    });
}

// Full import pipeline: parse -> normalize -> auto-tokenize -> pretty JSON.
// describeNodeType(classType) is an optional async (type) -> [widget names]
// used for node types with no built-in conversion table.
export async function formatImportedWorkflowText(text, opts = {}) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch (e) {
        return { ok: false, error: `Not valid JSON: ${e.message}` };
    }
    const norm = await normalizeWorkflow(parsed, opts);
    if (!norm.workflow) {
        return { ok: false, error: norm.warnings[0] || "Unrecognized workflow format." };
    }
    const tokenized = autoTokenizeWorkflow(norm.workflow);
    return {
        ok: true,
        text: JSON.stringify(tokenized.workflow, null, 4),
        format: norm.format,
        applied: tokenized.applied,
        warnings: [...norm.warnings, ...tokenized.warnings],
    };
}
