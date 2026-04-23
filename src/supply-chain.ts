// ---------------------------------------------------------------------------
// supply-chain.ts — Enhanced dependency change analysis for DeployGuard
//
// Experiment: experiment/rd-satellite/deployguard-supply-chain-risk
// Hypothesis: Parsing package.json diffs reveals package-level supply-chain
//             risk signals (new packages, major bumps, critical-scope changes)
//             that the current file-level detector completely misses.
//
// Design: pure static analysis — no external API calls, works in every env.
// ---------------------------------------------------------------------------

export interface PackageChange {
  name: string;
  /** null = new package (no prior version) */
  fromVersion: string | null;
  /** null = removed package */
  toVersion: string | null;
  changeType: "added" | "removed" | "updated";
  isMajorBump: boolean;
  /** true for packages that touch auth/crypto/secrets/payments */
  isCriticalScope: boolean;
  /** true if package name matches known supply-chain bait patterns */
  isSuspiciousName: boolean;
}

export interface SupplyChainAnalysis {
  packages: PackageChange[];
  addedCount: number;
  removedCount: number;
  updatedCount: number;
  majorBumpCount: number;
  criticalScopeCount: number;
  suspiciousCount: number;
  riskScore: number;
  riskSignals: string[];
}

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

/** Packages that handle auth, crypto, payments, secrets — higher blast radius */
const CRITICAL_SCOPE_PATTERNS = [
  /^(passport|passport-)/i,
  /^(jsonwebtoken|jwt-|jose|oidc-)/i,
  /^(crypto-|node-forge|openpgp)/i,
  /^(stripe|braintree|paypal|square|paddle)/i,
  /^(aws-sdk|@aws-sdk\/)/i,
  /^(googleapis|@google-cloud\/)/i,
  /^(firebase|@firebase\/)/i,
  /^(express|fastify|hono|koa|next|nuxt)\b/i,
  /^(prisma|@prisma\/|typeorm|sequelize|drizzle)/i,
  /^(dotenv|env-|secret-)/i,
  /^(ssh2|node-ssh|shelljs|execa|child_process)/i,
];

/**
 * Known supply-chain bait patterns: typosquats of popular packages,
 * suspicious naming conventions often used in injection attacks.
 * This is not exhaustive — a real impl would query an advisory DB.
 */
const SUSPICIOUS_NAME_PATTERNS = [
  // typosquats of common packages
  /^(colours?|colour-theme|coloer)/i, // 'colors' typosquats
  /^(loadash|lodash-utils|lo_dash)/i, // 'lodash' typosquats
  /^(expresss?js|express-core|expressjs)/i, // 'express' typosquats
  /^(axois|axeos|axois-http)/i, // 'axios' typosquats
  /^(reacct|reactt|react-native-core)/i, // 'react' typosquats
  // suspicious structural patterns
  /^[a-z]-[a-z]-[a-z]-[a-z]/i, // single-letter segment chains (e.g., "a-b-c-d")
  /setup|install|postinstall|lifecycle/i, // lifecycle hook bait
  /updater|patcher|hotfix|security-fix/i, // urgent-sounding names
];

// ---------------------------------------------------------------------------
// Semver helpers
// ---------------------------------------------------------------------------

/**
 * Extract major version number from a semver range string.
 * Handles: "^1.2.3", "~1.2.3", "1.2.3", ">=1.0.0", "1.x", "*"
 * Returns null if unparseable.
 */
export function extractMajorVersion(version: string): number | null {
  const cleaned = version.replace(/^[\^~>=<v\s]+/, "").trim();
  const match = cleaned.match(/^(\d+)/);
  if (!match) return null;
  return parseInt(match[1], 10);
}

export function isMajorVersionBump(from: string, to: string): boolean {
  const fromMajor = extractMajorVersion(from);
  const toMajor = extractMajorVersion(to);
  if (fromMajor === null || toMajor === null) return false;
  return toMajor > fromMajor;
}

// ---------------------------------------------------------------------------
// Package.json diff parser
// ---------------------------------------------------------------------------

/** Matches `"package-name": "version"` in a diff line */
const PKG_LINE_RE =
  /^[+-]\s+"(@?[a-z0-9][a-z0-9._\-/]*)"\s*:\s*"([^"]+)"/i;

interface RawLine {
  added: boolean;
  name: string;
  version: string;
}

/**
 * Parse a unified diff patch of package.json.
 * Returns lists of added and removed dependency lines.
 * Only looks at lines inside dependency sections (dependencies,
 * devDependencies, peerDependencies, optionalDependencies).
 */
