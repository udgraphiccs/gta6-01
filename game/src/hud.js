// Port Vela — heads-up display and screen overlays.
// Drawn on the same 2D canvas context as the world, after render.js
// has painted the game. Every draw is defensive: missing or malformed
// state fields fall back to safe defaults instead of throwing.

import {
  WORLD_WIDTH,
  WORLD_HEIGHT,
  DISTRICTS,
  COAST,
  PLAYER_MAX_HEALTH,
  WANTED_MAX,
} from './config.js';
import { clamp } from './util.js';
import { currentMission } from './missions.js';

// Small ground tints for the minimap, one per district.
const MINIMAP_GROUND = {
  Downtown: '#8a8f7d',
  Marina: '#7f9a8a',
  'Old Town': '#9a8f7a',
  Industrial: '#8d8578',
  Suburbs: '#7fae72',
};

const CONTROLS = [
  ['W A S D / Arrows', 'Move / drive'],
  ['Shift', 'Sprint'],
  ['E', 'Enter / exit car'],
  ['Space', 'Punch / shoot'],
  ['P or Esc', 'Pause'],
  ['M', 'Mute sound'],
];

// Finite number or a fallback, so bad state can never break a draw.
function num(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

// A translucent dark panel with a thin light border.
function panel(ctx, x, y, w, h, alpha = 0.55) {
  ctx.fillStyle = `rgba(10,14,20,${alpha})`;
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
}

// One line of text, left-aligned by default.
function text(ctx, str, x, y, size = 14, color = '#ffffff',
  align = 'left', bold = false) {
  ctx.fillStyle = color;
  ctx.font = `${bold ? 'bold ' : ''}${size}px sans-serif`;
  ctx.textAlign = align;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(String(str ?? ''), x, y);
}

// A five-pointed star path centred on (cx, cy).
function starPath(ctx, cx, cy, outer, inner) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const px = cx + Math.cos(a) * r;
    const py = cy + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

// The mission objective marker: data.objective, data.target, or a
// top-level field, mirroring the shape render.js reads.
function missionObjective(state) {
  const m = state.mission || {};
  const data = m.data || {};
  const t = data.objective || data.target || m.objective ||
    state.objective || null;
  if (!t || !Number.isFinite(t.x) || !Number.isFinite(t.y)) return null;
  return t;
}

// Wanted stars, top right: filled gold stars up to the current
// wanted level, dim outlines for the rest (0 to 5).
function drawWanted(ctx, state, width) {
  const wanted = clamp(Math.round(num(state.wanted, 0)), 0, WANTED_MAX);
  const size = 13;
  const gap = 26;
  const total = WANTED_MAX * gap;
  const x0 = width - 16 - total;
  const y = 30;
  text(ctx, 'WANTED', x0, y - 18, 11, 'rgba(255,255,255,0.75)', 'left', true);
  for (let i = 0; i < WANTED_MAX; i++) {
    const cx = x0 + i * gap + size;
    starPath(ctx, cx, y, size, size * 0.45);
    if (i < wanted) {
      ctx.fillStyle = '#f1c40f';
      ctx.fill();
      ctx.strokeStyle = '#7d6608';
    } else {
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    }
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

// Health bar and cash, top left.
function drawHealthCash(ctx, state) {
  const player = state.player || {};
  const health = clamp(num(player.health, PLAYER_MAX_HEALTH),
    0, PLAYER_MAX_HEALTH);
  const frac = PLAYER_MAX_HEALTH > 0 ? health / PLAYER_MAX_HEALTH : 0;
  text(ctx, 'HEALTH', 16, 22, 11, 'rgba(255,255,255,0.75)', 'left', true);
  panel(ctx, 16, 28, 180, 16, 0.45);
  ctx.fillStyle = frac > 0.5 ? '#2ecc71'
    : frac > 0.25 ? '#f39c12' : '#e74c3c';
  ctx.fillRect(18, 30, 176 * frac, 12);
  text(ctx, `${Math.ceil(health)}`, 202, 41, 13, '#ffffff', 'left', true);
  const cash = Math.max(0, Math.floor(num(state.cash, 0)));
  text(ctx, `$${cash.toLocaleString('en-US')}`, 16, 70, 20, '#f7dc6f',
    'left', true);
}

// Current mission title, objective and any stage timer, top centre.
function drawMission(ctx, state, width) {
  const mission = currentMission(state);
  if (!mission) return;
  const stage = mission.stages[state.mission.stage] || mission.stages[0];
  const lines = [mission.title];
  if (stage && stage.label) lines.push(stage.label);
  const data = (state.mission && state.mission.data) || {};
  if (Number.isFinite(data.timer) && data.timer > 0) {
    lines.push(`Time left: ${Math.ceil(data.timer)}s`);
  }
  const w = 360;
  const h = 22 + lines.length * 18;
  const x = (width - w) / 2;
  panel(ctx, x, 12, w, h, 0.5);
  lines.forEach((line, i) => {
    text(ctx, line, width / 2, 32 + i * 18, i === 0 ? 14 : 13,
      i === 0 ? '#f1c40f' : '#ffffff', 'center', i === 0);
  });
}

// The recent message feed, bottom left, newest last.
function drawMessages(ctx, state, height) {
  const messages = Array.isArray(state.messages) ? state.messages : [];
  const shown = messages.slice(-4);
  shown.forEach((msg, i) => {
    const y = height - 16 - (shown.length - 1 - i) * 18;
    text(ctx, msg, 16, y, 13, 'rgba(255,255,255,0.9)');
  });
}

// Speed while driving, above the minimap: px/s converted to a
// road-speed number, plus an "ON FOOT" hint otherwise.
function drawSpeed(ctx, state, width, height) {
  const player = state.player || {};
  const y = height - 168;
  if (player.onFoot) {
    text(ctx, 'ON FOOT — press E near a car to drive', width - 16, y,
      12, 'rgba(255,255,255,0.75)', 'right');
    return;
  }
  const mph = Math.round(Math.abs(num(player.speed, 0)) * 0.14);
  text(ctx, `${mph}`, width - 16, y, 30, '#ffffff', 'right', true);
  text(ctx, 'MPH', width - 16, y + 18, 11,
    'rgba(255,255,255,0.75)', 'right', true);
}

// Minimap, bottom right: a cheap scaled-down view of the whole city.
// District tints, road strips and the sea, then dots for the player,
// police, traffic and the mission objective. Kept light on purpose:
// a handful of fills plus one dot per car, every frame.
export function drawMinimap(ctx, state, width, height) {
  const mapW = 180;
  const mapH = Math.round(mapW * WORLD_HEIGHT / WORLD_WIDTH);
  const x0 = width - mapW - 12;
  const y0 = height - mapH - 12;
  const sx = mapW / WORLD_WIDTH;
  const sy = mapH / WORLD_HEIGHT;
  const px = (wx) => x0 + num(wx, 0) * sx;
  const py = (wy) => y0 + num(wy, 0) * sy;

  panel(ctx, x0 - 4, y0 - 4, mapW + 8, mapH + 8, 0.55);
  ctx.fillStyle = '#7d8f74';
  ctx.fillRect(x0, y0, mapW, mapH);
  for (const key of Object.keys(DISTRICTS)) {
    const d = DISTRICTS[key];
    ctx.fillStyle = MINIMAP_GROUND[d.name] || '#7d8f74';
    ctx.fillRect(px(d.x), py(d.y), d.w * sx, d.h * sy);
  }
  // Sea along the south edge.
  ctx.fillStyle = '#2471a3';
  ctx.fillRect(x0, py(COAST.seaY), mapW, COAST.seaHeight * sy);
  // Roads as thin strips; cheap enough at this scale.
  ctx.fillStyle = '#3a3f44';
  const city = state.city;
  if (city && city.roads) {
    for (const road of city.roads.vertical || []) {
      ctx.fillRect(px(road.x) - 1, y0, 2, mapH);
    }
    for (const road of city.roads.horizontal || []) {
      ctx.fillRect(x0, py(road.y) - 1, mapW, 2);
    }
  }
  const dot = (wx, wy, r, color) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(px(wx), py(wy), r, 0, Math.PI * 2);
    ctx.fill();
  };
  // Traffic cars, then police, then the objective, then the player
  // on top so it is never hidden.
  for (const car of state.cars || []) {
    dot(car.x, car.y, 1.5, 'rgba(255,255,255,0.8)');
  }
  const flashing = Math.floor(num(state.time, 0) * 3) % 2 === 0;
  for (const car of state.police || []) {
    dot(car.x, car.y, 2.5, flashing ? '#e74c3c' : '#2471a3');
  }
  const target = missionObjective(state);
  if (target) {
    const pulse = 3 + Math.sin(num(state.time, 0) * 4) * 1;
    dot(target.x, target.y, pulse, '#f1c40f');
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(px(target.x), py(target.y), pulse + 2, 0, Math.PI * 2);
    ctx.stroke();
  }
  const player = state.player || {};
  dot(player.x, player.y, 3.5, '#2ecc71');
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(px(player.x), py(player.y), 4.5, 0, Math.PI * 2);
  ctx.stroke();
  text(ctx, 'PORT VELA', x0, y0 - 8, 10, 'rgba(255,255,255,0.8)',
    'left', true);
}

// A dimmed full-screen overlay with a centred title, subtitle lines
// and an optional prompt at the bottom.
function overlay(ctx, width, height, title, lines, prompt, color) {
  ctx.fillStyle = 'rgba(8,12,18,0.72)';
  ctx.fillRect(0, 0, width, height);
  const cx = width / 2;
  text(ctx, title, cx, height / 2 - 90, 44, color || '#f1c40f',
    'center', true);
  lines.forEach((line, i) => {
    text(ctx, line, cx, height / 2 - 44 + i * 22, 15, '#ffffff', 'center');
  });
  if (prompt) {
    const blink = Math.floor(Date.now() / 500) % 2 === 0;
    if (blink) {
      text(ctx, prompt, cx, height / 2 + 64, 16, '#f7dc6f', 'center', true);
    }
  }
}

// Title screen: game name, tagline, controls and the start prompt.
function drawTitle(ctx, width, height) {
  overlay(ctx, width, height, 'PORT VELA', [
    'Sun, sea and second chances — one driver, one city, one last run.',
    'Jay Carter is back in Port Vela. Mama Rosa has jobs. Pix has plans.',
    'Take the wheel, keep the heat low, and own the streets.',
  ], 'Press Enter to start');
  const y0 = height / 2 + 96;
  text(ctx, 'CONTROLS', width / 2, y0, 12, 'rgba(255,255,255,0.7)',
    'center', true);
  CONTROLS.forEach((row, i) => {
    const y = y0 + 20 + i * 18;
    text(ctx, row[0], width / 2 - 10, y, 13, '#f1c40f', 'right', true);
    text(ctx, row[1], width / 2 + 10, y, 13, '#ffffff', 'left');
  });
}

// Paused screen.
function drawPaused(ctx, width, height) {
  overlay(ctx, width, height, 'PAUSED', [
    'Port Vela is holding its breath.',
    'Press P or Esc to get back behind the wheel.',
  ], null);
}

// Busted screen: arrested by the Port Vela police.
function drawBusted(ctx, width, height) {
  overlay(ctx, width, height, 'BUSTED', [
    'The Port Vela police finally caught up with Jay Carter.',
    'The cell door closes. The city moves on without you.',
  ], 'Press Enter to try again', '#2471a3');
}

// Wasted screen: health ran out.
function drawWasted(ctx, width, height) {
  overlay(ctx, width, height, 'WASTED', [
    'Jay Carter is down. The sunset over the Marina keeps going.',
    'Mama Rosa is already finding a new driver.',
  ], 'Press Enter to try again', '#e74c3c');
}

// Complete screen: the story is finished, with final stats.
function drawComplete(ctx, state, width, height) {
  const stats = state.stats || {};
  const cash = Math.max(0, Math.floor(num(state.cash, 0)));
  overlay(ctx, width, height, 'PORT VELA IS YOURS', [
    'Every job done. Mama Rosa is proud, Pix is rich, and Jay Carter',
    'owns the streets from Old Town to the Marina.',
    '',
    `Cash earned: $${cash.toLocaleString('en-US')}`,
    `Missions completed: ${num(stats.missionsCompleted, 0)}`,
    `Cars stolen: ${num(stats.carsStolen, 0)}`,
    `Arrests escaped: ${num(stats.arrestsEscaped, 0)}`,
    `Shots fired: ${num(stats.shotsFired, 0)}`,
  ], 'Press Enter to play again', '#2ecc71');
}

// Draw the whole HUD and the current screen overlay. state is the
// game state, ctx is the 2D canvas context, width/height are canvas
// CSS pixels. Safe to call with a partial or empty state.
export function drawHud(state, ctx, width, height) {
  if (!ctx || typeof ctx.fillRect !== 'function') return;
  const safe = state && typeof state === 'object' ? state : {};
  const w = Number.isFinite(width) && width > 0 ? width : 960;
  const h = Number.isFinite(height) && height > 0 ? height : 540;
  const screen = safe.screen || 'title';
  ctx.save();
  try {
    if (screen === 'playing') {
      drawWanted(ctx, safe, w);
      drawHealthCash(ctx, safe);
      drawMission(ctx, safe, w);
      drawMessages(ctx, safe, h);
      drawSpeed(ctx, safe, w, h);
      drawMinimap(ctx, safe, w, h);
    } else if (screen === 'paused') {
      drawWanted(ctx, safe, w);
      drawHealthCash(ctx, safe);
      drawMission(ctx, safe, w);
      drawMinimap(ctx, safe, w, h);
      drawPaused(ctx, w, h);
    } else if (screen === 'busted') {
      drawBusted(ctx, w, h);
    } else if (screen === 'wasted') {
      drawWasted(ctx, w, h);
    } else if (screen === 'complete') {
      drawComplete(ctx, safe, w, h);
    } else {
      // 'title' and anything unknown: the title screen.
      drawTitle(ctx, w, h);
    }
  } finally {
    ctx.restore();
  }
}

export { drawHud as drawHUD };
export default drawHud;
