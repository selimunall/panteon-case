/** Deterministic avatar (gradient + initials) derived purely from the playerId. */
export function avatarFor(playerId: string, name?: string): { gradient: string; initials: string } {
  let h = 2166136261;
  for (let i = 0; i < playerId.length; i++) {
    h ^= playerId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const hue = (h >>> 0) % 360;
  const hue2 = (hue + 48) % 360;
  const base = (name ?? playerId).trim();
  const parts = base.split(/[\s_\-.]+/).filter(Boolean);
  const initials =
    (parts.length >= 2 ? parts[0]![0]! + parts[1]![0]! : base.slice(0, 2)).toUpperCase();
  return {
    gradient: `linear-gradient(140deg, hsl(${hue} 72% 58%), hsl(${hue2} 78% 42%))`,
    initials,
  };
}
