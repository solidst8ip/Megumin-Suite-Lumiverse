// ─────────────────────────────────────────────────────────────────────────────
// Where the extension's data lives.
//
// SillyTavern split this two ways and core/profile.js was the only module that
// knew about the split: tab settings went to extension_settings, while the
// chat-scoped data (story plan, NPC bank) went to chat metadata. That split is
// worth keeping — settings follow the user, story data follows the chat — so it
// survives here, with both halves in spindle.storage:
//
//   settings -> settings.json
//   metadata -> metadata/<chatId>.json
//
// An earlier pass put the metadata half in spindle.variables.chat, on the
// reasoning that the host persists chat variables across regens and swipes,
// which is the durability chat_metadata had. That was wrong for a duller
// reason: it is one more host surface to be right about, and being wrong about
// a host surface is what stopped this extension loading twice. Storage is the
// one API every other part of the backend already depends on.
//
// The cost is that nothing tells an extension when a chat is deleted, so a
// deleted chat leaves its metadata file behind. That is a few KB of orphaned
// JSON, which is the cheaper failure.
//
// ── userId ───────────────────────────────────────────────────────────────────
//
// Every function here takes one, and most of them do nothing with it. That is
// deliberate. An operator-scoped install REQUIRES userId on the host calls that
// accept it — omitting it throws "userId is required for operator-scoped
// extensions", which is exactly how this failed — so the id has to be threaded
// from the RPC envelope all the way down regardless of which leaf happens to
// need it today. Taking the parameter everywhere means adding a call that does
// need it is a one-line change, not a re-plumbing.
// ─────────────────────────────────────────────────────────────────────────────

const SETTINGS_FILE = "settings.json";

const EMPTY_SETTINGS = {
    profiles: {},
    configPresets: [],
    globalSyncMap: {},
    customModes: [],
    globalSettings: {},
};

// The settings file is read on nearly every RPC and written on a debounce, so it
// is held in memory after the first read. The backend is the only writer, so the
// cache cannot go stale behind our back.
let settingsCache = null;

export async function loadSettings(userId) {
    if (settingsCache) return settingsCache;

    let stored = null;
    try {
        stored = JSON.parse(await spindle.storage.read(SETTINGS_FILE));
    } catch (e) {
        stored = null; // absent or unreadable — start from the defaults
    }

    settingsCache = stored || JSON.parse(JSON.stringify(EMPTY_SETTINGS));

    // Fill in keys a settings file written by an older build may not have, so
    // readers never have to guard for them.
    for (const [key, value] of Object.entries(EMPTY_SETTINGS)) {
        if (settingsCache[key] === undefined) settingsCache[key] = JSON.parse(JSON.stringify(value));
    }

    return settingsCache;
}

export async function saveSettings(next, userId) {
    settingsCache = next || JSON.parse(JSON.stringify(EMPTY_SETTINGS));
    await spindle.storage.write(SETTINGS_FILE, JSON.stringify(settingsCache, null, 2));

    // Which profile keys exist after the write. This is the line to read when
    // the symptom is "my settings did not take": compare the key named here with
    // the one the interceptor reports resolving, below in engine/context.js. A
    // mismatch between them means the UI saved under one identity and the prompt
    // builder looked up another.
    spindle.log.info(
        `[Megumin Suite] settings written; profiles: ${Object.keys(settingsCache.profiles || {}).join(", ") || "(none)"}`,
    );

    return { ok: true, profiles: Object.keys(settingsCache.profiles || {}) };
}

// -------------------------------------------------------------
// Chat-scoped metadata
// -------------------------------------------------------------

// A chat id is user-supplied as far as this module is concerned, and it becomes
// part of a path. Spindle blocks traversal itself, but a slash would still
// scatter one chat's metadata across directories, so it is flattened here.
function metadataPath(chatId) {
    return `metadata/${String(chatId).replace(/[^A-Za-z0-9_-]/g, "_")}.json`;
}

export async function loadMetadata(chatId, userId) {
    if (!chatId) return {};

    try {
        return JSON.parse(await spindle.storage.read(metadataPath(chatId)));
    } catch (e) {
        // Absent is the normal case for a chat this extension has not touched.
        // Unreadable is not, but refusing to load would leave the tab broken for
        // that chat forever, so both start clean.
        return {};
    }
}

