// Port Vela — fighting: punches, the pistol, and police gunfire.
// Space attacks: on foot, a close-range punch knocks back and hurts a
// nearby pedestrian (or slows a police car nose-to-nose with the
// player); otherwise the player fires a pistol. Bullets live in
// state.bullets and are drawn by the renderer through short-lived
// spark particles it already knows how to draw, plus muzzle and impact
// particles in the shapes render.js expects ({ x, y, life, maxLife,
// type, size }). At wanted level 2 and above, nearby police cars shoot
// back, and when the player's health reaches zero the screen flips to
// 'wasted'. Cooldowns and police shot timers live in a module-local
// WeakMap keyed by the state, so no new fields are added to the game
// state itself.
//
// The main loop should call updateCombat(state, input, dt) every frame
// while playing.

import {
  WORLD_WIDTH,
  WORLD_HEIGHT,
  PLAYER_MAX_HEALTH,
} from './config.js';
import { clamp } from './util.js';
import { isInsideBuilding } from './world.js';
import { commitCrime } from './police.js';
import { frightenPedestrians } from './pedestrians.js';

// Pistol tuning.
const BULLET_SPEED = 720;
const BULLET_RANGE = 520;
const SHOT_COOLDOWN = 0.28;
const MUZZLE_OFFSET = 18;
// Punch tuning.
const PUNCH_RANGE = 46;
const PUNCH_COOLDOWN = 0.35;
const PUNCH_KNOCKBACK = 34;
// Bullet hit radii.
const PED_HIT_RADIUS = 14;
const CAR_HIT_RADIUS = 26;
// Police shoot back only at this wanted level or higher, only this
// close, and only this often per car — fair, not a firing squad.
const POLICE_SHOOT_MIN_WANTED = 2;
const POLICE_SHOOT_RANGE = 380;
const POLICE_SHOT_INTERVAL = 1.4;
const POLICE_SHOT_DAMAGE = 5;
const POLICE_SHOT_HIT_CHANCE = 0.7;
// How far a shot or a punch is "seen" by the police.
const WITNESS_RADIUS = 600;

// Per-state runtime: attack cooldowns and one shot timer per police car.
const runtime = new WeakMap();

function rt(state) {
  let r = runtime.get(state);
  if (!r) {
    r = { shotCooldown: 0, punchCooldown: 0, policeShots: new Map() };
    runtime.set(state, r);
  }
  return r;
}

// Add a particle in the shape render.js draws: { x, y, life, maxLife,
// type, size } (plus color for the generic fallback kind).
function addParticle(state, type, x, y, size, life, color) {
  if (!state.particles) state.particles = [];
  const p = {
    x, y,
    life, maxLife: life,
    type, size,
  };
  if (color) p.color = color;
  state.particles.push(p);
  return p;
}

function muzzleFlash(state, x, y) {
  addParticle(state, 'muzzle', x, y, 11, 0.12);
}

function impactSparks(state, x, y, color) {
  for (let i = 0; i < 4; i++) {
    const a = state.rng() * Math.PI * 2;
    const d = 4 + state.rng() * 8;
    addParticle(state, 'spark',
      x + Math.cos(a) * d, y + Math.sin(a) * d, 3, 0.25);
  }
  if (color) addParticle(state, 'spark', x, y, 6, 0.3, color);
}

// Fire one pistol shot from (x, y) along `angle`: a bullet in
// state.bullets, a muzzle flash, and a wanted bump when police are
// close enough to hear it.
function fireBullet(state, x, y, angle) {
  if (!state.bullets) state.bullets = [];
  state.bullets.push({
    x, y,
    angle,
    speed: BULLET_SPEED,
    traveled: 0,
    maxRange: BULLET_RANGE,
  });
  const mx = x + Math.cos(angle) * MUZZLE_OFFSET;
  const my = y + Math.sin(angle) * MUZZLE_OFFSET;
  muzzleFlash(state, mx, my);
  state.stats.shotsFired = ((state.stats && state.stats.shotsFired) || 0) + 1;
  for (const car of state.police || []) {
    if (Math.hypot(car.x - x, car.y - y) <= WITNESS_RADIUS) {
      commitCrime(state, 'shooting');
      break;
    }
  }
}

