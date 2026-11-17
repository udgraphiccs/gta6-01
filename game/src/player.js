// Port Vela — player movement on foot and driving.
// One update function advances the player from the input object each
// frame. On foot the player walks or sprints and is blocked by
// buildings; pressing E near a car puts the player in the driver's
// seat, and pressing E again steps them back out beside the car.

import {
  WORLD_WIDTH,
  WORLD_HEIGHT,
  CAR_TYPES,
  PLAYER_WALK_SPEED,
  PLAYER_SPRINT_SPEED,
} from './config.js';
import { clamp, distance } from './util.js';
import { isInsideBuilding } from './world.js';

// How close (px) the player must be to a car to get in.
const ENTER_CAR_RANGE = 64;
// The player's collision radius on foot, so they stop at walls instead
// of clipping into them.
const PLAYER_RADIUS = 12;
// Reverse is slower than forward driving.
const REVERSE_TOP_SPEED = 120;
// Steering (radians per second) at full speed, scaled by handling.
const STEER_RATE = 2.6;
// How quickly a car slows when no pedal is pressed (px/s^2).
const DRAG = 180;
// How quickly a car stops against a building.
const CRASH_STOP = 0.25;

// The car the player is driving, or null.
function drivenCar(state) {
  if (state.player.onFoot || state.player.carId == null) return null;
  const cars = state.cars || [];
  return cars.find((c) => c.id === state.player.carId) || null;
}

// Nearest unoccupied car within entry range of a point, or null.
function nearestEnterableCar(state, x, y) {
  let best = null;
  let bestDist = ENTER_CAR_RANGE;
  for (const car of state.cars || []) {
    if (car.occupied) continue;
    const d = distance({ x, y }, car);
    if (d < bestDist) {
      bestDist = d;
      best = car;
    }
  }
  return best;
}

