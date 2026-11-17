// Port Vela — non-player vehicles: traffic and parked cars.
// Owns every car that is not the player's: it spawns traffic on the
// road network, drives it along roads (turning at intersections,
// slowing for cars ahead, overtaking parked cars), spawns parked cars
// in parking lots and along curbs for the player to steal, keeps cars
// from overlapping, and despawns far-away traffic in favour of fresh
// cars near the player. The player's own driving lives in player.js
// and is never touched here: the driven car is skipped every frame.
//
// Car objects keep exactly the shape the other modules use:
// { id, x, y, angle, type, length, width, speed, occupied }.
// Routing state (which road a traffic car is on, its direction, its
// cruising speed, a turn in progress) lives in a module-local Map
// keyed by car id, never on the car object and never in game state.

import {
  WORLD_WIDTH,
  WORLD_HEIGHT,
  ROAD_WIDTH,
  CAR_TYPES,
  COAST,
} from './config.js';
import { clamp, pick } from './util.js';
import {
  isInsideBuilding,
  nearestRoadPoint,
  randomRoadPositionNear,
} from './world.js';

// How many traffic cars to keep on the road, and how many parked
// cars to keep available for the player to steal.
export const TRAFFIC_TARGET = 18;
export const PARKED_TARGET = 16;

// Traffic further than this from the player is despawned; replacements
// spawn on roads within this radius of the player.
const DESPAWN_DISTANCE = 1500;
const SPAWN_RADIUS = 950;
// Traffic drives in the right-hand lane, this far from the road center.
const LANE_OFFSET = 12;
// Parked cars sit at the curb, this far from the road center.
const CURB_OFFSET = 26;
// Chance a traffic car turns at an intersection instead of going on.
const TURN_CHANCE = 0.28;
// Turning radius (px) of a traffic car's turn: the swing rate scales
// with speed (rate = speed / radius) so fast cars do not overshoot
// the road they are turning onto.
const TURN_RADIUS = 45;
// How fast a car slides sideways back to its lane (px/s).
const LANE_CORRECT_SPEED = 60;

// Traffic never uses police cars: those belong to the police module.
const TRAFFIC_TYPES = [
  'sedan', 'sedan', 'sedan', 'taxi', 'taxi', 'van',
  'truck', 'sports', 'muscle', 'sedan', 'van', 'taxi',
];

// Routing state for each traffic car, keyed by car id.
const traffic = new Map();

// Body size for a car type. The renderer falls back to the same
// numbers, so these keep drawing and collision in agreement.
function dimsFor(type) {
  if (type === 'truck') return { length: 64, width: 26 };
  if (type === 'van') return { length: 52, width: 24 };
  if (type === 'sports' || type === 'muscle') return { length: 46, width: 22 };
  return { length: 44, width: 22 };
}

