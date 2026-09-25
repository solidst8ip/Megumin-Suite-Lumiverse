import { describe, expect, test } from "bun:test";
import {
    detectWorkflowFormat,
    normalizeWorkflow,
    widgetOrderFromObjectInfo,
    analyzeWorkflow,
    bindWorkflow,
    autoTokenizeWorkflow,
    formatImportedWorkflowText,
} from "./workflowAuto.js";

// A classic SD1.5 graph in ComfyUI *editor* (UI) format.
const UI_SAMPLE = {
    nodes: [
        { id: 1, type: "CheckpointLoaderSimple", widgets_values: ["model.ckpt"],
          inputs: [{ name: "ckpt_name", type: "COMBO", link: null }] },
        { id: 2, type: "CLIPTextEncode", widgets_values: ["a cat"],
          inputs: [{ name: "clip", type: "CLIP", link: 20 }, { name: "text", type: "STRING", link: null }] },
        { id: 3, type: "CLIPTextEncode", widgets_values: ["blurry"],
          inputs: [{ name: "clip", type: "CLIP", link: 21 }, { name: "text", type: "STRING", link: null }] },
        { id: 4, type: "EmptyLatentImage", widgets_values: [512, 512, 1],
          inputs: [{ name: "width", type: "INT", link: null }, { name: "height", type: "INT", link: null }, { name: "batch_size", type: "INT", link: null }] },
        { id: 5, type: "KSampler", widgets_values: [42, 20, 7, "euler", "normal", 1, "fixed"],
          inputs: [
              { name: "model", type: "MODEL", link: 10 },
              { name: "positive", type: "CONDITIONING", link: 11 },
              { name: "negative", type: "CONDITIONING", link: 12 },
              { name: "latent_image", type: "LATENT", link: 13 },
              { name: "seed", type: "INT", link: null },
              { name: "steps", type: "INT", link: null },
              { name: "cfg", type: "FLOAT", link: null },
              { name: "sampler_name", type: "COMBO", link: null },
              { name: "scheduler", type: "COMBO", link: null },
              { name: "denoise", type: "FLOAT", link: null },
              { name: "control_after_generate", type: "COMBO", link: null },
          ] },
    ],
    links: [
        [10, 1, 0, 5, 0, "MODEL"],
        [11, 2, 0, 5, 1, "CONDITIONING"],
        [12, 3, 0, 5, 2, "CONDITIONING"],
        [13, 4, 0, 5, 3, "LATENT"],
        [20, 1, 1, 2, 0, "CLIP"],
        [21, 1, 1, 3, 0, "CLIP"],
    ],
};

// The same graph, already in API format, plus a LoRA loader and save node.
const API_SAMPLE = {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "model.ckpt" } },
    "2": { class_type: "CLIPTextEncode", inputs: { text: "old positive", clip: ["1", 1] } },
    "3": { class_type: "CLIPTextEncode", inputs: { text: "old negative", clip: ["1", 1] } },
    "4": { class_type: "EmptyLatentImage", inputs: { width: 512, height: 512, batch_size: 1 } },
    "5": { class_type: "KSampler", inputs: {
        seed: 1, steps: 20, cfg: 7, sampler_name: "euler", scheduler: "normal", denoise: 1,
        model: ["1", 0], positive: ["2", 0], negative: ["3", 0], latent_image: ["4", 0] } },
    "6": { class_type: "VAEDecode", inputs: { samples: ["5", 0], vae: ["1", 2] } },
    "7": { class_type: "SaveImage", inputs: { filename_prefix: "out", images: ["6", 0] } },
    "8": { class_type: "LoraLoader", inputs: {
        lora_name: "old.safetensors", strength_model: 1, strength_clip: 1, model: ["1", 0], clip: ["1", 1] } },
};

const SETTINGS = {
    prompt: "a dog", negativePrompt: "blurry", seed: 99, steps: 30, cfg: 8,
    denoise: 0.9, clipSkip: 2, sampler: "dpmpp_2m", scheduler: "karras",
    model: "new.ckpt", width: 768, height: 1024,
    loras: [
        { name: "lora1.safetensors", weight: 0.8 },
        { name: "", weight: 1 }, { name: "", weight: 1 }, { name: "", weight: 1 },
    ],
};

