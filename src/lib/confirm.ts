/**
 * Asks before an action that cannot be undone. Every deletion in the app goes
 * through here (tests/confirm.test.ts checks it), so no delete button can skip
 * the question. Uses the browser's own dialog: it works the same on the
 * computer and on the iPhone, and "Cancelar" (or a blocked dialog) means no.
 */
export function confirmDestructive(question: string): boolean {
  return window.confirm(`${question}\n\nIsso não pode ser desfeito.`);
}
