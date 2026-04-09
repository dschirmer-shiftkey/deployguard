import type { TestHealer } from "./index.js";

const SNAPSHOT_PATTERN = /Snapshot .* mismatched|›.*Snapshot/i;
const IMPORT_PATTERN = /Cannot find module ['"]([^'"]+)['"]/i;
const MOCK_DRIFT_PATTERN = /TypeError:.*is not a function/i;

function detectFailureType(errorOutput: string): string {
  if (SNAPSHOT_PATTERN.test(errorOutput)) return "snapshot-mismatch";
  if (IMPORT_PATTERN.test(errorOutput)) return "import-resolution";
  if (MOCK_DRIFT_PATTERN.test(errorOutput)) return "mock-drift";
  return "unknown";
}

function repairSnapshot(testFile: string): { diff: string; success: boolean } {
  return {
    success: true,
    diff: [
      `--- Suggested fix for ${testFile}`,
      `+++ Run with --updateSnapshot flag`,
      ``,
      `Re-run the test with the snapshot update flag:`,
      `  npx jest ${testFile} --updateSnapshot`,
      ``,
      `Or update all snapshots:`,
      `  npx jest --updateSnapshot`,
    ].join("\n"),
  };
}

function repairMockDrift(
  testFile: string,
  errorOutput: string,
): { diff: string; success: boolean } {
  const moduleMatch = errorOutput.match(/Cannot find module ['"]([^'"]+)['"]/);
  const fnMatch = errorOutput.match(/TypeError: (\S+) is not a function/);

  if (moduleMatch) {
    const modulePath = moduleMatch[1];
    return {
      success: true,
      diff: [
        `--- ${testFile}`,
        `+++ ${testFile} (suggested)`,
        ``,
        `Module '${modulePath}' not found. Possible fixes:`,
        `  1. Update the import path if the module was moved/renamed`,
        `  2. Install the missing dependency: npm install ${modulePath}`,
        `  3. Update the mock to match the new module location`,
      ].join("\n"),
    };
  }

  if (fnMatch) {
    const fnName = fnMatch[1];
    return {
      success: true,
      diff: [
        `--- ${testFile}`,
        `+++ ${testFile} (suggested)`,
        ``,
        `'${fnName}' is not a function — the API may have changed.`,
        `Check the source module for renamed/removed exports and update the mock.`,
      ].join("\n"),
    };
  }

  return { success: false, diff: "" };
}

function repairImport(
  testFile: string,
  errorOutput: string,
): { diff: string; success: boolean } {
  const match = errorOutput.match(/Cannot find module ['"]([^'"]+)['"]/);
  if (!match) return { success: false, diff: "" };

  const modulePath = match[1];
  return {
    success: true,
    diff: [
      `--- ${testFile}`,
      `+++ ${testFile} (suggested)`,
      ``,
      `Import '${modulePath}' cannot be resolved.`,
      `  1. Check if the file was moved: git log --diff-filter=R --find-renames -- '${modulePath}'`,
      `  2. Update import path to match current file location`,
      `  3. If it's a new dependency, run: npm install ${modulePath}`,
    ].join("\n"),
  };
}

export const jestHealer: TestHealer = {
  name: "jest",

  canHandle(testFile: string, _errorOutput: string): boolean {
    return testFile.endsWith(".test.ts") || testFile.endsWith(".test.tsx");
  },

  async repair(testFile: string, errorOutput: string) {
    const failureType = detectFailureType(errorOutput);

    let result: { diff: string; success: boolean };
    switch (failureType) {
      case "snapshot-mismatch":
        result = repairSnapshot(testFile);
        break;
      case "mock-drift":
        result = repairMockDrift(testFile, errorOutput);
        break;
      case "import-resolution":
        result = repairImport(testFile, errorOutput);
        break;
      default:
        result = { success: false, diff: "" };
    }

    return {
      testFile,
      failureType,
      strategy: `jest-${failureType}`,
      success: result.success,
      diff: result.diff || undefined,
    };
  },
};
