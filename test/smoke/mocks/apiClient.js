export async function unlinkInstitution() { return { ok: true }; }
export async function askAssistant() {
  return { answer: "You spent $84.12 at Safeway this month — about 8% less than July. Groceries overall are $333.12 against a $500 budget, so you're on pace.", usage: { input_tokens: 4200, output_tokens: 90 } };
}
export async function getSimpleFinStatus() {
  return { connected: true, institutions: [], last_pulled_at: '2026-08-02T12:00:00Z' };
}
export async function claimSimpleFinToken() { return { ok: true }; }
export async function disconnectSimpleFin() { return { ok: true }; }
export async function restoreSimpleFinInstitution() { return { ok: true }; }
export async function restoreImportedInstitution() { return { ok: true, unhidden: 2 }; }
export async function runServerSync() { return { ok: true, results: [] }; }
