const healers = [];
export function registerHealer(healer) {
    healers.push(healer);
}
export function getHealerFor(testFile, errorOutput) {
    return healers.find((h) => h.canHandle(testFile, errorOutput));
}
export async function attemptRepair(testFile, errorOutput) {
    const healer = getHealerFor(testFile, errorOutput);
    if (!healer)
        return null;
    return healer.repair(testFile, errorOutput);
}
//# sourceMappingURL=index.js.map