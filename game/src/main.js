// Port Vela — game loop and wiring.
// Creates the canvas, the game state, input and audio, spawns the
// initial city life, and runs the requestAnimationFrame loop. The
// loop advances the player, vehicles, pedestrians, police, mission
// and combat in that order, ages particles, moves the camera, then
// draws the world and the HUD. Screen flow: title -> playing ->
// paused / busted / wasted / complete, with Enter to start or retry.
//
// URL parameters:
//   ?seed=<number>  — start from a fixed world seed.
//   ?shot=<scene>   — stage a screenshot scene and jump into play
//                     (chase, street, mission, marina).

import { createGameState } from './state.js';
import { buildCity } from './world.js';
import { createInput } from './input.js';
import { createAudio } from './audio.js';
import { spawnVehicles } from './vehicles.js';
import { spawnInitialCrowd } from './pedestrians.js';
import { updatePlayer } from './player.js';
import { updateVehicles } from './vehicles.js';
import { updatePedestrians } from './pedestrians.js';
import { updatePolice } from './police.js';
import { updateMission } from './missions.js';
import { updateCombat } from './combat.js';
import { drawGame, updateCamera } from './render.js';
import { drawHud } from './hud.js';
import { saveGame, loadGame, applySave } from './save.js';
import { stageScene } from './shots.js';

// A slow frame must never jump the simulation: dt is clamped here.
const MAX_DT = 0.05;
// Autosave every 30 seconds of play.
const AUTOSAVE_INTERVAL = 30;

// Read one URL query parameter, or null when absent.
function queryParam(name) {
  try {
    if (typeof window === 'undefined' || !window.location) return null;
    const params = new URLSearchParams(window.location.search);
    const value = params.get(name);
    return value === '' ? null : value;
  } catch (err) {
    return null;
  }
}

// The world seed: ?seed= when present, otherwise a fresh random one.
function seedFromUrl() {
  const raw = queryParam('seed');
  if (raw != null) {
    const n = Number(raw);
    if (Number.isFinite(n)) return n >>> 0;
  }
  return Math.floor(Math.random() * 4294967296) >>> 0;
}

// Create the canvas, full-window, and its 2D context.
function createCanvas() {
  const canvas = document.createElement('canvas');
  canvas.id = 'port-vela';
  document.body.appendChild(canvas);
  resizeCanvas(canvas);
  return canvas;
}

// Size the canvas to the window (CSS pixels, backing store matched
// for device pixel ratio so the game stays sharp).
function resizeCanvas(canvas) {
  const dpr = (typeof window !== 'undefined' &&
    window.devicePixelRatio) || 1;
  const w = window.innerWidth || 960;
  const h = window.innerHeight || 540;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  canvas.width = Math.max(1, Math.round(w * dpr));
  canvas.height = Math.max(1, Math.round(h * dpr));
  return { width: w, height: h };
}

// Age the particles: decrease each particle's remaining life and
// remove the dead ones. No other module does this, and without it
// particles would accumulate forever.
function ageParticles(state, dt) {
  if (!state.particles) return;
  state.particles = state.particles.filter((p) => {
    p.life = (p.life ?? 0) - dt;
    return p.life > 0;
  });
}

// Build a fresh game: state, city, traffic, parked cars and crowd.
// When a save is supplied, it is applied after the city is built so
// the restored position sits in the saved world.
function newGame(seed, saved) {
  const state = createGameState(seed);
  buildCity(state);
  spawnVehicles(state);
  spawnInitialCrowd(state);
  if (saved) applySave(state, saved);
  return state;
}