// Nearest pedestrian within punch range of (x, y), or null.
function nearestPedInRange(state, x, y, range) {
  let best = null;
  let bestDist = range;
  for (const ped of state.pedestrians || []) {
    const d = Math.hypot(ped.x - x, ped.y - y);
    if (d < bestDist) {
      bestDist = d;
      best = ped;
    }
  }
  return best;
}

// Nearest police car within punch range of (x, y), or null.
function nearestPoliceInRange(state, x, y, range) {
  let best = null;
  let bestDist = range;
  for (const car of state.police || []) {
    const d = Math.hypot(car.x - x, car.y - y);
    if (d < bestDist) {
      bestDist = d;
      best = car;
    }
  }
  return best;
}

// Shove a pedestrian away from (fromX, fromY) without pushing them
// into a building or out of the world.
function knockbackPed(state, ped, fromX, fromY, distance) {
  const a = Math.atan2(ped.y - fromY, ped.x - fromX);
  const nx = clamp(ped.x + Math.cos(a) * distance, 0, WORLD_WIDTH);
  const ny = clamp(ped.y + Math.sin(a) * distance, 0, WORLD_HEIGHT);
  if (state.city && !isInsideBuilding(state.city, nx, ny)) {
    ped.x = nx;
    ped.y = ny;
  }
}

// Space on foot: punch a nearby pedestrian (knockback + they flee, and
// the police take notice), thump a police car nose-to-nose with the
// player, or fire the pistol when nothing is in reach.
function attackOnFoot(state, r) {
  const player = state.player;
  const ped = nearestPedInRange(state, player.x, player.y, PUNCH_RANGE);
  if (ped) {
    knockbackPed(state, ped, player.x, player.y, PUNCH_KNOCKBACK);
    frightenPedestrians(state, ped.x, ped.y, 200);
    impactSparks(state, ped.x, ped.y, '#c0392b');
    commitCrime(state, 'assault');
    r.punchCooldown = PUNCH_COOLDOWN;
    return;
  }
  const cop = nearestPoliceInRange(state, player.x, player.y, PUNCH_RANGE);
  if (cop) {
    cop.speed = (cop.speed || 0) * 0.5;
    impactSparks(state, cop.x, cop.y);
    commitCrime(state, 'assault');
    r.punchCooldown = PUNCH_COOLDOWN;
    return;
  }
  if (r.shotCooldown > 0) return;
  fireBullet(state, player.x, player.y, player.angle);
  r.shotCooldown = SHOT_COOLDOWN;
}

// Space while driving: a drive-by shot from the car, in the car's
// facing direction.
function attackDriving(state, r) {
  if (r.shotCooldown > 0) return;
  const player = state.player;
  fireBullet(state, player.x, player.y, player.angle);
  r.shotCooldown = SHOT_COOLDOWN;
}

// A bullet hit a pedestrian: they go down (removed from the crowd)
// and everyone nearby runs. Shooting a bystander is a serious crime.
function hitPedestrian(state, ped) {
  state.pedestrians = (state.pedestrians || []).filter((p) => p !== ped);
  impactSparks(state, ped.x, ped.y, '#c0392b');
  frightenPedestrians(state, ped.x, ped.y, 220);
  commitCrime(state, 'hitPedestrian');
}

// A bullet hit a car: traffic slows down, a police car slows and the
// shooting is noticed. Returns true when a hit landed.
function hitCar(state, bullet, cars, isPolice) {
  for (const car of cars) {
    const len = (car.length || 44) / 2;
    const wid = (car.width || 22) / 2;
    // Oriented hit test: the bullet must land inside the car's body.
    const dx = bullet.x - car.x;
    const dy = bullet.y - car.y;
    const ca = Math.cos(car.angle || 0);
    const sa = Math.sin(car.angle || 0);
    const along = Math.abs(dx * ca + dy * sa);
    const across = Math.abs(-dx * sa + dy * ca);
    if (along <= len + 4 && across <= wid + CAR_HIT_RADIUS / 2) {
      car.speed = (car.speed || 0) * 0.5;
      impactSparks(state, bullet.x, bullet.y);
      if (isPolice) commitCrime(state, 'shooting');
      return true;
    }
  }
  return false;
}

