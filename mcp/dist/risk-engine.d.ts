export interface FileInfo {
    filename: string;
    additions?: number;
    deletions?: number;
    changes: number;
}
export interface RiskFactorResult {
    type: string;
    score: number;
    detail?: Record<string, unknown>;
}
export interface SensitivityConfig {
    high: string[];
    medium: string[];
    low: string[];
}
export interface RiskConfig {
    sensitivity?: SensitivityConfig;
    weights?: Record<string, number>;
    ignore?: string[];
}
export interface SecurityAlertCounts {
    critical: number;
    high: number;
    medium: number;
    low: number;
    total: number;
    topRules?: string[];
}
export interface DeploymentOutcomeSummary {
    recentFailures: number;
    recentTotal: number;
    lastDeployFailed: boolean;
    lastRollback: boolean;
}
export declare const TEST_FILE_PATTERN: RegExp;
export declare const NON_SOURCE_PATTERN: RegExp;
export declare const SENSITIVE_PATTERNS: RegExp[];
export declare const DEPENDENCY_FILES: RegExp[];
export declare const FACTOR_WEIGHTS: Record<string, number>;
export declare function matchesGlobs(filename: string, patterns: string[]): boolean;
export declare function isTestFile(filename: string): boolean;
export declare function isNonSourceFile(filename: string): boolean;
export declare function isSensitiveFile(filename: string): boolean;
export declare function sensitivityWeight(filename: string, config?: RiskConfig | null): number;
export declare function weightedAverageScores(factors: RiskFactorResult[], overrides?: Record<string, number>): number;
export declare function computeRiskScore(files: FileInfo[], config?: RiskConfig | null): {
    score: number;
    factors: RiskFactorResult[];
};
export declare function detectDependencyChanges(files: FileInfo[]): RiskFactorResult | null;
export declare function computeSecurityFactor(alerts: SecurityAlertCounts): RiskFactorResult | null;
export declare function computeDeploymentHistoryFactor(outcomes: DeploymentOutcomeSummary): RiskFactorResult | null;
export interface FreezeWindowDef {
    days: string[];
    afterHour?: number;
    beforeHour?: number;
    timezone?: string;
    message?: string;
}
export declare function isInFreezeWindow(freezes: FreezeWindowDef[], now?: Date): {
    frozen: boolean;
    message?: string;
};
export type GateDecisionValue = "allow" | "warn" | "block";
export declare function decideGate(riskScore: number, healthScore: number, blockThreshold: number, warnThreshold?: number): GateDecisionValue;
export declare function isRollback(prTitle: string): boolean;