describe("detectWorkflowFormat", () => {
    test("recognizes the API format", () => {
        expect(detectWorkflowFormat(API_SAMPLE)).toBe("api");
    });
    test("recognizes the editor (UI) format", () => {
        expect(detectWorkflowFormat(UI_SAMPLE)).toBe("ui");
    });
    test("recognizes a bare array of UI nodes", () => {
        expect(detectWorkflowFormat(UI_SAMPLE.nodes)).toBe("ui-nodes");
    });
    test("rejects garbage", () => {
        expect(detectWorkflowFormat({ hello: "world" })).toBe("unknown");
        expect(detectWorkflowFormat(null)).toBe("unknown");
        expect(detectWorkflowFormat("nope")).toBe("unknown");
    });
});

describe("normalizeWorkflow", () => {
    test("converts UI widgets and links to API inputs", async () => {
        const { workflow, format, warnings } = await normalizeWorkflow(UI_SAMPLE);
        expect(format).toBe("ui");
        expect(warnings).toEqual([]);
        expect(workflow["5"].class_type).toBe("KSampler");
        expect(workflow["5"].inputs.seed).toBe(42);
        expect(workflow["5"].inputs.steps).toBe(20);
        expect(workflow["5"].inputs.sampler_name).toBe("euler");
        expect(workflow["5"].inputs.scheduler).toBe("normal");
        // Links win over widgets and land on named inputs.
        expect(workflow["5"].inputs.model).toEqual(["1", 0]);
        expect(workflow["5"].inputs.positive).toEqual(["2", 0]);
        expect(workflow["5"].inputs.negative).toEqual(["3", 0]);
        expect(workflow["5"].inputs.latent_image).toEqual(["4", 0]);
        expect(workflow["2"].inputs.text).toBe("a cat");
        expect(workflow["2"].inputs.clip).toEqual(["1", 1]);
        expect(workflow["1"].inputs.ckpt_name).toBe("model.ckpt");
        expect(workflow["4"].inputs.width).toBe(512);
    });

    test("warns on unknown node types instead of failing", async () => {
        const weird = {
            nodes: [{ id: 1, type: "SomeCustomNode", widgets_values: ["x"],
                       inputs: [{ name: "a", type: "STRING", link: null }] }],
            links: [],
        };
        const { workflow, warnings } = await normalizeWorkflow(weird);
        expect(workflow["1"].class_type).toBe("SomeCustomNode");
        expect(warnings.length).toBe(1);
        expect(warnings[0]).toMatch(/unknown node type/i);
    });

    test("passes API workflows through with validation", async () => {
        const { workflow, format, warnings } = await normalizeWorkflow({
            ...API_SAMPLE, junk: { no_class_type: true },
        });
        expect(format).toBe("api");
        expect(workflow["2"].inputs.text).toBe("old positive");
        expect(workflow.junk).toBeUndefined();
        expect(warnings.length).toBe(1);
    });
});

describe("widgetOrderFromObjectInfo", () => {
    test("derives widget order for unlisted node types", () => {
        const info = {
            FancyNode: { input: { required: {
                model: ["MODEL"],
                strength: ["FLOAT", {}],
                mode: [["a", "b"], {}],
            }, optional: { seed: ["INT", {}] } } },
        };
        expect(widgetOrderFromObjectInfo(info, "FancyNode")).toEqual(["strength", "mode", "seed"]);
        expect(widgetOrderFromObjectInfo(info, "Missing")).toBeNull();
    });
});

