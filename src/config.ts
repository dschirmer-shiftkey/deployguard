import * as core from "@actions/core";
import * as github from "@actions/github";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { RepoConfig } from "./types.js";
import type { RepoConfig as RepoConfigType } from "./types.js";

const yamlParse: ((input: string) => unknown) | null = null;
const CURRENT_CONFIG_SCHEMA_VERSION = 1;
const CONFIG_MIGRATION_GUIDE_URL =
  "https://github.com/KomatikAI/trailhead/blob/main/docs/roadmap-agent-qa.md";
const KNOWN_TOP_LEVEL_KEYS = new Set([
  "schema_version",
  "sensitivity",
  "weights",
  "thresholds",
  "ignore",
  "freeze",
  "environments",
  "services",
  "security",
  "canary",
  "policies",
]);

function parseYaml(input: string): unknown {
  if (yamlParse) return yamlParse(input);

  const lines = input
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.trim() !== "" && !line.trim().startsWith("#"));
  const root: Record<string, unknown> = {};
  const stack: Array<{ indent: number; value: unknown }> = [{ indent: -1, value: root }];

  const parseScalar = (value: string): unknown => {
    const v = value.trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      return v.slice(1, -1);
    }
    if (v === "true") return true;
    if (v === "false") return false;
    if (v === "null") return null;
    const n = Number(v);
    if (!Number.isNaN(n) && v !== "") return n;
    return v;
  };

  const findNextSignificantLine = (fromIndex: number): string | null => {
    for (let i = fromIndex + 1; i < lines.length; i += 1) {
      const candidate = lines[i];
      if (candidate.trim() !== "" && !candidate.trim().startsWith("#")) {
        return candidate;
      }
    }
    return null;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const indent = line.match(/^ */)?.[0].length ?? 0;
    const trimmed = line.trim();

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }
    const container = stack[stack.length - 1].value;

    if (trimmed.startsWith("- ")) {
      if (!Array.isArray(container)) continue;
      const itemRaw = trimmed.slice(2).trim();
      if (itemRaw === "") {
        const child: Record<string, unknown> = {};
        container.push(child);
        stack.push({ indent, value: child });
      } else {
        container.push(parseScalar(itemRaw));
      }
      continue;
    }

    const keyMatch = trimmed.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (
      !keyMatch ||
      typeof container !== "object" ||
      container === null ||
      Array.isArray(container)
    ) {
      continue;
    }

    const [, key, rawVal] = keyMatch;
    if (rawVal !== "") {
      (container as Record<string, unknown>)[key] = parseScalar(rawVal);
      continue;
    }

    const nextLine = findNextSignificantLine(i);
    const nextIndent = nextLine?.match(/^ */)?.[0].length ?? -1;
    const nextTrimmed = nextLine?.trim() ?? "";
    const useArray =
      nextLine !== null && nextIndent > indent && nextTrimmed.startsWith("- ");
    const child: unknown = useArray ? [] : {};
    (container as Record<string, unknown>)[key] = child;
    stack.push({ indent, value: child });
  }

  return root;
}

function warnUnknownTopLevelKeys(raw: unknown, configPath: string): void {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;

  for (const key of Object.keys(raw as Record<string, unknown>)) {
    if (!KNOWN_TOP_LEVEL_KEYS.has(key)) {
      core.warning(
        `${configPath}: unknown top-level key "${key}" will be ignored. ` +
          `See migration guide: ${CONFIG_MIGRATION_GUIDE_URL}`,
      );
    }
  }
}

function validateSchemaVersion(
  parsedConfig: RepoConfigType,
  configPath: string,
): RepoConfigType | null {
  if (parsedConfig.schema_version !== CURRENT_CONFIG_SCHEMA_VERSION) {
    core.warning(
      `${configPath}: unsupported schema_version=${parsedConfig.schema_version}. ` +
        `Expected ${CURRENT_CONFIG_SCHEMA_VERSION}. ` +
        `Migration guide: ${CONFIG_MIGRATION_GUIDE_URL}`,
    );
    return null;
  }

  return parsedConfig;
}

export async function loadRepoConfig(token?: string): Promise<RepoConfigType | null> {
  const localConfig = await loadLocalRepoConfig();
  if (localConfig) return localConfig;

  if (!token) return null;

  try {
    const octokit = github.getOctokit(token);
    const { owner, repo } = github.context.repo;

    const configPath = await findConfigPath(octokit, owner, repo);
    if (!configPath) return null;

    const { data } = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: configPath,
    });

    if (Array.isArray(data) || data.type !== "file" || !data.content) {
      return null;
    }

    const content = Buffer.from(data.content, "base64").toString("utf-8");
    const raw = parseYaml(content);
    warnUnknownTopLevelKeys(raw, configPath);
    const parsed = RepoConfig.safeParse(raw);

    if (!parsed.success) {
      core.warning(`${configPath} parse error: ${parsed.error.message} — using defaults`);
      return null;
    }

    const validated = validateSchemaVersion(parsed.data, configPath);
    if (!validated) return null;

    core.debug(`Loaded ${configPath}: ${JSON.stringify(validated)}`);
    return validated;
  } catch (error) {
    const msg = String(error);
    if (!msg.includes("404") && !msg.includes("Not Found")) {
      core.debug(`Trailhead config load failed: ${msg}`);
    }
    return null;
  }
}

async function loadLocalRepoConfig(): Promise<RepoConfigType | null> {
  const workspace = process.env.GITHUB_WORKSPACE;
  if (!workspace) return null;

  for (const configPath of [".trailhead.yml", ".deployguard.yml"]) {
    try {
      const content = await readFile(path.join(workspace, configPath), "utf-8");
      const raw = parseYaml(content);
      warnUnknownTopLevelKeys(raw, configPath);
      const parsed = RepoConfig.safeParse(raw);

      if (!parsed.success) {
        core.warning(
          `${configPath} parse error: ${parsed.error.message} — using defaults`,
        );
        return null;
      }

      const validated = validateSchemaVersion(parsed.data, configPath);
      if (!validated) return null;

      core.debug(`Loaded local ${configPath}: ${JSON.stringify(validated)}`);
      return validated;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        core.debug(`Local Trailhead config load failed: ${error}`);
        return null;
      }
    }
  }

  return null;
}

async function findConfigPath(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
): Promise<string | null> {
  for (const path of [".trailhead.yml", ".deployguard.yml"]) {
    try {
      await octokit.rest.repos.getContent({ owner, repo, path });
      return path;
    } catch (error) {
      const msg = String(error);
      if (!msg.includes("404") && !msg.includes("Not Found")) {
        throw error;
      }
    }
  }
  return null;
}

export { matchesGlobs } from "./risk-engine.js";