// Boot the game. Returns the live handles (state, input, audio) so
// tests or a host page can drive it; the loop starts immediately.
export function boot() {
  const canvas = createCanvas();
  const ctx = canvas.getContext('2d');

  // Load a save automatically when one exists: its seed builds the
  // world, then its cash, mission and player are restored into it.
  const saved = loadGame();
  let state = newGame(saved ? saved.seed : seedFromUrl(), saved);

  const input = createInput(canvas);
  const audio = createAudio();
  let view = { width: canvas.clientWidth || 960,
    height: canvas.clientHeight || 540 };
  let autosaveTimer = 0;
  let lastMissionsCompleted = state.stats.missionsCompleted;
  let lastTime = performance.now();

  // Enter is not tracked by the input object (it only tracks the
  // game keys), so main.js listens for it directly: Enter or Space
  // starts from the title screen, Enter retries after busted,
  // wasted or complete.
  let enterPressed = false;
  function onKeyDown(event) {
    if (event.code === 'Enter' || event.key === 'Enter') {
      enterPressed = true;
      audio.unlock();
    }
  }
  window.addEventListener('keydown', onKeyDown);

  // Keep the canvas fitted to the window.
  function onResize() {
    view = resizeCanvas(canvas);
  }
  window.addEventListener('resize', onResize);

  // Save when the page is hidden, so progress is not lost.
  function onHidden() {
    if (document.visibilityState === 'hidden') saveGame(state);
  }
  document.addEventListener('visibilitychange', onHidden);

  // A ?shot=<scene> parameter stages that scene and jumps straight
  // into play, so screenshots can be taken of it.
  const shot = queryParam('shot');
  if (shot) {
    if (stageScene(state, shot)) {
      audio.unlock();
    }
  }

  // Start a fresh game, keeping the same seed unless a new one is
  // given (a retry after busted/wasted/complete starts a new run).
  function restart() {
    state = newGame(seedFromUrl(), null);
    autosaveTimer = 0;
    lastMissionsCompleted = 0;
    enterPressed = false;
    state.screen = 'playing';
    audio.unlock();
  }

  // One frame of the game, in the fixed update order.
  function frame(now) {
    const rawDt = (now - lastTime) / 1000;
    lastTime = now;
    const dt = Math.min(Math.max(rawDt, 0), MAX_DT);
    const dpr = window.devicePixelRatio || 1;

    // M toggles mute anywhere.
    if (input.consumePressed('mute')) audio.toggleMute();

    if (state.screen === 'title') {
      // Enter or Space starts the game and unlocks the audio.
      if (enterPressed || input.consumePressed('action')) {
        enterPressed = false;
        state.screen = 'playing';
        audio.unlock();
        audio.playClick();
      }
    } else if (state.screen === 'playing') {
      // P or Escape pauses; M was handled above.
      if (input.consumePressed('pause')) {
        state.screen = 'paused';
        audio.playClick();
      } else {
        state.time += dt;
        updatePlayer(state, input, dt);
        updateVehicles(state, dt);
        updatePedestrians(state, dt);
        updatePolice(state, dt);
        updateMission(state, dt);
        updateCombat(state, input, dt);
        ageParticles(state, dt);
        updateCamera(state, dt, view.width, view.height);

        // Autosave every 30 seconds of play, and when a mission
        // completes.
        autosaveTimer += dt;
        if (autosaveTimer >= AUTOSAVE_INTERVAL) {
          autosaveTimer = 0;
          saveGame(state);
        }
        if (state.stats.missionsCompleted > lastMissionsCompleted) {
          lastMissionsCompleted = state.stats.missionsCompleted;
          saveGame(state);
          audio.playMissionComplete();
        }
        if (state.player.health <= 0) state.screen = 'wasted';
      }
    } else if (state.screen === 'paused') {
      if (input.consumePressed('pause')) {
        state.screen = 'playing';
        audio.unlock();
        audio.playClick();
      }
    } else if (state.screen === 'busted' || state.screen === 'wasted' ||
        state.screen === 'complete') {
      // Enter starts a fresh game.
      if (enterPressed) {
        restart();
      }
    }

    // Draw every frame, whatever the screen: the world sits behind
    // the title and pause overlays, and the HUD draws the overlays.
    enterPressed = false;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawGame(state, ctx, view.width, view.height);
    drawHud(state, ctx, view.width, view.height);
    audio.update(state);

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
  return { state, input, audio, canvas, restart };
}

// Start the game as soon as this module loads in the browser.
if (typeof document !== 'undefined' && document.body) {
  boot();
}

export default boot;
