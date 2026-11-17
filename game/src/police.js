// Port Vela — wanted level and police response.
// The wanted level lives in state.wanted (0 clean to 5 maximum heat)
// and is backed by state.heat, a continuous value that decays once
// the player has been quiet for a while and no police car is close.
// Police cars live in state.police as car-shaped objects of type
// 'police', the shape the renderer already draws with a flashing
// light bar. They spawn on roads near the player, chase the player's
// position, try to ram the player's car, and arrest the player on
// foot when they stay very close for a sustained time. When the heat
// falls back to 0 the police drive off and despawn.
//
// Per-state timers (quiet time, spawn timer, arrest timer, ram
// cooldowns) live in a module-local WeakMap keyed by the state, so
// no new fields are added to the game state itself.

import {
  WORLD_WIDTH,
  WORLD_HEIGHT,
  CAR_TYPES,
  WANTED_MAX,
  WANTED_DECAY_DELAY,
  HEAT_PER_CRIME,
  HEAT_DECAY,
  POLICE_SPAWN_INTERVAL,
  POLICE_MAX_ACTIVE,
  POLICE_CHASE_RANGE,
  POLICE_RAM_DAMAGE,
  COAST,
} from './config.js';
import { clamp, pick, angleDiff } from './util.js';
import {
  isInsideBuilding,
  randomRoadPositionNear,
} from './world.js';

// Wanted stars added per crime, for commitCrime() / raiseWanted().
const CRIME_WANTED = {
  carTheft: 1,
  stealCar: 1,
  hitPedestrian: 2,
  hitPed: 2,
  shooting: 1,
  gunfire: 1,
  assault: 1,
};
// How many police cars each wanted level calls for.
const POLICE_PER_WANTED = [0, 1, 2, 3, 5, 6];
// A police car must stay this close (px) for this long (seconds)
// to arrest a player on foot.
const ARREST_RADIUS = 48;
const ARREST_TIME = 1.5;
// Wanted decay pauses while a police car is closer than this.
const POLICE_NEAR_RADIUS = 400;
// Police spawn at least this far from the player, so they never pop
// in on top of them.
const SPAWN_MIN_DISTANCE = 280;
// A leaving police car despawns once this far away, or after this
// many seconds of driving off.
const LEAVE_DESPAWN_DISTANCE = 750;
const LEAVE_MAX_TIME = 8;

// Per-state runtime: quiet time, spawn timer, arrest timer, and the
// last ram time per police car id.
const runtime = new WeakMap();

function rt(state) {
  let r = runtime.get(state);
  if (!r) {
    r = {
      quietTime: 0,
      spawnTimer: 0,
      catchTime: 0,
      ramCooldown: new Map(),
    };
    runtime.set(state, r);
  }
  return r;
}

// How many police cars a wanted level calls for, capped at the max.
export function desiredPoliceCount(wanted) {
  const level = clamp(wanted | 0, 0, WANTED_MAX);
  return Math.min(POLICE_PER_WANTED[level], POLICE_MAX_ACTIVE);
}

// Raise the wanted level by `amount` stars (a number), or by the
// stars for a named crime ('carTheft', 'hitPedestrian', 'shooting',
// 'assault'). Capped at 5. Also tops police up to the new level.
export function raiseWanted(state, amount = 1) {
  if (!state) return 0;
  let stars;
  if (typeof amount === 'string') {
    stars = CRIME_WANTED[amount] ?? 1;
  } else if (typeof amount === 'number' && Number.isFinite(amount)) {
    stars = amount;
  } else {
    stars = 1;
  }
  state.heat = Math.max(0, (state.heat || 0) + stars * HEAT_PER_CRIME);
  state.wanted = clamp(
    Math.ceil(state.heat / HEAT_PER_CRIME), 0, WANTED_MAX);
  rt(state).quietTime = 0;
  if (state.city) spawnPolice(state);
  return state.wanted;
}

