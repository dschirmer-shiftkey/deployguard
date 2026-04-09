import { describe, it, expect, beforeEach } from "vitest";
import {
  registerHealer,
  attemptRepair,
  getHealerFor,
  clearHealers,
} from "../healers/index.js";
import { jestHealer } from "../healers/jest.js";
import { playwrightHealer } from "../healers/playwright.js";
import { cypressHealer } from "../healers/cypress.js";

beforeEach(() => {
  clearHealers();
  registerHealer(jestHealer);
  registerHealer(playwrightHealer);
  registerHealer(cypressHealer);
});

// ---------------------------------------------------------------------------
// Healer registry
// ---------------------------------------------------------------------------

describe("healer registry", () => {
  it("routes .test.ts files to the jest healer", () => {
    const healer = getHealerFor("src/app.test.ts", "some error");
    expect(healer?.name).toBe("jest");
  });

  it("routes .spec.ts files to the playwright healer", () => {
    const healer = getHealerFor("tests/login.spec.ts", "some error");
    expect(healer?.name).toBe("playwright");
  });

  it("routes .cy.ts files to the cypress healer", () => {
    const healer = getHealerFor("cypress/e2e/home.cy.ts", "some error");
    expect(healer?.name).toBe("cypress");
  });

  it("returns undefined for unrecognised files", () => {
    const healer = getHealerFor("src/utils.ts", "some error");
    expect(healer).toBeUndefined();
  });

  it("attemptRepair returns null for unrecognised files", async () => {
    const result = await attemptRepair("src/utils.ts", "some error");
    expect(result).toBeNull();
  });

  it("attemptRepair delegates to matching healer and returns result", async () => {
    const result = await attemptRepair(
      "src/app.test.ts",
      'Snapshot "renders correctly" mismatched',
    );
    expect(result).not.toBeNull();
    expect(result!.success).toBe(true);
    expect(result!.testFile).toBe("src/app.test.ts");
  });
});

// ---------------------------------------------------------------------------
// Jest healer
// ---------------------------------------------------------------------------

