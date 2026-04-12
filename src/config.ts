import * as core from "@actions/core";
import * as github from "@actions/github";
import { RepoConfig } from "./types.js";
import type { RepoConfig as RepoConfigType } from "./types.js";

const yamlParse: ((input: string) => unknown) | null = null;

function parseYaml(input: string): unknown {
  if (yamlParse) return yamlParse(input);

  const lines = input.split("\n");
  const result: Record<string, unknown> = {};
  let currentKey = "";
  let currentArray: string[] | null = null;

  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    if (line.trim() === "" || line.trim().startsWith("#")) continue;

    const topMatch = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (topMatch) {
      if (currentKey && currentArray) {
        result[currentKey] = currentArray;
        currentArray = null;
      }
      const [, key, val] = topMatch;
      currentKey = key;
      if (val && val.trim()) {
        const numVal = Number(val.trim());
        result[key] = isNaN(numVal) ? val.trim() : numVal;
      }
      continue;
    }

    const nestedObjMatch = line.match(/^\s{2}(\w[\w-]*):\s*(.*)$/);
    if (nestedObjMatch) {
      if (currentArray) {
        result[currentKey] = currentArray;
        currentArray = null;
      }
      const [, subKey, subVal] = nestedObjMatch;
      if (typeof result[currentKey] !== "object" || Array.isArray(result[currentKey])) {
        result[currentKey] = {};
      }
      const obj = result[currentKey] as Record<string, unknown>;
      if (subVal && subVal.trim()) {
        const numVal = Number(subVal.trim());
        obj[subKey] = isNaN(numVal) ? subVal.trim() : numVal;
      } else {
        obj[subKey] = [];
      }
      continue;
    }

    const arrayItemMatch = line.match(/^\s+-\s+"?([^"]*)"?\s*$/);
    if (arrayItemMatch) {
      const val = arrayItemMatch[1];
      if (
        currentKey &&
        typeof result[currentKey] === "object" &&
        !Array.isArray(result[currentKey])
      ) {
        const obj = result[currentKey] as Record<string, unknown>;
        const keys = Object.keys(obj);
        const lastKey = keys[keys.length - 1];
        if (lastKey && Array.isArray(obj[lastKey])) {
          (obj[lastKey] as string[]).push(val);
        }
      } else {
        if (!currentArray) currentArray = [];
        currentArray.push(val);
      }
      continue;
    }
  }

  if (currentKey && currentArray) {
    result[currentKey] = currentArray;
  }

  return result;
}

export async function loadRepoConfig(token?: string): Promise<RepoConfigType | null> {
  if (!token) return null;

  try {
    const octokit = github.getOctokit(token);
    const { owner, repo } = github.context.repo;

    const { data } = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: ".deployguard.yml",
    });

    if (Array.isArray(data) || data.type !== "file" || !data.content) {
      return null;
    }

    const content = Buffer.from(data.content, "base64").toString("utf-8");
    const raw = parseYaml(content);
    const parsed = RepoConfig.safeParse(raw);

    if (!parsed.success) {
      core.warning(
        `.deployguard.yml parse error: ${parsed.error.message} — using defaults`,
      );
      return null;
    }

    core.debug(`Loaded .deployguard.yml: ${JSON.stringify(parsed.data)}`);
    return parsed.data;
  } catch (error) {
    const msg = String(error);
    if (!msg.includes("404") && !msg.includes("Not Found")) {
      core.debug(`.deployguard.yml load failed: ${msg}`);
    }
    return null;
  }
}

export { matchesGlobs } from "./risk-engine.js";
