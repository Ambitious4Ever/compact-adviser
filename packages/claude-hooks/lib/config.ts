// Settings for the command-hook adapter. Each value is read, first match wins, from:
//   1. a plain environment variable (COMPACT_ADVISER_* or OPENROUTER_API_KEY),
//   2. the plugin's /config option, which Claude Code hands hooks as CLAUDE_PLUGIN_OPTION_<KEY>,
//   3. ~/.claude/compact-adviser/config.json,
// and the API key additionally from OPENROUTER_API_KEY in a .env file in the project directory.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseDotenvKey } from "./env.ts";
import { DEFAULT_MODEL } from "./judge.ts";

export type Mode = "hint" | "off";

export interface Config {
  mode: Mode;
  minContextTokens: number;
  /** The denominator for context pressure: Claude Code's auto-compact point or the window. */
  contextLimitTokens: number;
  contextBudgetTokens: number;
  model: string;
  logRequests: boolean;
  profile: string;
}

export const DEFAULTS: Config = {
  mode: "hint",
  minContextTokens: 40000,
  contextLimitTokens: 200000,
  contextBudgetTokens: 0,
  model: DEFAULT_MODEL,
  logRequests: false,
  profile: "",
};

export type Env = Record<string, string | undefined>;

export function dataDir(env: Env = process.env): string {
  return env.COMPACT_ADVISER_HOME?.trim() || join(homedir(), ".claude", "compact-adviser");
}

function readJson(path: string): Record<string, unknown> {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

const snake = (key: string) => key.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase();

/** The first non-empty raw value for a setting, as a string. */
function raw(key: string, env: Env, file: Record<string, unknown>): string | undefined {
  for (const value of [
    env[`COMPACT_ADVISER_${snake(key)}`],
    env[`CLAUDE_PLUGIN_OPTION_${key.toUpperCase()}`],
    env[`CLAUDE_PLUGIN_OPTION_${snake(key)}`],
    env[`CLAUDE_PLUGIN_OPTION_${key}`],
    file[key] === undefined ? undefined : String(file[key]),
  ]) {
    if (value !== undefined && value.trim() !== "") return value.trim();
  }
  return undefined;
}

function count(value: string | undefined, fallback: number, min: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= min ? n : fallback;
}

export function loadConfig(env: Env = process.env): Config {
  const file = readJson(join(dataDir(env), "config.json"));
  const mode = raw("mode", env, file);
  const log = raw("logRequests", env, file);
  return {
    mode: mode === "off" ? "off" : "hint",
    minContextTokens: count(raw("minContextTokens", env, file), DEFAULTS.minContextTokens, 1),
    contextLimitTokens: count(raw("contextLimitTokens", env, file), DEFAULTS.contextLimitTokens, 1),
    contextBudgetTokens: count(
      raw("contextBudgetTokens", env, file),
      DEFAULTS.contextBudgetTokens,
      0,
    ),
    model: raw("model", env, file) ?? DEFAULTS.model,
    logRequests: log === "true" || log === "1",
    profile: raw("profile", env, file) ?? "",
  };
}

/** OPENROUTER_API_KEY from the environment, plugin options, config file, then a project .env. */
export function loadApiKey(env: Env = process.env, cwd?: string): string | undefined {
  const plain = env.OPENROUTER_API_KEY?.trim();
  if (plain) return plain;
  const fromConfig = raw("openrouterApiKey", env, readJson(join(dataDir(env), "config.json")));
  if (fromConfig) return fromConfig;
  if (!cwd) return undefined;
  try {
    return parseDotenvKey(readFileSync(join(cwd, ".env"), "utf8"), "OPENROUTER_API_KEY")?.trim();
  } catch {
    return undefined;
  }
}
