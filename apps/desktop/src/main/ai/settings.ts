import { app, safeStorage } from "electron";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { usesFallback } from "./anthropic.js";
import { DEFAULT_AI_SETTINGS, type AiSettings, type AiSettingsUpdate, type AiSettingsView } from "../../shared/ai.js";

/**
 * AI settings: format, endpoint, model and effort in userData/ai-settings.json;
 * the API key encrypted with the OS keychain (safeStorage). When the OS has no
 * secure store (Linux without a keyring falls back to "basic_text", which is
 * not encryption), the key is kept in memory for this session only and never
 * written to disk.
 */

interface Stored extends AiSettings {
  /** base64 of safeStorage.encryptString(key). */
  encryptedKey?: string;
}

const FORMATS = new Set(["anthropic", "openai-compatible"]);
const EFFORTS = new Set(["default", "low", "medium", "high"]);

let cache: Stored | null = null;
let sessionKey: string | null = null;

const file = (): string => join(app.getPath("userData"), "ai-settings.json");

export function secureStorageAvailable(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false;
  if (process.platform === "linux") {
    const backend = safeStorage.getSelectedStorageBackend();
    if (backend === "basic_text" || backend === "unknown") return false;
  }
  return true;
}

function load(): Stored {
  if (cache) return cache;
  let raw: Partial<Stored> = {};
  try {
    raw = JSON.parse(readFileSync(file(), "utf8")) as Partial<Stored>;
  } catch {
    // no file yet, or unreadable: defaults
  }
  cache = {
    format: FORMATS.has(raw.format as string) ? raw.format! : DEFAULT_AI_SETTINGS.format,
    baseUrl: typeof raw.baseUrl === "string" ? raw.baseUrl : DEFAULT_AI_SETTINGS.baseUrl,
    model: typeof raw.model === "string" && raw.model.trim() ? raw.model : DEFAULT_AI_SETTINGS.model,
    effort: EFFORTS.has(raw.effort as string) ? raw.effort! : DEFAULT_AI_SETTINGS.effort,
    vision: typeof raw.vision === "boolean" ? raw.vision : DEFAULT_AI_SETTINGS.vision,
    ...(typeof raw.encryptedKey === "string" ? { encryptedKey: raw.encryptedKey } : {}),
  };
  return cache;
}

export function getSettings(): AiSettings {
  const { format, baseUrl, model, effort, vision } = load();
  return { format, baseUrl, model, effort, vision };
}

export function getApiKey(): string | null {
  if (sessionKey !== null) return sessionKey;
  const enc = load().encryptedKey;
  if (!enc || !secureStorageAvailable()) return null;
  try {
    return safeStorage.decryptString(Buffer.from(enc, "base64"));
  } catch {
    return null; // keychain changed or entry unreadable: ask for the key again
  }
}

export function view(): AiSettingsView {
  const s = getSettings();
  return {
    ...s,
    hasKey: getApiKey() !== null,
    keyStorage: secureStorageAvailable() ? "keychain" : "session",
    serverFallback: s.format === "anthropic" && usesFallback(s),
  };
}

/** Validates renderer input: it crosses the IPC boundary. */
export function parseUpdate(u: unknown): AiSettingsUpdate {
  const o = (u ?? {}) as Record<string, unknown>;
  if (!FORMATS.has(o.format as string)) throw new Error("Unknown API format.");
  if (!EFFORTS.has(o.effort as string)) throw new Error("Unknown effort level.");
  if (typeof o.model !== "string" || !o.model.trim() || o.model.length > 200) throw new Error("Enter a model name.");
  if (typeof o.baseUrl !== "string" || o.baseUrl.length > 500) throw new Error("Invalid base URL.");
  const baseUrl = o.baseUrl.trim();
  if (baseUrl) {
    let url: URL;
    try {
      url = new URL(baseUrl);
    } catch {
      throw new Error("The base URL is not a valid URL.");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("The base URL must start with https:// or http://.");
  }
  if (typeof o.vision !== "boolean") throw new Error("Invalid image setting.");
  const update: AiSettingsUpdate = { format: o.format as AiSettings["format"], baseUrl, model: o.model.trim(), effort: o.effort as AiSettings["effort"], vision: o.vision };
  if (o.apiKey === null) update.apiKey = null;
  else if (typeof o.apiKey === "string") {
    if (o.apiKey.length > 1000) throw new Error("The API key is too long.");
    update.apiKey = o.apiKey.trim();
  }
  return update;
}

export async function saveSettings(u: AiSettingsUpdate): Promise<AiSettingsView> {
  const next: Stored = { format: u.format, baseUrl: u.baseUrl, model: u.model, effort: u.effort, vision: u.vision };
  const prev = load();
  if (u.apiKey === undefined) {
    if (prev.encryptedKey) next.encryptedKey = prev.encryptedKey;
  } else if (u.apiKey === null || u.apiKey === "") {
    sessionKey = null;
  } else if (secureStorageAvailable()) {
    next.encryptedKey = safeStorage.encryptString(u.apiKey).toString("base64");
    sessionKey = null;
  } else {
    sessionKey = u.apiKey;
  }
  await mkdir(dirname(file()), { recursive: true });
  await writeFile(file(), `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  cache = next;
  return view();
}