describe("analyzeWorkflow", () => {
    test("traces positive/negative encoders through sampler links", () => {
        const roles = analyzeWorkflow(API_SAMPLE);
        expect(roles.samplers.map((s) => s.id)).toEqual(["5"]);
        expect(roles.positiveEncoders.map((n) => n.id)).toEqual(["2"]);
        expect(roles.negativeEncoders.map((n) => n.id)).toEqual(["3"]);
        expect(roles.modelLoaders.map((n) => n.id)).toEqual(["1"]);
        expect(roles.loraLoaders.map((n) => n.id)).toEqual(["8"]);
        expect(roles.latentNodes.map((n) => n.id)).toEqual(["4"]);
    });
});

describe("bindWorkflow", () => {
    test("smart-binds every setting by node type with no tokens present", () => {
        const before = JSON.stringify(API_SAMPLE);
        const { workflow, applied, warnings } = bindWorkflow(API_SAMPLE, SETTINGS);
        // Input untouched (deep-cloned).
        expect(JSON.stringify(API_SAMPLE)).toBe(before);

        expect(workflow["2"].inputs.text).toBe("a dog");
        expect(workflow["3"].inputs.text).toBe("blurry");
        expect(workflow["5"].inputs.seed).toBe(99);
        expect(workflow["5"].inputs.steps).toBe(30);
        expect(workflow["5"].inputs.cfg).toBe(8);
        expect(workflow["5"].inputs.sampler_name).toBe("dpmpp_2m");
        expect(workflow["5"].inputs.scheduler).toBe("karras");
        expect(workflow["5"].inputs.denoise).toBe(0.9);
        expect(workflow["1"].inputs.ckpt_name).toBe("new.ckpt");
        expect(workflow["4"].inputs.width).toBe(768);
        expect(workflow["4"].inputs.height).toBe(1024);
        expect(workflow["8"].inputs.lora_name).toBe("lora1.safetensors");
        expect(workflow["8"].inputs.strength_model).toBe(0.8);
        expect(workflow["8"].inputs.strength_clip).toBe(0.8);
        // Linked inputs were not clobbered.
        expect(workflow["5"].inputs.model).toEqual(["1", 0]);
        expect(applied.length).toBeGreaterThan(10);
        expect(applied.every((a) => a.via === "auto" || a.via.startsWith("auto"))).toBe(true);
        expect(warnings).toEqual([]);
    });

    test("explicit tokens keep working and win over smart binding", () => {
        const tokened = JSON.parse(JSON.stringify(API_SAMPLE));
        tokened["2"].inputs.text = "%prompt%";
        tokened["5"].inputs.seed = "%seed%";
        const { workflow, applied } = bindWorkflow(tokened, SETTINGS);
        expect(workflow["2"].inputs.text).toBe("a dog");
        expect(workflow["5"].inputs.seed).toBe(99);
        const promptNotes = applied.filter((a) => a.setting === "prompt");
        expect(promptNotes).toHaveLength(1);
        expect(promptNotes[0].via).toBe("token");
        const seedNotes = applied.filter((a) => a.setting === "seed");
        expect(seedNotes).toHaveLength(1);
        expect(seedNotes[0].via).toBe("token");
        // ...while untokenized settings still bind smartly.
        expect(workflow["5"].inputs.steps).toBe(30);
        expect(workflow["3"].inputs.text).toBe("blurry");
    });

    test("never overwrites a linked (array) input", () => {
        const linked = JSON.parse(JSON.stringify(API_SAMPLE));
        linked["5"].inputs.seed = ["9", 0]; // wired from elsewhere
        const { workflow } = bindWorkflow(linked, SETTINGS);
        expect(workflow["5"].inputs.seed).toEqual(["9", 0]);
    });

    test("legacy coercions are preserved", () => {
        const tokened = {
            "1": { class_type: "KSampler", inputs: {
                steps: "%steps%", cfg: "%scale%", denoise: "%denoise%",
                sampler_name: "%sampler%", seed: "%seed%" } },
            "2": { class_type: "LoraLoader", inputs: { lora_name: "%lora1%", strength_model: "%lorawt1%" } },
            "3": { class_type: "CLIPSetLastLayer", inputs: { stop_at_clip_layer: "%clip_skip%" } },
            "4": { class_type: "EmptyLatentImage", inputs: { width: "%width%", height: "%height%" } },
        };
        const { workflow } = bindWorkflow(tokened, { ...SETTINGS, sampler: "", seed: 7 });
        expect(workflow["1"].inputs.steps).toBe(30);
        expect(workflow["1"].inputs.cfg).toBe(8);
        expect(workflow["1"].inputs.denoise).toBe(0.9);
        expect(workflow["1"].inputs.sampler_name).toBe("euler"); // legacy default
        expect(workflow["1"].inputs.seed).toBe(7);
        expect(workflow["2"].inputs.lora_name).toBe("lora1.safetensors");
        expect(workflow["2"].inputs.strength_model).toBe(0.8);
        expect(workflow["3"].inputs.stop_at_clip_layer).toBe(-2);
        expect(workflow["4"].inputs.width).toBe(768);
    });

    test("empty LoRA slots bind as None (legacy behavior)", () => {
        const tokened = { "1": { class_type: "LoraLoader", inputs: { lora_name: "%lora2%" } } };
        const { workflow } = bindWorkflow(tokened, SETTINGS);
        expect(workflow["1"].inputs.lora_name).toBe("None");
    });

    test("warns when roles are missing", () => {
        const bare = { "1": { class_type: "SaveImage", inputs: {} } };
        const { warnings } = bindWorkflow(bare, SETTINGS);
        expect(warnings.join(" ")).toMatch(/sampler/i);
    });

    test("warns when more real LoRA slots are active than free loaders", () => {
        const { warnings } = bindWorkflow(API_SAMPLE, {
            ...SETTINGS,
            loras: [
                { name: "a.safetensors", weight: 1 },
                { name: "b.safetensors", weight: 1 },
                { name: "", weight: 1 }, { name: "", weight: 1 },
            ],
        });
        expect(warnings.join(" ")).toMatch(/2 LoRA slot\(s\) are active.*only has 1 free/);
    });
});

