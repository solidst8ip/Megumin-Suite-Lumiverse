import { describe, expect, test, beforeEach } from "bun:test";
import { exportBackup, importBackup } from "./backend/store.js";

// store.js talks to the host global `spindle`. Mock the storage surface the
// backup functions touch: read/write/list plus the log they write to.
const files = new Map<string, string>();
(globalThis as any).spindle = {
  storage: {
    read: async (path: string) => {
      if (!files.has(path)) throw new Error(`missing: ${path}`);
      return files.get(path);
    },
    write: async (path: string, data: string) => {
      files.set(path, data);
    },
    list: async (prefix: string) => [...files.keys()].filter((k) => k.startsWith(prefix)),
  },
  log: { info() {}, error() {}, warn() {} },
};

describe("settings backup & restore", () => {
  beforeEach(() => {
    files.clear();
    files.set("settings.json", JSON.stringify({ profiles: { hero: { mode: "v9-core" } }, imageGen: { enabled: true } }));
    files.set("metadata/chat_1.json", JSON.stringify({ storyPlan: { enabled: true } }));
    files.set("metadata/chat_2.json", JSON.stringify({ npcBank: [] }));
  });

  test("exportBackup captures settings and every chat's metadata", async () => {
    const backup = await exportBackup("u1");
    expect(backup.format).toBe("megumin-suite-backup");
    expect(backup.version).toBe(1);
    expect(backup.exportedAt).toBeString();
    expect((backup.settings as any).profiles.hero.mode).toBe("v9-core");
    expect(Object.keys(backup.metadata).sort()).toEqual(["chat_1", "chat_2"]);
    expect((backup.metadata as any).chat_1.storyPlan.enabled).toBe(true);
  });

  test("importBackup restores a full export onto empty storage", async () => {
    const backup = await exportBackup("u1");
    files.clear();
    const result = await importBackup(JSON.parse(JSON.stringify(backup)), "u1");
    expect(result.ok).toBe(true);
    expect(result.importedChats).toBe(2);
    expect(JSON.parse(files.get("settings.json")!).profiles.hero.mode).toBe("v9-core");
    expect(JSON.parse(files.get("metadata/chat_1.json")!).storyPlan.enabled).toBe(true);
    expect(JSON.parse(files.get("metadata/chat_2.json")!).npcBank).toEqual([]);
  });

  test("importBackup rejects files that are not suite backups", async () => {
    await expect(importBackup({ format: "nope" }, "u1")).rejects.toThrow();
    await expect(importBackup({ format: "megumin-suite-backup" }, "u1")).rejects.toThrow();
    await expect(importBackup(null, "u1")).rejects.toThrow();
  });

  test("importBackup leaves chats the backup never saw alone", async () => {
    const backup = await exportBackup("u1");
    files.delete("metadata/chat_2.json");
    files.set("metadata/chat_3.json", JSON.stringify({ keep: "me" }));
    const slim = { ...backup, metadata: { chat_1: (backup.metadata as any).chat_1 } };
    const result = await importBackup(slim, "u1");
    expect(result.importedChats).toBe(1);
    expect(JSON.parse(files.get("metadata/chat_3.json")!).keep).toBe("me");
    expect(files.has("metadata/chat_2.json")).toBe(false);
  });
});
