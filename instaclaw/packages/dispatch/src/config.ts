import fs from "fs";
import path from "path";
import type { DispatchConfig } from "./types.js";

const CONFIG_DIR = path.join(process.env.HOME || "~", ".instaclaw-dispatch");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

export function loadConfig(): DispatchConfig | null {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
    }
  } catch {}
  return null;
}

export function saveConfig(config: DispatchConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

export function getConfigPath(): string {
  return CONFIG_FILE;
}