describe("autoTokenizeWorkflow", () => {
    test("rewrites a workflow into canonical token form", () => {
        const { workflow, applied } = autoTokenizeWorkflow(API_SAMPLE);
        expect(workflow["2"].inputs.text).toBe("%prompt%");
        expect(workflow["3"].inputs.text).toBe("%negative_prompt%");
        expect(workflow["5"].inputs.seed).toBe("%seed%");
        expect(workflow["5"].inputs.steps).toBe("%steps%");
        expect(workflow["5"].inputs.cfg).toBe("%scale%");
        expect(workflow["5"].inputs.sampler_name).toBe("%sampler%");
        expect(workflow["1"].inputs.ckpt_name).toBe("%model%");
        expect(workflow["4"].inputs.width).toBe("%width%");
        expect(workflow["8"].inputs.lora_name).toBe("%lora1%");
        expect(workflow["8"].inputs.strength_model).toBe("%lorawt1%");
        expect(applied.length).toBeGreaterThan(5);
    });

    test("is idempotent on already-tokenized workflows", () => {
        const once = autoTokenizeWorkflow(API_SAMPLE).workflow;
        const twice = autoTokenizeWorkflow(once).workflow;
        expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
    });

    test("does not warn about placeholder LoRA slots", () => {
        const { warnings } = autoTokenizeWorkflow(API_SAMPLE);
        expect(warnings.join(" ")).not.toMatch(/LoRA slot/);
    });
});

describe("formatImportedWorkflowText", () => {
    test("end-to-end: UI JSON in, tokenized API JSON out", async () => {
        const result = await formatImportedWorkflowText(JSON.stringify(UI_SAMPLE));
        expect(result.ok).toBe(true);
        expect(result.format).toBe("ui");
        const out = JSON.parse(result.text);
        expect(out["2"].inputs.text).toBe("%prompt%");
        expect(out["5"].inputs.seed).toBe("%seed%");
        expect(out["5"].inputs.positive).toEqual(["2", 0]);
        expect(result.applied.length).toBeGreaterThan(5);
    });

    test("rejects invalid JSON", async () => {
        const result = await formatImportedWorkflowText("{nope");
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/valid JSON/i);
    });
});
