import { API } from "@discordjs/core";
import { REST } from "@discordjs/rest";
import { loadConfig } from "../src/config.ts";

export function setup() {
  const config = loadConfig();
  const rest = new REST({ version: "10" }).setToken(config.token);
  return { config, rest, api: new API(rest) };
}

export function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export function devOnly(production: boolean, script: string): void {
  if (production) {
    console.error(`${script} is a dev-only probe and refuses to run with NODE_ENV=production.`);
    process.exit(2);
  }
}