export async function saveMetadata(chatId, metadata, userId) {
    if (!chatId) return;
    await spindle.storage.write(metadataPath(chatId), JSON.stringify(metadata || {}, null, 2));
}

// -------------------------------------------------------------
// Backup & restore
// -------------------------------------------------------------
//
// Moving between installs of the suite — the original release and a fork, a
// fresh browser profile, a host that wiped storage on reinstall — needs the
// whole data set, not just the settings file: profiles and image-gen config
// live in settings.json, while story plans and the NPC bank live per-chat
// under metadata/. The frontend's Backup button calls exportBackup and hands
// the user one JSON file; Restore feeds it to importBackup.
//
// Same-identifier installs (the fork keeps "megumin_suite") already share
// spindle.storage, so this is the belt to those braces: it also covers the
// cases where the host did not preserve storage across the move.

const BACKUP_FORMAT = "megumin-suite-backup";
const BACKUP_VERSION = 1;

export async function exportBackup(userId) {
    const settings = await loadSettings(userId);

    let files = [];
    try {
        files = await spindle.storage.list("metadata/").catch(() => []);
    } catch (e) {
        files = [];
    }

    const metadata = {};
    for (const file of files) {
        const name = String(file).replace(/^metadata\//, "");
        if (!name.endsWith(".json")) continue;
        try {
            metadata[name.slice(0, -5)] = JSON.parse(await spindle.storage.read(`metadata/${name}`));
        } catch (e) {
            // A chat whose metadata does not parse is skipped, not fatal: one
            // corrupt chat must not void the whole backup.
        }
    }

    return {
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        exportedAt: new Date().toISOString(),
        settings,
        metadata,
    };
}

export async function importBackup(backup, userId) {
    if (!backup || backup.format !== BACKUP_FORMAT || !backup.settings || typeof backup.settings !== "object") {
        throw new Error("That file is not a Megumin Suite settings backup.");
    }
    const incomingMetadata = backup.metadata && typeof backup.metadata === "object" ? backup.metadata : {};

    // Settings are replaced wholesale, then re-keyed through the same
    // defaults fill loadSettings applies, so a backup from an older build
    // still yields a complete settings object.
    settingsCache = null;
    await saveSettings(backup.settings, userId);
    await loadSettings(userId);

    // Per-chat metadata: chats present in the backup overwrite; chats the
    // backup never saw are left alone.
    let importedChats = 0;
    for (const [chatKey, data] of Object.entries(incomingMetadata)) {
        const stem = String(chatKey).replace(/[^A-Za-z0-9_-]/g, "_");
        if (!stem || data === null || typeof data !== "object") continue;
        await spindle.storage.write(`metadata/${stem}.json`, JSON.stringify(data, null, 2));
        importedChats += 1;
    }

    spindle.log.info(`[Megumin Suite] backup imported; ${importedChats} chat(s) restored.`);
    return { ok: true, importedChats };
}

// -------------------------------------------------------------
// Active chat
// -------------------------------------------------------------

// The chat the user is looking at, or null when they are in the lobby.
//
// spindle.chats.getActive() is documented as reading "the activeChatId setting
// that the frontend persists whenever the user opens or closes a chat", and in
// practice it keeps returning the last chat after the user goes back to the
// home screen. That made the lobby behave as though the last character were
// still open: the prompt engine resolved that character's profile, and the
// settings window drew their portrait behind its header.
//
// CHAT_SWITCHED is the authoritative signal — it fires with chatId null on the
// way to the home screen — so the event wins wherever we have heard one, and
// getActive() is only the fallback for the window before the first event
// arrives (an extension reload mid-session, say).
//
// Tracked per user because an operator-scoped install serves several, and one
// user opening a chat must not move everyone else's.
const activeChatByUser = new Map();
let sawSwitchEvent = false;

export function trackActiveChat(userId, chatId) {
    sawSwitchEvent = true;
    activeChatByUser.set(userId || "__self__", chatId || null);
}

export async function getActiveChatId(userId) {
    const cacheKey = userId || "__self__";
    if (activeChatByUser.has(cacheKey)) return activeChatByUser.get(cacheKey);

    // A switch has been seen for somebody, but not this user. Trusting
    // getActive() here is what would resurrect the lobby bug, so answer "no
    // chat" rather than guess.
    if (sawSwitchEvent && userId) return null;

    try {
        const chat = await spindle.chats.getActive(userId);
        return chat ? chat.id : null;
    } catch (e) {
        return null;
    }
}