// Raise the wanted level for a named crime: 'carTheft' (stealing a
// car), 'hitPedestrian' (hitting a pedestrian), 'shooting' (firing a
// weapon near police), or 'assault'. Returns the new wanted level.
export function commitCrime(state, kind) {
  return raiseWanted(state, kind);
}

// Next free police id: one past the highest numeric suffix in use.
function nextPoliceId(state) {
  let max = 0;
  for (const car of state.police || []) {
    const m = /^police-(\d+)$/.exec(String(car.id || ''));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `police-${max + 1}`;
}

// Build one police car on a road near the player, facing them, or
// null when no clear spot was found. Never spawns inside a building
// (road points never are) or in the sea.
function makePoliceCar(state) {
  const rng = state.rng;
  const px = state.player.x;
  const py = state.player.y;
  let best = null;
  let bestDist = -1;
  for (let attempt = 0; attempt < 10; attempt++) {
    const spot = randomRoadPositionNear(state.city, px, py, 650);
    if (spot.y >= COAST.beachY) spot.y = COAST.beachY - 80;
    const d = Math.hypot(spot.x - px, spot.y - py);
    if (d > bestDist) {
      bestDist = d;
      best = spot;
    }
    if (d >= SPAWN_MIN_DISTANCE) break;
  }
  if (!best) return null;
  // Keep clear of other police cars when a clear spot was found.
  for (const other of state.police) {
    if (Math.hypot(other.x - best.x, other.y - best.y) < 70) return null;
  }
  const def = CAR_TYPES.police;
  return {
    id: nextPoliceId(state),
    x: best.x,
    y: best.y,
    angle: Math.atan2(py - best.y, px - best.x),
    type: 'police',
    length: 44,
    width: 22,
    speed: 0,
    occupied: false,
    color: pick(rng, def.colors),
    isPolice: true,
    leaving: false,
    leaveTime: 0,
  };
}

// Spawn police cars up to `count` (default: what the wanted level
// calls for), on roads near the player. Returns the cars spawned.
export function spawnPolice(state, count) {
  if (!state || !state.city) return [];
  if (!state.police) state.police = [];
  const target = count != null
    ? count
    : desiredPoliceCount(state.wanted || 0);
  const made = [];
  const cap = Math.min(target, POLICE_MAX_ACTIVE);
  while (state.police.length < cap) {
    const car = makePoliceCar(state);
    if (!car) break;
    state.police.push(car);
    made.push(car);
  }
  return made;
}

// Distance to the nearest police car, or null when there are none.
function nearestPoliceDistance(state) {
  let best = null;
  for (const car of state.police || []) {
    const d = Math.hypot(car.x - state.player.x, car.y - state.player.y);
    if (best == null || d < best) best = d;
  }
  return best;
}

// Let the wanted level decay slowly when the player is quiet: only
// once WANTED_DECAY_DELAY seconds have passed since the last crime,
// and only while no police car is close. Heat falls steadily and the
// star level follows it.
export function decayWanted(state, dt) {
  if (!state) return;
  const safeDt = dt > 0 && dt < 1 ? dt : 1 / 60;
  const r = rt(state);
  const nearest = nearestPoliceDistance(state);
  if (nearest != null && nearest < POLICE_NEAR_RADIUS) {
    r.quietTime = 0;
    return;
  }
  r.quietTime += safeDt;
  if (r.quietTime < WANTED_DECAY_DELAY) return;
  // Adopt an externally set wanted level before decaying from it.
  // Only when heat is below the whole band the level implies — heat
  // inside ((wanted - 1) * HEAT_PER_CRIME, wanted * HEAT_PER_CRIME]
  // is already consistent and must keep decaying, not be re-inflated.
  if (state.heat < (state.wanted - 1) * HEAT_PER_CRIME) {
    state.heat = state.wanted * HEAT_PER_CRIME;
  }
  state.heat = Math.max(0, state.heat - HEAT_DECAY * safeDt);
  state.wanted = state.heat <= 0
    ? 0
    : clamp(Math.ceil(state.heat / HEAT_PER_CRIME), 0, WANTED_MAX);
}

// True when a circle of the given radius centered at (x, y) overlaps
// any building footprint.
function blockedByBuilding(city, x, y, radius) {
  if (!city) return false;
  if (isInsideBuilding(city, x, y)) return true;
  const probes = 8;
  for (let i = 0; i < probes; i++) {
    const a = (i / probes) * Math.PI * 2;
    if (isInsideBuilding(city, x + Math.cos(a) * radius,
      y + Math.sin(a) * radius)) {
      return true;
    }
  }
  return false;
}

// Move a police car by (dx, dy) with per-axis building collision:
// slide along a wall instead of stopping dead when only one axis
// is blocked.
function moveCarWithSlide(city, car, dx, dy) {
  let nx = car.x;
  let ny = car.y;
  if (dx !== 0 && !blockedByBuilding(city, car.x + dx, car.y, 12)) {
    nx = car.x + dx;
  }
  if (dy !== 0 && !blockedByBuilding(city, nx, car.y + dy, 12)) {
    ny = car.y + dy;
  }
  return { x: nx, y: ny };
}

// The car the player is driving, or null when the player is on foot.
function drivenCar(state) {
  const player = state.player;
  if (!player || player.onFoot || player.carId == null) return null;
  return (state.cars || []).find((c) => c.id === player.carId) || null;
}

// Advance one chasing police car by dt seconds: steer toward the
// player, drive faster at higher wanted levels, slow to a stop
// beside the player instead of orbiting them, and slide around
// buildings instead of driving through them.
function updateChaseCar(state, car, dt) {
  const player = state.player;
  const def = CAR_TYPES.police;
  const dx = player.x - car.x;
  const dy = player.y - car.y;
  const dist = Math.hypot(dx, dy) || 1;

  // Steer toward the player, limited by a fixed turn rate.
  const desiredAngle = Math.atan2(dy, dx);
  const diff = angleDiff(car.angle || 0, desiredAngle);
  const turnRate = 3.4;
  car.angle = (car.angle || 0) +
    clamp(diff, -turnRate * dt, turnRate * dt);

  // Chase speed rises with the wanted level; far-off police cruise
  // in at reduced speed, and close police ease off to arrive.
  let desired = def.topSpeed * (0.5 + 0.08 * state.wanted);
  if (dist > POLICE_CHASE_RANGE) desired *= 0.65;
  if (dist < 90) desired *= Math.max(0.15, dist / 90);
  const speed = car.speed || 0;
  if (speed < desired) {
    car.speed = Math.min(desired, speed + def.accel * dt);
  } else {
    car.speed = Math.max(desired, speed - def.accel * 1.5 * dt);
  }

  const stepX = Math.cos(car.angle) * car.speed * dt;
  const stepY = Math.sin(car.angle) * car.speed * dt;
  const next = moveCarWithSlide(state.city, car, stepX, stepY);
  if (next.x === car.x && next.y === car.y && car.speed > 20) {
    // Walled in on both axes: turn away and slow down instead of
    // pushing against the building forever.
    car.angle += 1.4 * dt;
    car.speed *= 0.5;
  }
  car.x = clamp(next.x, 0, WORLD_WIDTH);
  car.y = clamp(next.y, 0, WORLD_HEIGHT);
}

// Advance one police car that is driving off after the heat died:
// steer away from the player and keep going until it despawns.
function updateLeavingCar(state, car, dt) {
  const player = state.player;
  const away = Math.atan2(car.y - player.y, car.x - player.x);
  const diff = angleDiff(car.angle || 0, away);
  car.angle = (car.angle || 0) + clamp(diff, -3.4 * dt, 3.4 * dt);
  car.speed = Math.min(280, (car.speed || 0) + 300 * dt);
  const stepX = Math.cos(car.angle) * car.speed * dt;
  const stepY = Math.sin(car.angle) * car.speed * dt;
  const next = moveCarWithSlide(state.city, car, stepX, stepY);
  car.x = clamp(next.x, 0, WORLD_WIDTH);
  car.y = clamp(next.y, 0, WORLD_HEIGHT);
  car.leaveTime = (car.leaveTime || 0) + dt;
}

// Ram the player's car when a police car touches it: shove the car,
// slow both cars, and damage the player at most once per second per
// police car.
function ramPlayerCar(state, car) {
  const driven = drivenCar(state);
  if (!driven) return;
  const d = Math.hypot(driven.x - car.x, driven.y - car.y);
  if (d >= 46) return;
  const pushAngle = Math.atan2(driven.y - car.y, driven.x - car.x);
  const nx = driven.x + Math.cos(pushAngle) * 8;
  const ny = driven.y + Math.sin(pushAngle) * 8;
  if (!isInsideBuilding(state.city, nx, ny)) {
    driven.x = clamp(nx, 0, WORLD_WIDTH);
    driven.y = clamp(ny, 0, WORLD_HEIGHT);
  }
  driven.speed = (driven.speed || 0) * 0.85;
  car.speed = (car.speed || 0) * 0.6;
  const r = rt(state);
  const last = r.ramCooldown.get(car.id);
  if (last == null || state.time - last > 1) {
    state.player.health = Math.max(
      0, (state.player.health || 100) - POLICE_RAM_DAMAGE);
    r.ramCooldown.set(car.id, state.time);
  }
}

// Advance all police one frame: decay the wanted level, keep the
// police count matched to it, chase the player, ram their car, and
// arrest them on foot after a sustained close approach. When the
// wanted level is 0, police drive off and despawn.
export function updatePolice(state, dt) {
  if (!state || !state.city || !state.police) return;
  const safeDt = dt > 0 && dt < 1 ? dt : 1 / 60;
  const r = rt(state);

  decayWanted(state, safeDt);

  // Top the police up to the wanted level every few seconds.
  r.spawnTimer -= safeDt;
  if (r.spawnTimer <= 0) {
    spawnPolice(state);
    r.spawnTimer = POLICE_SPAWN_INTERVAL;
  }

  if (state.wanted <= 0) {
    // Heat is gone: every police car drives off and despawns.
    for (const car of state.police) {
      car.leaving = true;
      updateLeavingCar(state, car, safeDt);
    }
    const px = state.player.x;
    const py = state.player.y;
    state.police = state.police.filter((car) => {
      const d = Math.hypot(car.x - px, car.y - py);
      return d <= LEAVE_DESPAWN_DISTANCE &&
        (car.leaveTime || 0) <= LEAVE_MAX_TIME;
    });
    r.catchTime = 0;
    return;
  }

  // Wanted again: any leaving car resumes the chase.
  for (const car of state.police) {
    car.leaving = false;
    car.leaveTime = 0;
    updateChaseCar(state, car, safeDt);
    ramPlayerCar(state, car);
  }

  // Arrest: the player is caught when on foot and a police car stays
  // very close for a sustained time.
  if (state.player.onFoot) {
    const nearest = nearestPoliceDistance(state);
    if (nearest != null && nearest < ARREST_RADIUS) {
      r.catchTime += safeDt;
      if (r.catchTime >= ARREST_TIME) state.screen = 'busted';
    } else {
      r.catchTime = 0;
    }
  } else {
    r.catchTime = 0;
  }

  // Last line of defence against bad numbers: no NaN ever escapes.
  for (const car of state.police) {
    if (!Number.isFinite(car.x) || !Number.isFinite(car.y)) {
      car.x = state.player.x;
      car.y = state.player.y;
    }
    if (!Number.isFinite(car.speed)) car.speed = 0;
    if (!Number.isFinite(car.angle)) car.angle = 0;
    car.x = clamp(car.x, 0, WORLD_WIDTH);
    car.y = clamp(car.y, 0, WORLD_HEIGHT);
    car.speed = clamp(car.speed || 0, 0, 600);
  }
}

export default updatePolice;
