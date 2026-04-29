let adapters = [];
export function registerAdapter(adapter) {
    adapters.push(adapter);
}
export function clearAdapters() {
    adapters = [];
}
export function getAdapter(name) {
    return adapters.find((a) => a.name === name);
}
export function getAvailableAdapters() {
    return adapters.filter((a) => a.detect());
}
export function listAdapterNames() {
    return adapters.map((a) => a.name);
}
export async function runAllAvailable() {
    const available = getAvailableAdapters();
    return Promise.all(available.map((a) => a.check()));
}