// Move every bullet one frame, resolve hits, and drop bullets that
// expire at range, hit a building, or hit something.
function updateBullets(state, dt) {
  if (!state.bullets) state.bullets = [];
  const kept = [];
  for (const bullet of state.bullets) {
    const step = bullet.speed * dt;
    bullet.x += Math.cos(bullet.angle) * step;
    bullet.y += Math.sin(bullet.angle) * step;
    bullet.traveled = (bullet.traveled || 0) + step;
    // A bright speck each frame is what makes the bullet visible: the
    // renderer draws these spark particles.
    addParticle(state, 'spark', bullet.x, bullet.y, 3, 0.12);
    let dead = bullet.traveled >= bullet.maxRange ||
      bullet.x < 0 || bullet.x > WORLD_WIDTH ||
      bullet.y < 0 || bullet.y > WORLD_HEIGHT;
    if (!dead && state.city && isInsideBuilding(state.city, bullet.x, bullet.y)) {
      impactSparks(state, bullet.x, bullet.y);
      dead = true;
    }
    if (!dead) {
      for (const ped of [...(state.pedestrians || [])]) {
        if (Math.hypot(ped.x - bullet.x, ped.y - bullet.y) <= PED_HIT_RADIUS) {
          hitPedestrian(state, ped);
          dead = true;
          break;
        }
      }
    }
    if (!dead && hitCar(state, bullet, state.police || [], true)) dead = true;
    if (!dead && hitCar(state, bullet, state.cars || [], false)) dead = true;
    if (!dead) kept.push(bullet);
  }
  state.bullets = kept;
}

// Police cars shoot back at a wanted player on foot: one shot per car
// every POLICE_SHOT_INTERVAL seconds, with a hit chance so the player
// can close in or break away instead of being melted.
function policeGunfire(state, dt) {
  if ((state.wanted || 0) < POLICE_SHOOT_MIN_WANTED) return;
  if (!state.player.onFoot) return;
  const r = rt(state);
  const player = state.player;
  for (const car of state.police || []) {
    const d = Math.hypot(car.x - player.x, car.y - player.y);
    if (d > POLICE_SHOOT_RANGE) continue;
    const next = r.policeShots.get(car.id) || 0;
    if (state.time < next) continue;
    r.policeShots.set(car.id, state.time + POLICE_SHOT_INTERVAL);
    addParticle(state, 'muzzle', car.x, car.y, 9, 0.1);
    if (state.rng() < POLICE_SHOT_HIT_CHANCE) {
      hurtPlayer(state, POLICE_SHOT_DAMAGE);
      impactSparks(state, player.x, player.y, '#e74c3c');
    }
  }
}

// Damage the player, never below zero health.
export function hurtPlayer(state, amount) {
  if (!state || !state.player) return;
  state.player.health = Math.max(
    0, (state.player.health ?? PLAYER_MAX_HEALTH) - amount);
}

// Advance combat one frame: handle the Space attack, move bullets,
// let the police shoot back, and flip the screen when the player dies.
// input must expose consumePressed() and isDown(); dt is seconds.
export function updateCombat(state, input, dt) {
  if (!state || !state.player || !input) return;
  const safeDt = dt > 0 && dt < 1 ? dt : 1 / 60;
  const r = rt(state);
  r.shotCooldown = Math.max(0, r.shotCooldown - safeDt);
  r.punchCooldown = Math.max(0, r.punchCooldown - safeDt);

  if (input.consumePressed('action')) {
    if (state.player.onFoot) {
      if (r.punchCooldown <= 0) attackOnFoot(state, r);
      else if (r.shotCooldown <= 0) {
        fireBullet(state, state.player.x, state.player.y, state.player.angle);
        r.shotCooldown = SHOT_COOLDOWN;
      }
    } else {
      attackDriving(state, r);
    }
  }

  updateBullets(state, safeDt);
  policeGunfire(state, safeDt);

  // Last line of defence against bad numbers: no NaN ever escapes.
  for (const bullet of state.bullets || []) {
    if (!Number.isFinite(bullet.x) || !Number.isFinite(bullet.y) ||
        !Number.isFinite(bullet.angle)) {
      bullet.x = state.player.x;
      bullet.y = state.player.y;
      bullet.angle = state.player.angle;
      bullet.traveled = bullet.maxRange;
    }
  }
  if (!Number.isFinite(state.player.health)) {
    state.player.health = PLAYER_MAX_HEALTH;
  }

  if (state.player.health <= 0 && state.screen !== 'wasted') {
    state.screen = 'wasted';
    if (!state.messages) state.messages = [];
    state.messages.push('Wasted. Mama Rosa is already finding a new driver.');
  }
}

export default updateCombat;
