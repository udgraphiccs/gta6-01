// Port Vela — small pure helpers. No game logic, no I/O.

// Seeded RNG (mulberry32-style). Returns a function yielding [0, 1).
export function createRng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Pick a random element from a list using the given RNG.
export function pick(rng, list) {
  if (!list || list.length === 0) return undefined;
  return list[Math.floor(rng() * list.length)];
}

// Random integer in [min, max] inclusive, using the given RNG.
export function randInt(rng, min, max) {
  const lo = Math.ceil(min);
  const hi = Math.floor(max);
  return lo + Math.floor(rng() * (hi - lo + 1));
}

// Clamp a value into [min, max].
export function clamp(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

// Linear interpolation between a and b by t (0..1).
export function lerp(a, b, t) {
  return a + (b - a) * t;
}

// Distance between two points {x, y}.
export function distance(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.hypot(dx, dy);
}

// Angle from point a to point b, in radians.
export function angleTo(a, b) {
  return Math.atan2(b.y - a.y, b.x - a.x);
}

// Shortest signed difference between two angles, wrapped to [-PI, PI].
export function angleDiff(from, to) {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

// Turn a string into a numeric seed (simple FNV-style hash).
export function stringToSeed(text) {
  let h = 2166136261 >>> 0;
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
