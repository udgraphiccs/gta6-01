// Port Vela — staged scenes for screenshots.
// Sets up a live game state so a screenshot of it looks alive:
// the player, camera, cars, police and mission are placed with the
// real modules (vehicles, police, missions), never faked. The game
// is left on the 'playing' screen, ready to render.
//
// Scenes:
//   'chase'   — driving downtown with police chasing, wanted level up.
//   'street'  — on foot downtown among pedestrians and traffic.
//   'mission' — a mission in progress with its objective marker visible.
//   'marina'  — on foot near the Marina, by the beach and the sea.

import { WORLD_WIDTH, WORLD_HEIGHT, DISTRICTS, COAST, CAR_TYPES } from './config.js';
import { clamp } from './util.js';
import { buildCity, nearestRoadPoint } from './world.js';
import { spawnTraffic, spawnParkedCars } from './vehicles.js';
import { spawnPedestrians } from './pedestrians.js';
import { spawnPolice } from './police.js';
import { startMission } from './missions.js';

export const SCENES = ['chase', 'street', 'mission', 'marina'];

// Snap the camera straight onto the player, so the first rendered
// frame already shows the staged scene (no smooth pan to wait for).
function snapCamera(state) {
  state.camera.x = clamp(state.player.x, 0, WORLD_WIDTH);
  state.camera.y = clamp(state.player.y, 0, WORLD_HEIGHT);
}

// Make sure the state has a city and a living street around the
// player: traffic, parked cars and pedestrians nearby.
function ensureCityLife(state) {
  if (!state.city) buildCity(state);
  if (!state.cars || state.cars.length === 0) {
    spawnTraffic(state, 18, true);
    spawnParkedCars(state, 16);
  }
  if (!state.pedestrians || state.pedestrians.length === 0) {
    spawnPedestrians(state, 24, true);
  }
}

// Put the player on foot at (x, y), facing `angle`, and snap the
// camera onto them.
function placeOnFoot(state, x, y, angle) {
  state.player.x = clamp(x, 0, WORLD_WIDTH);
  state.player.y = clamp(y, 0, WORLD_HEIGHT);
  state.player.angle = angle;
  state.player.speed = 0;
  state.player.onFoot = true;
  state.player.carId = null;
  snapCamera(state);
}

// Put the player in the driver's seat of a car at (x, y). Reuses a
// nearby unoccupied car when one is close, otherwise builds a
// sports car on the spot in the exact shape the other modules use.
function placeDriving(state, x, y, angle) {
  let car = null;
  for (const c of state.cars || []) {
    if (c.occupied) continue;
    if (Math.hypot(c.x - x, c.y - y) < 120) {
      car = c;
      break;
    }
  }
  if (!car) {
    let max = 0;
    for (const c of state.cars || []) {
      const m = /^car-(\d+)$/.exec(String(c.id || ''));
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    car = {
      id: `car-${max + 1}`,
      x: clamp(x, 0, WORLD_WIDTH),
      y: clamp(y, 0, WORLD_HEIGHT),
      angle,
      type: 'sports',
      length: 46,
      width: 22,
      speed: 220,
      occupied: true,
    };
    state.cars.push(car);
  }
  car.x = clamp(x, 0, WORLD_WIDTH);
  car.y = clamp(y, 0, WORLD_HEIGHT);
  car.angle = angle;
  car.occupied = true;
  car.speed = Math.max(car.speed || 0, 180);
  state.player.x = car.x;
  state.player.y = car.y;
  state.player.angle = angle;
  state.player.speed = car.speed;
  state.player.onFoot = false;
  state.player.carId = car.id;
  snapCamera(state);
  return car;
}

// The player driving downtown with police on their tail: wanted
// level 3, police cars spawned near the player by the police module.
// The staged car is a sports car at full speed, so the scene opens
// mid-flight instead of coasting to a stop before the shot is taken.
function stageChase(state) {
  const downtown = DISTRICTS.downtown;
  const cx = downtown.x + downtown.w / 2;
  const cy = downtown.y + downtown.h / 2;
  const road = nearestRoadPoint(state.city, cx, cy) || { x: cx, y: cy };
  ensureCityLife(state);
  const car = placeDriving(state, road.x, road.y, 0);
  car.type = 'sports';
  car.length = 46;
  car.width = 22;
  car.speed = CAR_TYPES.sports.topSpeed;
  state.player.speed = car.speed;
  state.wanted = 3;
  state.heat = 36;
  spawnPolice(state);
}

// The player on foot downtown, in the middle of the crowd and the
// traffic, with no wanted level.
function stageStreet(state) {
  const downtown = DISTRICTS.downtown;
  const cx = downtown.x + downtown.w / 2;
  const cy = downtown.y + downtown.h / 2;
  const road = nearestRoadPoint(state.city, cx, cy) || { x: cx, y: cy };
  ensureCityLife(state);
  spawnPedestrians(state, 12, true);
  spawnTraffic(state, 6, true);
  state.wanted = 0;
  state.heat = 0;
  placeOnFoot(state, road.x, road.y, -Math.PI / 2);
}

// A mission in progress with its objective marker visible: start
// the first job, then stand the player a short walk from the marker
// so the marker, the player and the street are all in frame.
function stageMission(state) {
  ensureCityLife(state);
  if (!state.mission.id) startMission(state);
  const data = state.mission.data || {};
  const target = data.objective;
  if (target && Number.isFinite(target.x) && Number.isFinite(target.y)) {
    const dx = state.player.x - target.x;
    const dy = state.player.y - target.y;
    const d = Math.hypot(dx, dy) || 1;
    // Stand about 260 px from the marker, on the road toward it.
    const px = target.x + (dx / d) * 260;
    const py = target.y + (dy / d) * 260;
    const road = nearestRoadPoint(state.city, px, py) || { x: px, y: py };
    placeOnFoot(state, road.x, road.y,
      Math.atan2(target.y - road.y, target.x - road.x));
  } else {
    const downtown = DISTRICTS.downtown;
    const road = nearestRoadPoint(state.city,
      downtown.x + downtown.w / 2, downtown.y + downtown.h / 2) ||
      { x: downtown.x, y: downtown.y };
    placeOnFoot(state, road.x, road.y, -Math.PI / 2);
  }
}

// The player on foot in the Marina, down by the beach with the sea
// behind them, among a few strollers and parked cars.
function stageMarina(state) {
  ensureCityLife(state);
  const marina = DISTRICTS.marina;
  const x = marina.x + marina.w / 2;
  // On the sand, just north of the waterline.
  const y = COAST.beachY + COAST.beachHeight / 2;
  spawnPedestrians(state, 8, true);
  state.wanted = 0;
  state.heat = 0;
  placeOnFoot(state, x, y, Math.PI / 2);
}

// Stage a scene in a live game state and jump straight into play.
// Returns true when the scene was staged, false for an unknown
// scene name (the state is left untouched in that case).
export function stageScene(state, scene) {
  if (!state || !state.player || !state.camera) return false;
  if (!state.city) buildCity(state);
  switch (scene) {
    case 'chase':
      stageChase(state);
      break;
    case 'street':
      stageStreet(state);
      break;
    case 'mission':
      stageMission(state);
      break;
    case 'marina':
      stageMarina(state);
      break;
    default:
      return false;
  }
  state.screen = 'playing';
  return true;
}

export default stageScene;
