import { avatarFor } from '../lib/avatar.js';

export function Avatar({ playerId, name, size = 40 }: { playerId: string; name?: string; size?: number }) {
  const { gradient, initials } = avatarFor(playerId, name);
  return (
    <span
      className="avatar"
      style={{ width: size, height: size, background: gradient, fontSize: size * 0.36 }}
      aria-hidden
    >
      {initials}
    </span>
  );
}