// True when a circle of the given radius centered at (x, y) overlaps
// any building footprint.
function blockedByBuilding(city, x, y, radius) {
  if (!city) return false;
  if (isInsideBuilding(city, x, y)) return true;
  // Probe the rim so a large radius cannot straddle a thin wall.
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

// Move a point by (dx, dy) with per-axis building collision: slide
// along a wall instead of stopping dead when only one axis is blocked.
function moveWithCollision(city, x, y, dx, dy, radius) {
  let nx = x;
  let ny = y;
  if (dx !== 0 && !blockedByBuilding(city, x + dx, y, radius)) {
    nx = x + dx;
  }
  if (dy !== 0 && !blockedByBuilding(city, nx, y + dy, radius)) {
    ny = y + dy;
  }
  return { x: nx, y: ny };
}

// Keep a point inside the world bounds.
function clampToWorld(x, y) {
  return {
    x: clamp(x, 0, WORLD_WIDTH),
    y: clamp(y, 0, WORLD_HEIGHT),
  };
}

// On foot: walk or sprint in the input direction, facing the way the
// player moves, blocked by buildings and the world edge.
function updateOnFoot(state, input, dt) {
  const player = state.player;
  const move = input.moveVector();
  const sprinting = input.isDown('sprint');
  const speed = sprinting ? PLAYER_SPRINT_SPEED : PLAYER_WALK_SPEED;
  let mx = move.x;
  let my = move.y;
  const len = Math.hypot(mx, my);
  if (len > 0) {
    mx /= len;
    my /= len;
    player.angle = Math.atan2(my, mx);
    const next = moveWithCollision(
      state.city, player.x, player.y, mx * speed * dt, my * speed * dt,
      PLAYER_RADIUS);
    const clamped = clampToWorld(next.x, next.y);
    player.x = clamped.x;
    player.y = clamped.y;
    player.speed = speed;
  } else {
    player.speed = 0;
  }

  // Step into a nearby car.
  if (input.consumePressed('enterExit')) {
    const car = nearestEnterableCar(state, player.x, player.y);
    if (car) {
      player.onFoot = false;
      player.carId = car.id;
      car.occupied = true;
      car.speed = car.speed || 0;
      player.speed = 0;
      state.stats.carsStolen += 1;
    }
  }
}

// Driving: accelerate, brake and reverse with the movement keys, steer
// in proportion to speed, and stop dead against buildings.
function updateDriving(state, input, dt) {
  const player = state.player;
  const car = drivenCar(state);
  if (!car) {
    // The car is gone (despawned): put the player back on foot.
    player.onFoot = true;
    player.carId = null;
    player.speed = 0;
    return;
  }
  const type = CAR_TYPES[car.type] || CAR_TYPES.sedan;
  const move = input.moveVector();
  let speed = car.speed || 0;

  // Up accelerates forward, down brakes then reverses.
  if (move.y < 0) {
    speed += type.accel * dt;
  } else if (move.y > 0) {
    if (speed > 0) speed -= type.accel * 1.6 * dt;
    else speed -= type.accel * 0.6 * dt;
  } else if (speed !== 0) {
    // Coast down with drag when no pedal is pressed.
    const drop = DRAG * dt;
    speed = speed > 0
      ? Math.max(0, speed - drop)
      : Math.min(0, speed + drop);
  }
  speed = clamp(speed, -REVERSE_TOP_SPEED, type.topSpeed);

  // Steer: left/right turn the car, more at higher speed and with
  // better handling, and reversed when backing up.
  const steerInput = move.x;
  const speedFactor = clamp(Math.abs(speed) / type.topSpeed, 0, 1);
  const steer = steerInput * STEER_RATE * type.handling * speedFactor;
  car.angle = (car.angle || 0) + steer * dt * Math.sign(speed || 1);

  // Advance the car, stopping at buildings instead of passing through.
  const dx = Math.cos(car.angle) * speed * dt;
  const dy = Math.sin(car.angle) * speed * dt;
  const radius = Math.max((car.length || 44) / 2, (car.width || 22) / 2);
  const next = moveWithCollision(
    state.city, car.x, car.y, dx, dy, radius);
  const hitWall = next.x !== car.x + dx || next.y !== car.y + dy;
  if (hitWall) speed *= CRASH_STOP;
  const clamped = clampToWorld(next.x, next.y);
  if (clamped.x !== next.x || clamped.y !== next.y) speed = 0;
  car.x = clamped.x;
  car.y = clamped.y;
  car.speed = speed;
  player.x = car.x;
  player.y = car.y;
  player.angle = car.angle;
  player.speed = speed;

  // Step out beside the car, parked where it stopped.
  if (input.consumePressed('enterExit')) {
    exitCar(state, car);
  }
}

// Park the car and step the player out beside it, on foot. The exit
// spot is to the car's left; if that spot is inside a building or
// outside the world, try the right side, then behind, then in front.
function exitCar(state, car) {
  const player = state.player;
  const len = (car.length || 44) / 2;
  const wid = (car.width || 22) / 2;
  const side = wid + PLAYER_RADIUS + 4;
  const behind = len + PLAYER_RADIUS + 4;
  const candidates = [
    { dx: Math.cos(car.angle - Math.PI / 2) * side,
      dy: Math.sin(car.angle - Math.PI / 2) * side },
    { dx: Math.cos(car.angle + Math.PI / 2) * side,
      dy: Math.sin(car.angle + Math.PI / 2) * side },
    { dx: -Math.cos(car.angle) * behind,
      dy: -Math.sin(car.angle) * behind },
    { dx: Math.cos(car.angle) * behind,
      dy: Math.sin(car.angle) * behind },
  ];
  let spot = null;
  for (const c of candidates) {
    const px = car.x + c.dx;
    const py = car.y + c.dy;
    if (px < 0 || px > WORLD_WIDTH || py < 0 || py > WORLD_HEIGHT) continue;
    if (blockedByBuilding(state.city, px, py, PLAYER_RADIUS)) continue;
    spot = { x: px, y: py };
    break;
  }
  // Fall back to the car's own position if every side is blocked.
  if (!spot) spot = { x: car.x, y: car.y };

  car.speed = 0;
  car.occupied = false;
  player.onFoot = true;
  player.carId = null;
  player.x = spot.x;
  player.y = spot.y;
  player.angle = car.angle;
  player.speed = 0;
}

// Advance the player one frame. dt is seconds since the last frame.
// input must expose moveVector(), isDown(), and consumePressed().
export function updatePlayer(state, input, dt) {
  if (!state || !state.player || !input) return;
  const safeDt = dt > 0 && dt < 1 ? dt : 1 / 60;
  if (state.player.onFoot) {
    updateOnFoot(state, input, safeDt);
  } else {
    updateDriving(state, input, safeDt);
  }
}

export default updatePlayer;
