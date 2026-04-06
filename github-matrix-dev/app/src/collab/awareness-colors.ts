/**
 * Deterministic color assignment for collaboration cursors.
 * Each userId maps to a consistent color so cursors don't change on reconnect.
 */

const COLORS = [
  '#E57373', '#81C784', '#64B5F6', '#FFB74D', '#BA68C8',
  '#4DD0E1', '#FF8A65', '#AED581', '#7986CB', '#F06292',
  '#4DB6AC', '#FFD54F', '#9575CD', '#A1887F', '#90A4AE',
];

export function colorForUser(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = ((hash << 5) - hash + userId.charCodeAt(i)) | 0;
  }
  return COLORS[Math.abs(hash) % COLORS.length];
}