describe("jestHealer", () => {
  it("detects snapshot mismatch failures", async () => {
    const result = await jestHealer.repair(
      "src/app.test.ts",
      'Snapshot "renders correctly" mismatched',
    );
    expect(result.failureType).toBe("snapshot-mismatch");
    expect(result.success).toBe(true);
    expect(result.diff).toContain("--updateSnapshot");
  });

  it("detects mock drift failures", async () => {
    const result = await jestHealer.repair(
      "src/api.test.ts",
      "TypeError: fetchUser is not a function",
    );
    expect(result.failureType).toBe("mock-drift");
    expect(result.success).toBe(true);
    expect(result.diff).toContain("fetchUser");
  });

  it("detects import resolution failures", async () => {
    const result = await jestHealer.repair(
      "src/api.test.ts",
      "Cannot find module './oldPath/utils'",
    );
    expect(result.failureType).toBe("import-resolution");
    expect(result.success).toBe(true);
    expect(result.diff).toContain("./oldPath/utils");
  });

  it("returns success:false for mock-drift without specific function pattern", async () => {
    const result = await jestHealer.repair(
      "src/app.test.ts",
      "TypeError: is not a function",
    );
    expect(result.failureType).toBe("mock-drift");
    expect(result.success).toBe(false);
  });

  it("returns success:false for unknown failures", async () => {
    const result = await jestHealer.repair(
      "src/app.test.ts",
      "RangeError: Maximum call stack size exceeded",
    );
    expect(result.failureType).toBe("unknown");
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Playwright healer
// ---------------------------------------------------------------------------

describe("playwrightHealer", () => {
  it("detects selector drift failures", async () => {
    const result = await playwrightHealer.repair(
      "tests/login.spec.ts",
      "locator.click resolved to 0 elements",
    );
    expect(result.failureType).toBe("selector-drift");
    expect(result.success).toBe(true);
    expect(result.diff).toContain("data-testid");
  });

  it("detects timeout failures", async () => {
    const result = await playwrightHealer.repair(
      "tests/login.spec.ts",
      "Timeout 30000ms exceeded while waiting for selector",
    );
    expect(result.failureType).toBe("timeout");
    expect(result.success).toBe(true);
    expect(result.diff).toContain("setTimeout");
  });

  it("detects navigation failures", async () => {
    const result = await playwrightHealer.repair(
      "tests/login.spec.ts",
      "page.goto failed: net::ERR_CONNECTION_REFUSED",
    );
    expect(result.failureType).toBe("navigation-failure");
    expect(result.success).toBe(true);
    expect(result.diff).toContain("base URL");
  });

  it("extracts specific selector from error message", async () => {
    const result = await playwrightHealer.repair(
      "tests/login.spec.ts",
      "waiting for locator('#submit-btn') to be visible",
    );
    expect(result.failureType).toBe("selector-drift");
    expect(result.diff).toContain("#submit-btn");
  });

  it("defaults timeout to 30000ms when specific value not parseable", async () => {
    const result = await playwrightHealer.repair(
      "tests/login.spec.ts",
      "Test timeout of 5000ms exceeded",
    );
    expect(result.failureType).toBe("timeout");
    expect(result.success).toBe(true);
    expect(result.diff).toContain("30000ms");
    expect(result.diff).toContain("60000");
  });

  it("returns success:false for unknown failures", async () => {
    const result = await playwrightHealer.repair(
      "tests/login.spec.ts",
      "Unexpected token in JSON",
    );
    expect(result.failureType).toBe("unknown");
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cypress healer
// ---------------------------------------------------------------------------

describe("cypressHealer", () => {
  it("detects selector drift failures", async () => {
    const result = await cypressHealer.repair(
      "cypress/e2e/home.cy.ts",
      "Timed out retrying after 4000ms: cy.get('.old-class') - Expected to find element",
    );
    expect(result.failureType).toBe("selector-drift");
    expect(result.success).toBe(true);
    expect(result.diff).toContain("data-cy");
  });

  it("detects intercept drift failures", async () => {
    const result = await cypressHealer.repair(
      "cypress/e2e/api.cy.ts",
      "cy.wait() timed out waiting 5000ms for alias '@getUsers'. No request ever occurred.",
    );
    expect(result.failureType).toBe("intercept-drift");
    expect(result.success).toBe(true);
    expect(result.diff).toContain("getUsers");
  });

  it("detects timeout failures", async () => {
    const result = await cypressHealer.repair(
      "cypress/e2e/home.cy.ts",
      "CypressError: Timed out retrying after 4000ms",
    );
    expect(result.failureType).toBe("timeout");
    expect(result.success).toBe(true);
    expect(result.diff).toContain("8000");
  });

  it("handles selector drift without matching selector pattern", async () => {
    const result = await cypressHealer.repair(
      "cypress/e2e/home.cy.ts",
      "Expected to find element but never found it",
    );
    expect(result.failureType).toBe("selector-drift");
    expect(result.diff).toContain("(unknown selector)");
  });

  it("handles intercept drift with cy.wait('@alias') pattern", async () => {
    const result = await cypressHealer.repair(
      "cypress/e2e/api.cy.ts",
      "cy.wait('@getUsers') timed out. cy.intercept needed.",
    );
    expect(result.failureType).toBe("intercept-drift");
    expect(result.diff).toContain("getUsers");
  });

  it("handles intercept drift without matching alias pattern", async () => {
    const result = await cypressHealer.repair(
      "cypress/e2e/api.cy.ts",
      "No request ever occurred for the intercept",
    );
    expect(result.failureType).toBe("intercept-drift");
    expect(result.diff).toContain("(unknown)");
  });

  it("defaults timeout to 4000ms when specific ms not found", async () => {
    const result = await cypressHealer.repair(
      "cypress/e2e/home.cy.ts",
      "CypressError: timeout exceeded",
    );
    expect(result.failureType).toBe("timeout");
    expect(result.diff).toContain("4000ms");
    expect(result.diff).toContain("8000");
  });

  it("returns success:false for unknown failures", async () => {
    const result = await cypressHealer.repair(
      "cypress/e2e/home.cy.ts",
      "Uncaught SyntaxError: Unexpected identifier",
    );
    expect(result.failureType).toBe("unknown");
    expect(result.success).toBe(false);
  });
});
