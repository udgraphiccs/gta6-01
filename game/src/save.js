// Port Vela — saving to the browser's local storage.
// Saves only the subset of state that is safe to restore: the world
// seed, cash, stats, mission progress, the player's position and
// health, and the wanted level. Everything is validated on load:
// wrong shapes or missing fields fall back to a fresh game, never
// throw. Every localStorage call is guarded, so the game still runs
// when storage is unavailable (for example in headless testing).

import { PLAYER_MAX_HEALTH, WANTED_MAX } from './config.js';

// Versioned key, so an old save format can never be mistaken for
// the current one.
export const SAVE_KEY = 'port-vela-save-v1';

// The storage object, or null when localStorage is unavailable.
// Accessing window.localStorage itself can throw in some browsers
// (blocked cookies, private mode), so this is guarded too.
function storage() {
  try {
    if (typeof globalThis === 'undefined') return null;
    const s = globalThis.localStorage;
    if (!s || typeof s.getItem !== 'function') return null;
    return s;
  } catch (err) {
    return null;
  }
}

// Finite number or a fallback.
function num(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : fallback;
}

// Non-negative integer or a fallback.
function nonNegInt(value, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const n = Math.floor(value);
  return n < 0 ? fallback : n;
}

// Clamp a number into [min, max].
function clampNum(value, min, max, fallback) {
  const n = num(value, fallback);
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

// Plain object or null.
function plainObject(value) {
  return value !== null && typeof value === 'object' &&
    !Array.isArray(value)
    ? value
    : null;
}

// Validate a parsed save object. Returns a clean save in the exact
// shape saveGame writes, or null when anything essential is wrong.
// Optional fields fall back to safe defaults instead of failing.
export function validateSave(raw) {
  const data = plainObject(raw);
  if (!data) return null;
  if (data.version !== 1) return null;

  const seed = num(data.seed, null);
  if (seed === null) return null;
  const playerRaw = plainObject(data.player);
  if (!playerRaw) return null;
  const px = num(playerRaw.x, null);
  const py = num(playerRaw.y, null);
  if (px === null || py === null) return null;
  const health = num(playerRaw.health, null);
  if (health === null) return null;

  const missionRaw = plainObject(data.mission);
  if (!missionRaw) return null;
  const missionId = missionRaw.id;
  if (missionId !== null && typeof missionId !== 'string') return null;
  const missionData = plainObject(missionRaw.data) || {};
  // The mission objective, when present, must be a real point.
  if (missionData.objective !== undefined &&
      missionData.objective !== null) {
    const obj = plainObject(missionData.objective);
    if (!obj || !Number.isFinite(obj.x) || !Number.isFinite(obj.y)) {
      return null;
    }
  }

  const statsRaw = plainObject(data.stats) || {};
  return {
    version: 1,
    seed: seed >>> 0,
    cash: Math.max(0, num(data.cash, 0)),
    wanted: clampNum(data.wanted, 0, WANTED_MAX, 0) | 0,
    heat: Math.max(0, num(data.heat, 0)),
    player: {
      x: px,
      y: py,
      angle: num(playerRaw.angle, -Math.PI / 2),
      health: clampNum(health, 0, PLAYER_MAX_HEALTH, PLAYER_MAX_HEALTH),
      onFoot: playerRaw.onFoot !== false,
    },
    mission: {
      id: missionId,
      stage: nonNegInt(missionRaw.stage, 0),
      data: missionData,
    },
    stats: {
      missionsCompleted: nonNegInt(statsRaw.missionsCompleted, 0),
      carsStolen: nonNegInt(statsRaw.carsStolen, 0),
      arrestsEscaped: nonNegInt(statsRaw.arrestsEscaped, 0),
      shotsFired: nonNegInt(statsRaw.shotsFired, 0),
    },
  };
}

// Build the save object from a live game state. Cars, police,
// pedestrians, bullets and particles are deliberately left out:
// they are re-spawned fresh around the player on load.
function buildSave(state) {
  const player = state.player || {};
  const mission = state.mission || {};
  const stats = state.stats || {};
  return {
    version: 1,
    seed: state.seed >>> 0,
    cash: Math.max(0, num(state.cash, 0)),
    wanted: clampNum(state.wanted, 0, WANTED_MAX, 0) | 0,
    heat: Math.max(0, num(state.heat, 0)),
    player: {
      x: num(player.x, 0),
      y: num(player.y, 0),
      angle: num(player.angle, -Math.PI / 2),
      health: clampNum(
        player.health, 0, PLAYER_MAX_HEALTH, PLAYER_MAX_HEALTH),
      // The player may have been driving when the game saved, but
      // cars are not saved, so a loaded game always starts on foot.
      onFoot: true,
    },
    mission: {
      id: typeof mission.id === 'string' ? mission.id : null,
      stage: nonNegInt(mission.stage, 0),
      data: plainObject(mission.data) || {},
    },
    stats: {
      missionsCompleted: nonNegInt(stats.missionsCompleted, 0),
      carsStolen: nonNegInt(stats.carsStolen, 0),
      arrestsEscaped: nonNegInt(stats.arrestsEscaped, 0),
      shotsFired: nonNegInt(stats.shotsFired, 0),
    },
  };
}

// Save the current game. Returns true when the save was stored,
// false when storage is unavailable or the state is unusable.
// Never throws.
export function saveGame(state) {
  if (!state || !state.player) return false;
  const store = storage();
  if (!store) return false;
  try {
    store.setItem(SAVE_KEY, JSON.stringify(buildSave(state)));
    return true;
  } catch (err) {
    return false;
  }
}

// Load a saved game. Returns the validated save object, or null
// when there is no save or it is invalid. Never throws.
export function loadGame() {
  const store = storage();
  if (!store) return null;
  let raw;
  try {
    raw = store.getItem(SAVE_KEY);
  } catch (err) {
    return null;
  }
  if (typeof raw !== 'string' || raw.length === 0) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return null;
  }
  return validateSave(parsed);
}

// True when a valid save exists.
export function hasSave() {
  return loadGame() !== null;
}

// Delete the save, if any. Returns true when storage was reachable.
// Never throws.
export function clearSave() {
  const store = storage();
  if (!store) return false;
  try {
    store.removeItem(SAVE_KEY);
    return true;
  } catch (err) {
    return false;
  }
}

// Apply a validated save (from loadGame) onto a live game state
// built from the same seed, so the city matches the saved world.
// The player is placed on foot at the saved position; cars, police
// and pedestrians are left for the caller to spawn fresh. Returns
// true when the save was applied, false when it was not usable.
export function applySave(state, saved) {
  if (!state || !state.player) return false;
  const clean = validateSave(saved);
  if (!clean) return false;
  state.cash = clean.cash;
  state.wanted = clean.wanted;
  state.heat = clean.heat;
  state.player.x = clean.player.x;
  state.player.y = clean.player.y;
  state.player.angle = clean.player.angle;
  state.player.health = clean.player.health;
  state.player.onFoot = true;
  state.player.carId = null;
  state.player.speed = 0;
  state.mission = {
    id: clean.mission.id,
    stage: clean.mission.stage,
    data: clean.mission.data,
  };
  state.stats = { ...clean.stats };
  state.camera.x = clean.player.x;
  state.camera.y = clean.player.y;
  return true;
}

export default saveGame;