// Next free car id: one past the highest numeric suffix already used.
function nextCarId(state) {
  let max = 0;
  for (const car of state.cars || []) {
    const m = /^car-(\d+)$/.exec(String(car.id || ''));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `car-${max + 1}`;
}

// Facing angle for travel along an axis in a direction:
// vertical +1 is south (down), horizontal +1 is east (right).
function roadAngle(axis, dir) {
  if (axis === 'v') return dir > 0 ? Math.PI / 2 : -Math.PI / 2;
  return dir > 0 ? 0 : Math.PI;
}

// Signed lane offset for right-hand traffic on a road.
function signedLane(axis, dir) {
  if (axis === 'v') return dir > 0 ? -LANE_OFFSET : LANE_OFFSET;
  return dir > 0 ? LANE_OFFSET : -LANE_OFFSET;
}

// Roads traffic may use. The southernmost horizontal road runs
// through the sea strip, so it is excluded; vertical roads are usable
// only down to the beach.
function usableRoads(city) {
  return {
    vertical: city.roads.vertical,
    horizontal: city.roads.horizontal.filter((r) => r.y < COAST.beachY),
  };
}

// True when a point is clear of every other car (center distance).
function clearOfCars(state, x, y, minDist) {
  for (const other of state.cars || []) {
    const dx = other.x - x;
    const dy = other.y - y;
    if (dx * dx + dy * dy < minDist * minDist) return false;
  }
  return true;
}

// Pick a random road, direction and position along it.
function randomRoadSpot(state) {
  const rng = state.rng;
  const roads = usableRoads(state.city);
  const axis = rng() < 0.5 ? 'v' : 'h';
  if (axis === 'v') {
    const road = pick(rng, roads.vertical);
    return {
      axis, road: road.x, dir: rng() < 0.5 ? 1 : -1,
      along: 40 + rng() * (COAST.beachY - 80),
    };
  }
  const road = pick(rng, roads.horizontal);
  return {
    axis, road: road.y, dir: rng() < 0.5 ? 1 : -1,
    along: 40 + rng() * (WORLD_WIDTH - 80),
  };
}

// A road spot near the player, snapped onto the nearest road center.
function roadSpotNearPlayer(state) {
  const city = state.city;
  const spot = randomRoadPositionNear(
    city, state.player.x, state.player.y, SPAWN_RADIUS);
  // Never spawn in the sea: pull a southern spot back onto the beach
  // road's northern side, travelling on a vertical road.
  if (spot.y >= COAST.beachY) {
    spot.y = COAST.beachY - 80;
  }
  let bestV = null;
  let bestVd = Infinity;
  for (const road of city.roads.vertical) {
    const d = Math.abs(spot.x - road.x);
    if (d < bestVd) { bestVd = d; bestV = road.x; }
  }
  let bestH = null;
  let bestHd = Infinity;
  for (const road of city.roads.horizontal) {
    if (road.y >= COAST.beachY) continue;
    const d = Math.abs(spot.y - road.y);
    if (d < bestHd) { bestHd = d; bestH = road.y; }
  }
  const rng = state.rng;
  if (bestVd <= bestHd) {
    return { axis: 'v', road: bestV, dir: rng() < 0.5 ? 1 : -1, along: spot.y };
  }
  return { axis: 'h', road: bestH, dir: rng() < 0.5 ? 1 : -1, along: spot.x };
}

// Build one traffic car on the given road spot and register it.
// Returns the car, or null when no clear spot was found.
function makeTrafficCar(state, spot) {
  const rng = state.rng;
  const lane = signedLane(spot.axis, spot.dir);
  const x = spot.axis === 'v' ? spot.road + lane : spot.along;
  const y = spot.axis === 'v' ? spot.along : spot.road + lane;
  if (x < 0 || x > WORLD_WIDTH || y < 0 || y > WORLD_HEIGHT) return null;
  if (isInsideBuilding(state.city, x, y)) return null;
  if (!clearOfCars(state, x, y, 80)) return null;
  const type = pick(rng, TRAFFIC_TYPES);
  const def = CAR_TYPES[type] || CAR_TYPES.sedan;
  const dims = dimsFor(type);
  const car = {
    id: nextCarId(state),
    x, y,
    angle: roadAngle(spot.axis, spot.dir),
    type,
    length: dims.length,
    width: dims.width,
    speed: 0,
    occupied: false,
  };
  // Cruising speed is a fraction of the type's top speed.
  const cruise = def.topSpeed * (0.55 + rng() * 0.3);
  traffic.set(car.id, {
    axis: spot.axis,
    road: spot.road,
    dir: spot.dir,
    cruise,
    baseLane: lane,
    lane,
    turning: null,
    lastTurnKey: '',
  });
  state.cars.push(car);
  // Roll the car up to a rolling start so traffic is moving at once.
  car.speed = cruise * (0.5 + rng() * 0.5);
  return car;
}

// Spawn up to `count` traffic cars. When nearPlayer is set, spawn on
// roads near the player instead of anywhere in the city.
export function spawnTraffic(state, count = TRAFFIC_TARGET, nearPlayer = false) {
  if (!state || !state.city) return [];
  const made = [];
  for (let i = 0; i < count; i++) {
    let car = null;
    for (let attempt = 0; attempt < 12 && !car; attempt++) {
      const spot = nearPlayer ? roadSpotNearPlayer(state) : randomRoadSpot(state);
      car = makeTrafficCar(state, spot);
    }
    if (car) made.push(car);
  }
  return made;
}

// Build one parked car at (x, y) facing `angle`. Returns it, or null
// when the spot is taken or inside a building.
function makeParkedCar(state, x, y, angle) {
  const rng = state.rng;
  if (x < 0 || x > WORLD_WIDTH || y < 0 || y > WORLD_HEIGHT) return null;
  if (isInsideBuilding(state.city, x, y)) return null;
  if (!clearOfCars(state, x, y, 60)) return null;
  const type = pick(rng, TRAFFIC_TYPES);
  const dims = dimsFor(type);
  const car = {
    id: nextCarId(state),
    x, y, angle, type,
    length: dims.length,
    width: dims.width,
    speed: 0,
    occupied: false,
  };
  state.cars.push(car);
  return car;
}

// Parked cars in a parking-lot block: two rows of nose-in bays.
function parkInLot(state, block, budget) {
  const made = [];
  for (let k = 0; k < 8 && made.length < budget; k++) {
    const col = k % 4;
    const row = Math.floor(k / 4);
    const x = block.x + 50 + col * 72;
    const y = block.y + (row === 0 ? 52 : 284);
    const angle = row === 0 ? Math.PI / 2 : -Math.PI / 2;
    if (state.rng() < 0.25) continue;
    const car = makeParkedCar(state, x, y, angle);
    if (car) made.push(car);
  }
  return made;
}

// A parked car at the curb of a road: parallel to the road, clear of
// intersections so it never blocks a turn.
function parkAtCurb(state) {
  const rng = state.rng;
  const roads = usableRoads(state.city);
  const axis = rng() < 0.5 ? 'v' : 'h';
  const side = rng() < 0.5 ? 1 : -1;
  let along;
  let x;
  let y;
  let angle;
  if (axis === 'v') {
    const road = pick(rng, roads.vertical);
    along = 80 + rng() * (COAST.beachY - 160);
    // Keep clear of every crossing road.
    for (const hr of roads.horizontal) {
      if (Math.abs(along - hr.y) < 70) return null;
    }
    x = road.x + side * CURB_OFFSET;
    y = along;
    angle = side > 0 ? -Math.PI / 2 : Math.PI / 2;
  } else {
    const road = pick(rng, roads.horizontal);
    along = 80 + rng() * (WORLD_WIDTH - 160);
    for (const vr of roads.vertical) {
      if (Math.abs(along - vr.x) < 70) return null;
    }
    x = along;
    y = road.y + side * CURB_OFFSET;
    angle = side > 0 ? Math.PI : 0;
  }
  return makeParkedCar(state, x, y, angle);
}

// Spawn parked cars: first fill parking lots, then curb spots, until
// `count` cars exist or the city runs out of clear spots.
export function spawnParkedCars(state, count = PARKED_TARGET) {
  if (!state || !state.city) return [];
  const made = [];
  const lots = (state.city.blocks || [])
    .filter((b) => b.kind === 'parking lot');
  // Shuffle the lots with the state's RNG so the same seed fills the
  // same lots in the same order.
  for (let i = lots.length - 1; i > 0; i--) {
    const j = Math.floor(state.rng() * (i + 1));
    const tmp = lots[i];
    lots[i] = lots[j];
    lots[j] = tmp;
  }
  for (const lot of lots) {
    if (made.length >= count) break;
    made.push(...parkInLot(state, lot, count - made.length));
  }
  for (let i = made.length; i < count; i++) {
    let car = null;
    for (let attempt = 0; attempt < 10 && !car; attempt++) {
      car = parkAtCurb(state);
    }
    if (car) made.push(car);
    else break;
  }
  return made;
}

// Spawn the initial traffic and parked cars for a fresh game state.
export function spawnVehicles(state) {
  if (!state || !state.city) return state ? state.cars || [] : [];
  spawnTraffic(state, TRAFFIC_TARGET, false);
  spawnParkedCars(state, PARKED_TARGET);
  return state.cars;
}

// Nearest unoccupied car to (x, y) within maxDistance, or null.
// Used by the player-enter-car logic.
export function findNearestUnoccupiedCar(state, x, y, maxDistance = Infinity) {
  let best = null;
  let bestDist = maxDistance;
  for (const car of state.cars || []) {
    if (car.occupied) continue;
    const dx = car.x - x;
    const dy = car.y - y;
    const d = Math.hypot(dx, dy);
    if (d < bestDist) {
      bestDist = d;
      best = car;
    }
  }
  return best;
}

export const nearestUnoccupiedCar = findNearestUnoccupiedCar;
export const findNearestCar = findNearestUnoccupiedCar;

// The car the player is driving, or null.
function drivenCar(state) {
  if (!state.player || state.player.onFoot || state.player.carId == null) {
    return null;
  }
  return (state.cars || []).find((c) => c.id === state.player.carId) || null;
}

// Rebuild routing state for a moving car that has none (for example
// a car another module created): infer its road from its position.
function adoptEntry(state, car) {
  const city = state.city;
  let bestV = null;
  let bestVd = Infinity;
  for (const road of city.roads.vertical) {
    const d = Math.abs(car.x - road.x);
    if (d < bestVd) { bestVd = d; bestV = road.x; }
  }
  let bestH = null;
  let bestHd = Infinity;
  for (const road of city.roads.horizontal) {
    if (road.y >= COAST.beachY) continue;
    const d = Math.abs(car.y - road.y);
    if (d < bestHd) { bestHd = d; bestH = road.y; }
  }
  const axis = bestVd <= bestHd ? 'v' : 'h';
  const road = axis === 'v' ? bestV : bestH;
  const angle = car.angle || 0;
  const dir = axis === 'v'
    ? (Math.sin(angle) >= 0 ? 1 : -1)
    : (Math.cos(angle) >= 0 ? 1 : -1);
  const def = CAR_TYPES[car.type] || CAR_TYPES.sedan;
  const lane = signedLane(axis, dir);
  const entry = {
    axis, road, dir,
    cruise: def.topSpeed * 0.7,
    baseLane: lane,
    lane,
    turning: null,
    lastTurnKey: '',
  };
  traffic.set(car.id, entry);
  return entry;
}

// The nearest car ahead of `car` on its road, within 150 px and in
// the same lane, or null. Ahead is measured along the road direction,
// not the car's nose, so turning cars still read the road correctly.
function carAhead(state, car, entry) {
  const angle = roadAngle(entry.axis, entry.dir);
  const fx = Math.cos(angle);
  const fy = Math.sin(angle);
  let best = null;
  let bestForward = Infinity;
  for (const other of state.cars || []) {
    if (other === car) continue;
    const dx = other.x - car.x;
    const dy = other.y - car.y;
    const forward = dx * fx + dy * fy;
    if (forward <= 0 || forward > 150) continue;
    const lateral = Math.abs(-dx * fy + dy * fx);
    if (lateral > 20) continue;
    if (forward < bestForward) {
      bestForward = forward;
      best = { car: other, forward };
    }
  }
  return best;
}

// True when a car is coming the other way in the opposite lane close
// ahead of `car`, so an overtake would be unsafe.
function oncomingNear(state, car, entry) {
  const angle = roadAngle(entry.axis, entry.dir);
  const fx = Math.cos(angle);
  const fy = Math.sin(angle);
  // Centre of the opposite lane, in world coordinates.
  const oppLane = entry.road - entry.baseLane;
  for (const other of state.cars || []) {
    if (other === car) continue;
    const dx = other.x - car.x;
    const dy = other.y - car.y;
    const forward = dx * fx + dy * fy;
    if (forward < -20 || forward > 140) continue;
    const perp = entry.axis === 'v' ? other.x : other.y;
    if (Math.abs(perp - oppLane) < 20) return true;
  }
  return false;
}

// True when no other car is near the intersection where `car` would
// turn, so a turn does not cut across cross traffic. The intersection
// point is (entry.road, crossing) for a car on a vertical road.
function intersectionClear(state, car, entry, crossing) {
  const ix = entry.axis === 'v' ? entry.road : crossing;
  const iy = entry.axis === 'v' ? crossing : entry.road;
  for (const other of state.cars || []) {
    if (other === car) continue;
    const dx = other.x - ix;
    const dy = other.y - iy;
    if (dx * dx + dy * dy < 160 * 160) return false;
  }
  return true;
}

// Advance one traffic car by dt seconds.
function updateTrafficCar(state, car, entry, dt) {
  const rng = state.rng;
  const def = CAR_TYPES[car.type] || CAR_TYPES.sedan;
  const city = state.city;

  // Desired speed: cruise, slowed for whatever is ahead.
  let desired = entry.cruise;
  const ahead = carAhead(state, car, entry);
  if (ahead) {
    const gapSpeed = Math.max(0, (ahead.forward - 48) * 2.4);
    desired = Math.min(desired, gapSpeed, (ahead.car.speed || 0) + 30);
    // A stopped car ahead is something to overtake, not queue behind.
    if ((ahead.car.speed || 0) < 5 && ahead.forward < 130 &&
        !oncomingNear(state, car, entry)) {
      entry.lane = -entry.baseLane;
    }
  }
  // The obstacle is behind us now: drift back to our own lane.
  if (entry.lane !== entry.baseLane && !ahead) {
    entry.lane = entry.baseLane;
  }

  // Intersection ahead? Decide once per intersection whether to turn.
  if (!entry.turning) {
    const roads = usableRoads(city);
    let crossing = null;
    if (entry.axis === 'v') {
      for (const hr of roads.horizontal) {
        const aheadDist = (hr.y - car.y) * entry.dir;
        if (aheadDist > 0 && aheadDist < 46) { crossing = hr.y; break; }
      }
    } else {
      for (const vr of roads.vertical) {
        const aheadDist = (vr.x - car.x) * entry.dir;
        if (aheadDist > 0 && aheadDist < 46) { crossing = vr.x; break; }
      }
    }
    const key = crossing == null ? '' : `${entry.axis}:${crossing}`;
    if (crossing != null && key !== entry.lastTurnKey && rng() < TURN_CHANCE &&
        intersectionClear(state, car, entry, crossing)) {
      const newAxis = entry.axis === 'v' ? 'h' : 'v';
      const newDir = rng() < 0.5 ? 1 : -1;
      const newLane = signedLane(newAxis, newDir);
      entry.turning = {
        targetAngle: roadAngle(newAxis, newDir),
        newAxis, newRoad: crossing, newDir, newLane,
      };
    }
    entry.lastTurnKey = key;
  }

  // Ease the speed toward the desired speed.
  if (car.speed < desired) {
    car.speed = Math.min(desired, car.speed + def.accel * dt);
  } else if (car.speed > desired) {
    car.speed = Math.max(desired, car.speed - def.accel * 1.5 * dt);
  }
  car.speed = clamp(car.speed, 0, def.topSpeed);

  // Swing the nose around while turning; snap onto the new road once
  // the turn is complete.
  if (entry.turning) {
    const t = entry.turning;
    const diff = ((t.targetAngle - car.angle + Math.PI * 3) %
      (Math.PI * 2)) - Math.PI;
    // Swing rate scales with speed so the turn keeps a fixed radius.
    const turnRate = clamp(car.speed / TURN_RADIUS, 2.5, 10);
    const step = clamp(diff, -turnRate * dt, turnRate * dt);
    car.angle += step;
    if (Math.abs(diff) < 0.06) {
      car.angle = t.targetAngle;
      entry.axis = t.newAxis;
      entry.road = t.newRoad;
      entry.dir = t.newDir;
      entry.baseLane = t.newLane;
      entry.lane = t.newLane;
      entry.turning = null;
      if (entry.axis === 'v') car.x = entry.road + entry.lane;
      else car.y = entry.road + entry.lane;
    }
  }

  // U-turn at the end of a road instead of driving off the map or
  // into the sea: flip direction and swap to the other lane.
  let flipped = false;
  if (entry.axis === 'v' && (car.y < 30 || car.y > COAST.beachY - 30)) {
    entry.dir *= -1;
    flipped = true;
  } else if (entry.axis === 'h' && (car.x < 30 || car.x > WORLD_WIDTH - 30)) {
    entry.dir *= -1;
    flipped = true;
  }
  if (flipped) {
    entry.baseLane = signedLane(entry.axis, entry.dir);
    entry.lane = entry.baseLane;
    entry.turning = null;
    car.angle = roadAngle(entry.axis, entry.dir);
    if (entry.axis === 'v') car.x = entry.road + entry.lane;
    else car.y = entry.road + entry.lane;
  }

  // Advance along the facing, drifting sideways back to the lane.
  const stepX = Math.cos(car.angle) * car.speed * dt;
  const stepY = Math.sin(car.angle) * car.speed * dt;
  let nx = car.x + stepX;
  let ny = car.y + stepY;
  if (!entry.turning) {
    const perp = entry.axis === 'v' ? car.x : car.y;
    const target = entry.road + entry.lane;
    const shift = clamp((target - perp) * 3, -LANE_CORRECT_SPEED,
      LANE_CORRECT_SPEED) * dt;
    if (entry.axis === 'v') nx += shift;
    else ny += shift;
  }
  nx = clamp(nx, 0, WORLD_WIDTH);
  ny = clamp(ny, 0, WORLD_HEIGHT);

  // Never drive through a building: stop at the wall instead.
  if (!isInsideBuilding(city, nx, ny)) {
    car.x = nx;
    car.y = ny;
  } else {
    car.speed = 0;
  }

  // If a shove ever carried the car off its road, pull it back.
  // (Skipped mid-turn: the car is between roads until the turn ends.)
  const perpNow = entry.axis === 'v' ? car.x : car.y;
  if (!entry.turning && Math.abs(perpNow - entry.road) > ROAD_WIDTH / 2 + 4) {
    if (entry.axis === 'v') car.x = entry.road + entry.lane;
    else car.y = entry.road + entry.lane;
  }
}

// Push overlapping cars apart. Parked cars and the player's car are
// immovable here (the player module owns the driven car); traffic
// cars move, split evenly when both can move. Pushing is gentle and
// along the line between the cars, so speeds never explode.
function separateCars(state) {
  const cars = state.cars || [];
  const city = state.city;
  const driven = drivenCar(state);
  for (let i = 0; i < cars.length; i++) {
    for (let j = i + 1; j < cars.length; j++) {
      const a = cars[i];
      const b = cars[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      // Oriented overlap: along/across in A's frame.
      const ca = Math.cos(a.angle || 0);
      const sa = Math.sin(a.angle || 0);
      const alongSigned = dx * ca + dy * sa;
      const acrossSigned = -dx * sa + dy * ca;
      const along = Math.abs(alongSigned);
      const across = Math.abs(acrossSigned);
      const alongLimit = (a.length + b.length) / 2 - 6;
      const acrossLimit = (a.width + b.width) / 2 - 6;
      if (along >= alongLimit || across >= acrossLimit) continue;
      // Push apart along the axis of least penetration, far enough to
      // clear the overlap in one pass.
      let ux;
      let uy;
      let push;
      if (acrossLimit - across < alongLimit - along) {
        const s = acrossSigned >= 0 ? 1 : -1;
        ux = -sa * s;
        uy = ca * s;
        push = (acrossLimit - across) + 1;
      } else {
        const s = alongSigned >= 0 ? 1 : -1;
        ux = ca * s;
        uy = sa * s;
        push = (alongLimit - along) + 1;
      }
      if (!Number.isFinite(ux) || !Number.isFinite(uy)) { ux = ca; uy = sa; }
      const aMovable = a !== driven && traffic.has(a.id);
      const bMovable = b !== driven && traffic.has(b.id);
      if (!aMovable && !bMovable) continue;
      const share = aMovable && bMovable ? push / 2 : push;
      if (aMovable) moveCarSafely(state, a, -ux * share, -uy * share);
      if (bMovable) moveCarSafely(state, b, ux * share, uy * share);
    }
  }
}

// Move a traffic car by (dx, dy), reverting if the move would put it
// inside a building or outside the world.
function moveCarSafely(state, car, dx, dy) {
  const nx = clamp(car.x + dx, 0, WORLD_WIDTH);
  const ny = clamp(car.y + dy, 0, WORLD_HEIGHT);
  if (state.city && isInsideBuilding(state.city, nx, ny)) return;
  car.x = nx;
  car.y = ny;
}

// Advance all vehicles one frame: traffic drives, parked cars stay
// put, the driven car is left entirely to player.js.
export function updateVehicles(state, dt) {
  if (!state || !state.city || !state.cars) return;
  const safeDt = dt > 0 && dt < 1 ? dt : 1 / 60;
  const driven = drivenCar(state);

  for (const car of [...state.cars]) {
    if (car === driven || car.occupied) continue;
    let entry = traffic.get(car.id);
    if (!entry) {
      // A moving car with no routing state is traffic: adopt it.
      // A still car with none is parked: leave it alone.
      if ((car.speed || 0) <= 0) continue;
      entry = adoptEntry(state, car);
    }
    updateTrafficCar(state, car, entry, safeDt);
  }

  separateCars(state);

  // Despawn traffic far from the player, and replace it near them.
  const px = state.player.x;
  const py = state.player.y;
  state.cars = state.cars.filter((car) => {
    if (!traffic.has(car.id)) return true;
    if (car === driven || car.occupied) return true;
    const dx = car.x - px;
    const dy = car.y - py;
    if (dx * dx + dy * dy > DESPAWN_DISTANCE * DESPAWN_DISTANCE) {
      traffic.delete(car.id);
      return false;
    }
    return true;
  });
  let trafficCount = 0;
  for (const car of state.cars) {
    if (traffic.has(car.id)) trafficCount += 1;
  }
  if (trafficCount < TRAFFIC_TARGET) {
    spawnTraffic(state, TRAFFIC_TARGET - trafficCount, true);
  }

  // Last line of defence against bad numbers: no NaN ever escapes.
  for (const car of state.cars) {
    if (!Number.isFinite(car.x) || !Number.isFinite(car.y)) {
      const spot = nearestRoadPoint(state.city, px, py);
      car.x = spot.x;
      car.y = spot.y;
    }
    if (!Number.isFinite(car.speed)) car.speed = 0;
    if (!Number.isFinite(car.angle)) car.angle = 0;
    car.x = clamp(car.x, 0, WORLD_WIDTH);
    car.y = clamp(car.y, 0, WORLD_HEIGHT);
    car.speed = clamp(car.speed || 0, 0, 600);
  }
}

export default updateVehicles;
