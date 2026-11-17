// Port Vela — ambient pedestrians on the sidewalks.
// Pedestrians stroll along the sidewalk ring around each city block,
// turn at corners instead of crossing roads, and run away from fast
// cars and loud violent events nearby. They never walk through
// buildings, never enter the sea, and never stand in the middle of
// a road. The crowd is kept near a target count around the player:
// far-away pedestrians despawn and replacements spawn nearby.
//
// Pedestrian objects live in state.pedestrians and keep exactly the
// shape the renderer reads — { x, y, angle, color } — plus the
// movement fields this module owns: id, speed, walkSpeed, fleeTimer
// and fleeAngle. No new fields are added to the game state itself.

import { WORLD_WIDTH, WORLD_HEIGHT, COAST } from './config.js';
import { clamp, pick, randInt } from './util.js';
import { isInsideBuilding } from './world.js';

// How many pedestrians to keep near the player.
export const PED_TARGET = 24;
// Pedestrians further than this from the player despawn.
const DESPAWN_DISTANCE = 1200;
// Replacements spawn on sidewalks within this radius of the player.
const SPAWN_RADIUS = 850;
// How far outside a block edge the sidewalk walking line sits.
const SIDEWALK_OFFSET = 6;
// A sidewalk point must be within this distance of a block edge.
const SIDEWALK_TOLERANCE = 10;
// Fleeing speed (px/s) and how long a fright lasts (seconds).
const RUN_SPEED = 230;
const FLEE_TIME = 2.5;
// A fast car closer than this scares nearby pedestrians.
const CAR_DANGER_SPEED = 180;
const CAR_DANGER_RADIUS = 170;
// A slow car almost touching a pedestrian scares them too.
const CAR_TOUCH_RADIUS = 48;

// Varied shirt colours for the crowd.
const SHIRT_COLORS = [
  '#e74c3c', '#2e86c1', '#f1c40f', '#8e44ad',
  '#16a085', '#e67e22', '#ecf0f1', '#1abc9c',
];

// Module-local id counter; ids only need to be unique per session.
let nextPedId = 1;

// True when (x, y) is a walkable sidewalk point: just outside a block
// edge (the paved ring the renderer draws around every block), clear
// of buildings and of the middle of the road, and north of the beach.
export function isSidewalkPoint(city, x, y) {
  if (!city) return false;
  if (x < 0 || x >= WORLD_WIDTH || y < 0 || y >= COAST.beachY) return false;
  if (isInsideBuilding(city, x, y)) return false;
  for (const block of city.blocks) {
    if (block.kind === 'water' || block.kind === 'beach') continue;
    const dx = Math.max(block.x - x, 0, x - (block.x + block.w));
    const dy = Math.max(block.y - y, 0, y - (block.y + block.h));
    if (dx === 0 && dy === 0) continue;
    if (Math.hypot(dx, dy) <= SIDEWALK_TOLERANCE) return true;
  }
  return false;
}

// Closest point on the sidewalk ring around one block: the nearest
// point on the rectangle expanded by SIDEWALK_OFFSET around it.
function ringPointFor(block, x, y) {
  const x0 = block.x - SIDEWALK_OFFSET;
  const y0 = block.y - SIDEWALK_OFFSET;
  const x1 = block.x + block.w + SIDEWALK_OFFSET;
  const y1 = block.y + block.h + SIDEWALK_OFFSET;
  const cx = clamp(x, x0, x1);
  const cy = clamp(y, y0, y1);
  if (cx === x && cy === y) {
    // Inside the expanded rectangle: push out to the nearest edge.
    const dl = x - x0;
    const dr = x1 - x;
    const dt = y - y0;
    const db = y1 - y;
    const m = Math.min(dl, dr, dt, db);
    if (m === dl) return { x: x0, y };
    if (m === dr) return { x: x1, y };
    if (m === dt) return { x, y: y0 };
    return { x, y: y1 };
  }
  return { x: cx, y: cy };
}

// Closest sidewalk point to (x, y) anywhere in the city, used to
// walk a pedestrian back to the pavement after they fled onto a road.
export function nearestSidewalkPoint(city, x, y) {
  let best = null;
  let bestDist = Infinity;
  for (const block of city.blocks) {
    if (block.kind === 'water' || block.kind === 'beach') continue;
    const p = ringPointFor(block, x, y);
    const dx = p.x - x;
    const dy = p.y - y;
    const d = dx * dx + dy * dy;
    if (d < bestDist) {
      bestDist = d;
      best = p;
    }
  }
  if (!best) {
    return { x: clamp(x, 0, WORLD_WIDTH), y: clamp(y, 0, COAST.beachY - 8) };
  }
  best.y = Math.min(best.y, COAST.beachY - 8);
  return best;
}