export function parsePkgJsonDiff(patch: string): PackageChange[] {
  const lines = patch.split("\n");
  const removed = new Map<string, string>(); // name → old version
  const added = new Map<string, string>(); // name → new version

  let inDepSection = false;
  for (const line of lines) {
    // Track whether we're inside a dependency section
    const contextLine = line.replace(/^[+-]/, " ");
    if (
      /"(dependencies|devDependencies|peerDependencies|optionalDependencies)"\s*:\s*\{/.test(
        contextLine,
      )
    ) {
      inDepSection = true;
    }
    if (inDepSection && /^\s*\}/.test(contextLine)) {
      inDepSection = false;
    }

    if (!inDepSection) continue;

    const match = line.match(PKG_LINE_RE);
    if (!match) continue;

    const isAdd = line.startsWith("+");
    const isRem = line.startsWith("-");
    if (!isAdd && !isRem) continue;

    const name = match[1];
    const version = match[2];
    if (isAdd) added.set(name, version);
    if (isRem) removed.set(name, version);
  }

  const changes: PackageChange[] = [];
  const allNames = new Set([...added.keys(), ...removed.keys()]);

  for (const name of allNames) {
    const toVersion = added.get(name) ?? null;
    const fromVersion = removed.get(name) ?? null;

    let changeType: PackageChange["changeType"];
    if (toVersion && !fromVersion) changeType = "added";
    else if (!toVersion && fromVersion) changeType = "removed";
    else changeType = "updated";

    const isMajorBump =
      changeType === "updated" && fromVersion !== null && toVersion !== null
        ? isMajorVersionBump(fromVersion, toVersion)
        : false;

    const isCriticalScope = CRITICAL_SCOPE_PATTERNS.some((p) => p.test(name));
    const isSuspiciousName = SUSPICIOUS_NAME_PATTERNS.some((p) => p.test(name));

    changes.push({
      name,
      fromVersion,
      toVersion,
      changeType,
      isMajorBump,
      isCriticalScope,
      isSuspiciousName,
    });
  }

  return changes;
}

// ---------------------------------------------------------------------------
// Risk scorer
// ---------------------------------------------------------------------------

/**
 * Score a set of package changes. Returns 0–100.
 *
 * Scoring rationale:
 *  - Each added package: +8 baseline risk (new attack surface)
 *  - Major version bump: +12 (breaking changes, potential behavior shifts)
 *  - Critical-scope package added/bumped: +15 extra (auth, crypto, payments)
 *  - Suspicious package name: +30 (potential typosquat / injection)
 *  - Pure lockfile update (manifest unchanged): low baseline
 */
export function scorePackageChanges(packages: PackageChange[]): {
  score: number;
  signals: string[];
} {
  let score = 0;
  const signals: string[] = [];

  const added = packages.filter((p) => p.changeType === "added");
  const removed = packages.filter((p) => p.changeType === "removed");
  const updated = packages.filter((p) => p.changeType === "updated");
  const majorBumps = packages.filter((p) => p.isMajorBump);
  const criticalAdded = packages.filter(
    (p) => p.changeType === "added" && p.isCriticalScope,
  );
  const suspicious = packages.filter((p) => p.isSuspiciousName);

  // Base: new packages
  if (added.length > 0) {
    score += added.length * 8;
    signals.push(
      `${added.length} new package${added.length > 1 ? "s" : ""} added: ${added.map((p) => p.name).join(", ")}`,
    );
  }

  // Major version bumps
  if (majorBumps.length > 0) {
    score += majorBumps.length * 12;
    signals.push(
      `${majorBumps.length} major version bump${majorBumps.length > 1 ? "s" : ""}: ` +
        majorBumps.map((p) => `${p.name} ${p.fromVersion}→${p.toVersion}`).join(", "),
    );
  }

  // Critical-scope additions
  if (criticalAdded.length > 0) {
    score += criticalAdded.length * 15;
    signals.push(
      `Critical-scope package${criticalAdded.length > 1 ? "s" : ""} added: ${criticalAdded.map((p) => p.name).join(", ")} — review carefully`,
    );
  }

  // Suspicious names
  if (suspicious.length > 0) {
    score += suspicious.length * 30;
    signals.push(
      `⚠️  Suspicious package name${suspicious.length > 1 ? "s" : ""}: ${suspicious.map((p) => p.name).join(", ")} — possible typosquat`,
    );
  }

  // Removals are generally neutral but flag if critical scope
  const criticalRemoved = removed.filter((p) => p.isCriticalScope);
  if (criticalRemoved.length > 0) {
    score += criticalRemoved.length * 5;
    signals.push(
      `Critical-scope package${criticalRemoved.length > 1 ? "s" : ""} removed: ${criticalRemoved.map((p) => p.name).join(", ")}`,
    );
  }

  // Many updates at once can mask a malicious change
  if (updated.length > 10) {
    score += 10;
    signals.push(`Large batch update: ${updated.length} packages updated — verify each`);
  }

  return { score: Math.min(100, score), signals };
}

// ---------------------------------------------------------------------------
// Main exported analyser
// ---------------------------------------------------------------------------

/**
 * Analyse supply-chain risk from a package.json diff patch.
 * Returns null if no package.json patch is provided.
 */
export function analyseSupplyChain(patch: string | null | undefined): SupplyChainAnalysis | null {
  if (!patch) return null;

  const packages = parsePkgJsonDiff(patch);
  if (packages.length === 0) return null;

  const { score, signals } = scorePackageChanges(packages);

  return {
    packages,
    addedCount: packages.filter((p) => p.changeType === "added").length,
    removedCount: packages.filter((p) => p.changeType === "removed").length,
    updatedCount: packages.filter((p) => p.changeType === "updated").length,
    majorBumpCount: packages.filter((p) => p.isMajorBump).length,
    criticalScopeCount: packages.filter((p) => p.isCriticalScope).length,
    suspiciousCount: packages.filter((p) => p.isSuspiciousName).length,
    riskScore: score,
    riskSignals: signals,
  };
}