// A random sidewalk spot: one side of a random block, facing along
// that side. When nearPlayer is set, prefer blocks near the player.
function randomSidewalkSpot(state, nearPlayer) {
  const city = state.city;
  const rng = state.rng;
  let pool = city.blocks.filter(
    (b) => b.kind !== 'water' && b.kind !== 'beach');
  if (nearPlayer) {
    const px = state.player.x;
    const py = state.player.y;
    const near = pool.filter((b) => {
      const cx = b.x + b.w / 2;
      const cy = b.y + b.h / 2;
      const dx = cx - px;
      const dy = cy - py;
      return dx * dx + dy * dy <= SPAWN_RADIUS * SPAWN_RADIUS;
    });
    if (near.length > 0) pool = near;
  }
  if (pool.length === 0) return null;
  for (let attempt = 0; attempt < 8; attempt++) {
    const block = pick(rng, pool);
    const side = randInt(rng, 0, 3);
    const m = 24;
    let x;
    let y;
    let angle;
    if (side === 0) {
      x = block.x + m + rng() * (block.w - 2 * m);
      y = block.y - SIDEWALK_OFFSET;
      angle = 0;
    } else if (side === 1) {
      x = block.x + block.w + SIDEWALK_OFFSET;
      y = block.y + m + rng() * (block.h - 2 * m);
      angle = Math.PI / 2;
    } else if (side === 2) {
      x = block.x + m + rng() * (block.w - 2 * m);
      y = block.y + block.h + SIDEWALK_OFFSET;
      angle = Math.PI;
    } else {
      x = block.x - SIDEWALK_OFFSET;
      y = block.y + m + rng() * (block.h - 2 * m);
      angle = -Math.PI / 2;
    }
    if (isSidewalkPoint(city, x, y)) return { x, y, angle };
  }
  return null;
}

// Build one pedestrian on a sidewalk, or null when no spot was found.
function makePedestrian(state, nearPlayer) {
  const rng = state.rng;
  const spot = randomSidewalkSpot(state, nearPlayer);
  if (!spot) return null;
  return {
    id: `ped-${nextPedId++}`,
    x: spot.x,
    y: spot.y,
    angle: spot.angle,
    speed: 0,
    walkSpeed: 28 + rng() * 30,
    color: pick(rng, SHIRT_COLORS),
    fleeTimer: 0,
    fleeAngle: spot.angle,
  };
}

// Spawn up to `count` pedestrians on sidewalks. When nearPlayer is
// set, spawn them near the player instead of anywhere in the city.
export function spawnPedestrians(state, count = PED_TARGET,
  nearPlayer = false) {
  if (!state || !state.city) return [];
  if (!state.pedestrians) state.pedestrians = [];
  const made = [];
  for (let i = 0; i < count; i++) {
    const ped = makePedestrian(state, nearPlayer);
    if (!ped) break;
    state.pedestrians.push(ped);
    made.push(ped);
  }
  return made;
}

// Spawn the initial crowd for a fresh game state.
export function spawnInitialCrowd(state) {
  return spawnPedestrians(state, PED_TARGET, false);
}

// Set one pedestrian running away from (fromX, fromY).
function startFlee(state, ped, fromX, fromY) {
  ped.fleeTimer = FLEE_TIME * (0.7 + state.rng() * 0.6);
  ped.fleeAngle = Math.atan2(ped.y - fromY, ped.x - fromX);
  ped.angle = ped.fleeAngle;
}

// Frighten every pedestrian within `radius` of (x, y) — the hook for
// loud violent events such as gunfire or a crash. Returns how many
// pedestrians were scared.
export function frightenPedestrians(state, x, y, radius = 170) {
  if (!state || !state.pedestrians) return 0;
  let count = 0;
  for (const ped of state.pedestrians) {
    const d = Math.hypot(ped.x - x, ped.y - y);
    if (d <= radius) {
      startFlee(state, ped, x, y);
      count++;
    }
  }
  return count;
}

// Wrap an angle to [-PI, PI].
function normAngle(angle) {
  let a = angle % (Math.PI * 2);
  if (a > Math.PI) a -= Math.PI * 2;
  if (a < -Math.PI) a += Math.PI * 2;
  return a;
}

// Try one strolling step in direction `angle`. Moves the pedestrian
// only when the landing point is still a sidewalk point, so a stroll
// never crosses a road or enters a building. Returns true on a move.
function tryStrollStep(state, ped, angle, step) {
  const nx = ped.x + Math.cos(angle) * step;
  const ny = ped.y + Math.sin(angle) * step;
  if (!isSidewalkPoint(state.city, nx, ny)) return false;
  ped.x = nx;
  ped.y = ny;
  return true;
}

// Move a fleeing pedestrian away from danger. Fleeing may cross a
// road, but never enters a building or the sea; when the straight
// escape is blocked, the pedestrian veers to one side instead.
function moveFleeing(state, ped, step) {
  const angles = [
    ped.fleeAngle,
    ped.fleeAngle + 0.7,
    ped.fleeAngle - 0.7,
    ped.fleeAngle + Math.PI / 2,
    ped.fleeAngle - Math.PI / 2,
  ];
  for (const a of angles) {
    const nx = ped.x + Math.cos(a) * step;
    const ny = ped.y + Math.sin(a) * step;
    if (nx < 0 || nx >= WORLD_WIDTH || ny < 0 || ny >= COAST.seaY) continue;
    if (isInsideBuilding(state.city, nx, ny)) continue;
    ped.x = nx;
    ped.y = ny;
    ped.fleeAngle = a;
    ped.angle = a;
    return true;
  }
  return false;
}

// The car the player is driving, or null when the player is on foot.
function drivenCar(state) {
  const player = state.player;
  if (!player || player.onFoot || player.carId == null) return null;
  return (state.cars || []).find((c) => c.id === player.carId) || null;
}

// Advance one pedestrian by dt seconds.
function updatePedestrian(state, ped, driven, dt, rng) {
  // Danger check: a fast car close by, or any car almost touching.
  if (ped.fleeTimer <= 0 && driven) {
    const d = Math.hypot(driven.x - ped.x, driven.y - ped.y);
    const fast = Math.abs(driven.speed || 0) > CAR_DANGER_SPEED;
    if ((fast && d < CAR_DANGER_RADIUS) || d < CAR_TOUCH_RADIUS) {
      startFlee(state, ped, driven.x, driven.y);
    }
  }

  // Fleeing: run away from the danger, then calm down.
  if (ped.fleeTimer > 0) {
    ped.fleeTimer -= dt;
    ped.speed = RUN_SPEED;
    moveFleeing(state, ped, RUN_SPEED * dt);
    if (ped.fleeTimer <= 0) ped.speed = ped.walkSpeed;
    return;
  }

  // Off the pavement (for example after a flee across a road): walk
  // back to the nearest sidewalk point instead of strolling in place.
  if (!isSidewalkPoint(state.city, ped.x, ped.y)) {
    const target = nearestSidewalkPoint(state.city, ped.x, ped.y);
    const a = Math.atan2(target.y - ped.y, target.x - ped.x);
    const step = ped.walkSpeed * dt;
    const nx = ped.x + Math.cos(a) * step;
    const ny = ped.y + Math.sin(a) * step;
    if (nx >= 0 && nx < WORLD_WIDTH && ny >= 0 && ny < COAST.seaY &&
        !isInsideBuilding(state.city, nx, ny)) {
      ped.x = nx;
      ped.y = ny;
    }
    ped.angle = a;
    ped.speed = ped.walkSpeed;
    return;
  }

  // Strolling: walk along the sidewalk; at a corner the straight step
  // fails and the pedestrian turns onto the next side instead.
  const step = ped.walkSpeed * dt;
  if (tryStrollStep(state, ped, ped.angle, step)) {
    ped.speed = ped.walkSpeed;
  } else {
    const turns = rng() < 0.5
      ? [Math.PI / 2, -Math.PI / 2]
      : [-Math.PI / 2, Math.PI / 2];
    let moved = false;
    for (const t of [...turns, Math.PI]) {
      if (tryStrollStep(state, ped, ped.angle + t, step)) {
        ped.angle = normAngle(ped.angle + t);
        ped.speed = ped.walkSpeed;
        moved = true;
        break;
      }
    }
    if (!moved) ped.speed = 0;
  }

  // Occasionally turn at random, so the crowd does not all walk the
  // same loop forever. A bad turn is corrected by the step check
  // on the next frame.
  if (rng() < dt * 0.04) {
    const turn = rng() < 0.5 ? Math.PI / 2 : -Math.PI / 2;
    ped.angle = normAngle(ped.angle + turn);
  }
}

// Advance all pedestrians one frame: stroll, flee, despawn the far
// ones and replace them near the player. dt is seconds since the
// last frame.
export function updatePedestrians(state, dt) {
  if (!state || !state.city || !state.pedestrians) return;
  const safeDt = dt > 0 && dt < 1 ? dt : 1 / 60;
  const rng = state.rng;
  const driven = drivenCar(state);

  for (const ped of [...state.pedestrians]) {
    updatePedestrian(state, ped, driven, safeDt, rng);
  }

  // Last line of defence against bad numbers: no NaN ever escapes.
  for (const ped of state.pedestrians) {
    if (!Number.isFinite(ped.x) || !Number.isFinite(ped.y) ||
        !Number.isFinite(ped.angle)) {
      const spot = randomSidewalkSpot(state, true);
      if (spot) {
        ped.x = spot.x;
        ped.y = spot.y;
        ped.angle = spot.angle;
      }
      ped.fleeTimer = 0;
    }
    if (!Number.isFinite(ped.walkSpeed)) ped.walkSpeed = 40;
    if (!Number.isFinite(ped.speed)) ped.speed = 0;
  }

  // Despawn pedestrians far from the player, and replace them near.
  const px = state.player.x;
  const py = state.player.y;
  state.pedestrians = state.pedestrians.filter((ped) => {
    const dx = ped.x - px;
    const dy = ped.y - py;
    return dx * dx + dy * dy <= DESPAWN_DISTANCE * DESPAWN_DISTANCE;
  });
  if (state.pedestrians.length < PED_TARGET) {
    spawnPedestrians(state, PED_TARGET - state.pedestrians.length, true);
  }
}

export default updatePedestrians;
