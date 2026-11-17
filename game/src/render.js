// Port Vela — world rendering on a canvas 2D context.
// Draws the ground, roads, blocks, buildings, cars, pedestrians,
// the player, particles and the mission marker, all culled to the
// camera view. Plain ES module; no libraries.

import {
  WORLD_WIDTH,
  WORLD_HEIGHT,
  ROAD_WIDTH,
  COAST,
  DISTRICTS,
  PALETTE,
} from './config.js';
import { clamp, lerp } from './util.js';

// Ground tint per district, so the map reads as distinct neighbourhoods.
const DISTRICT_GROUND = {
  Downtown: '#8a8f7d',
  Marina: '#7f9a8a',
  'Old Town': '#9a8f7a',
  Industrial: '#8d8578',
  Suburbs: '#7fae72',
};

const FALLBACK_GROUND = '#7d8f74';
const CULL_MARGIN = 60;

// World-space rectangle currently visible through the camera.
function viewBounds(state, width, height) {
  const zoom = state.camera.zoom || 1;
  const halfW = width / 2 / zoom;
  const halfH = height / 2 / zoom;
  return {
    x0: state.camera.x - halfW - CULL_MARGIN,
    y0: state.camera.y - halfH - CULL_MARGIN,
    x1: state.camera.x + halfW + CULL_MARGIN,
    y1: state.camera.y + halfH + CULL_MARGIN,
  };
}

// True when a world-space rectangle overlaps the visible view.
function visible(v, x, y, w, h) {
  return x + w >= v.x0 && x <= v.x1 && y + h >= v.y0 && y <= v.y1;
}

function circleVisible(v, x, y, r) {
  return visible(v, x - r, y - r, r * 2, r * 2);
}

// Lighten (positive amount) or darken (negative) a #rrggbb color.
function shade(hex, amount) {
  const n = parseInt(String(hex).slice(1), 16);
  const r = clamp(((n >> 16) & 0xff) + amount, 0, 255);
  const g = clamp(((n >> 8) & 0xff) + amount, 0, 255);
  const b = clamp((n & 0xff) + amount, 0, 255);
  return `rgb(${r},${g},${b})`;
}

// Rounded-rectangle path, so cars work on contexts without roundRect.
function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// A short wavy horizontal line, used for sea and shore waves.
function waveLine(ctx, x0, x1, y, time, phase, color, width) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  for (let x = x0; x <= x1; x += 48) {
    const yy = y + Math.sin(time * 1.6 + x * 0.012 + phase) * 4;
    if (x === x0) ctx.moveTo(x, yy);
    else ctx.lineTo(x, yy);
  }
  ctx.stroke();
}

// Ground: one base tint per district, then beach sand and the sea
// along the south edge, with animated wave lines along the shore.
function drawGround(ctx, state, v) {
  ctx.fillStyle = FALLBACK_GROUND;
  ctx.fillRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
  for (const key of Object.keys(DISTRICTS)) {
    const d = DISTRICTS[key];
    if (!visible(v, d.x, d.y, d.w, d.h)) continue;
    ctx.fillStyle = DISTRICT_GROUND[d.name] || FALLBACK_GROUND;
    ctx.fillRect(d.x, d.y, d.w, d.h);
  }

  // Beach strip, then open sea.
  if (visible(v, 0, COAST.beachY, WORLD_WIDTH, COAST.beachHeight)) {
    ctx.fillStyle = PALETTE.sand;
    ctx.fillRect(0, COAST.beachY, WORLD_WIDTH, COAST.beachHeight);
  }
  if (visible(v, 0, COAST.seaY, WORLD_WIDTH, COAST.seaHeight)) {
    ctx.fillStyle = PALETTE.water;
    ctx.fillRect(0, COAST.seaY, WORLD_WIDTH, COAST.seaHeight);
    for (let i = 0; i < 4; i++) {
      const y = COAST.seaY + 28 + i * 72;
      waveLine(ctx, 0, WORLD_WIDTH, y, state.time, i * 1.7,
        'rgba(255,255,255,0.28)', 2);
    }
    // A few animated lines lapping the sand.
    waveLine(ctx, 0, WORLD_WIDTH, COAST.seaY + 6, state.time, 0.6,
      'rgba(255,255,255,0.45)', 3);
  }
}

// Roads: dark asphalt strips with edge lines and center dashes,
// plus zebra crosswalks where a vertical and horizontal road cross.
function drawRoads(ctx, state, v) {
  const half = ROAD_WIDTH / 2;
  ctx.fillStyle = PALETTE.road;
  for (const road of state.city.roads.vertical) {
    if (!visible(v, road.x - half, 0, ROAD_WIDTH, WORLD_HEIGHT)) continue;
    ctx.fillRect(road.x - half, 0, ROAD_WIDTH, WORLD_HEIGHT);
    ctx.fillStyle = 'rgba(229,232,232,0.55)';
    ctx.fillRect(road.x - half + 3, 0, 2, WORLD_HEIGHT);
    ctx.fillRect(road.x + half - 5, 0, 2, WORLD_HEIGHT);
    ctx.fillStyle = PALETTE.roadLine;
    for (let y = 12; y < WORLD_HEIGHT; y += 56) {
      ctx.fillRect(road.x - 2, y, 4, 26);
    }
    ctx.fillStyle = PALETTE.road;
  }
  for (const road of state.city.roads.horizontal) {
    if (!visible(v, 0, road.y - half, WORLD_WIDTH, ROAD_WIDTH)) continue;
    ctx.fillStyle = PALETTE.road;
    ctx.fillRect(0, road.y - half, WORLD_WIDTH, ROAD_WIDTH);
    ctx.fillStyle = 'rgba(229,232,232,0.55)';
    ctx.fillRect(0, road.y - half + 3, WORLD_WIDTH, 2);
    ctx.fillRect(0, road.y + half - 5, WORLD_WIDTH, 2);
    ctx.fillStyle = PALETTE.roadLine;
    for (let x = 12; x < WORLD_WIDTH; x += 56) {
      ctx.fillRect(x, road.y - 2, 26, 4);
    }
  }
  // Zebra stripes at every intersection, on both approaches.
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  for (const vr of state.city.roads.vertical) {
    for (const hr of state.city.roads.horizontal) {
      if (!visible(v, vr.x - half, hr.y - half, ROAD_WIDTH, ROAD_WIDTH)) {
        continue;
      }
      for (let k = 0; k < 5; k++) {
        const sx = vr.x - half + 6 + k * 11;
        ctx.fillRect(sx, hr.y - half - 14, 6, 12);
        ctx.fillRect(sx, hr.y + half + 2, 6, 12);
        const sy = hr.y - half + 6 + k * 11;
        ctx.fillRect(vr.x - half - 14, sy, 12, 6);
        ctx.fillRect(vr.x + half + 2, sy, 12, 6);
      }
    }
  }
}

// Sidewalks around each block, then the block's own contents:
// parks with trees, plazas with paving, parking lots with bays,
// beach sand and open water.
function drawBlocks(ctx, state, v) {
  for (const block of state.city.blocks) {
    if (!visible(v, block.x - 12, block.y - 12, block.w + 24, block.h + 24)) {
      continue;
    }
    if (block.kind !== 'water') {
      ctx.fillStyle = PALETTE.sidewalk;
      ctx.fillRect(block.x - 10, block.y - 10, block.w + 20, block.h + 20);
    }
    if (block.kind === 'buildings') {
      ctx.fillStyle = '#b0b3b3';
      ctx.fillRect(block.x, block.y, block.w, block.h);
    } else if (block.kind === 'park') {
      ctx.fillStyle = PALETTE.park;
      ctx.fillRect(block.x, block.y, block.w, block.h);
      const park = state.city.parks.find(
        (p) => p.x === block.x && p.y === block.y);
      const trees = park ? park.trees : [];
      for (const tree of trees) {
        if (!circleVisible(v, tree.x, tree.y, 12)) continue;
        ctx.fillStyle = PALETTE.parkTree;
        ctx.beginPath();
        ctx.arc(tree.x, tree.y, 11, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#145a32';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    } else if (block.kind === 'plaza') {
      ctx.fillStyle = '#d5d8dc';
      ctx.fillRect(block.x, block.y, block.w, block.h);
      ctx.strokeStyle = 'rgba(90,100,110,0.4)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let gx = block.x + 42; gx < block.x + block.w; gx += 42) {
        ctx.moveTo(gx, block.y);
        ctx.lineTo(gx, block.y + block.h);
      }
      for (let gy = block.y + 42; gy < block.y + block.h; gy += 42) {
        ctx.moveTo(block.x, gy);
        ctx.lineTo(block.x + block.w, gy);
      }
      ctx.stroke();
    } else if (block.kind === 'parking lot') {
      ctx.fillStyle = '#4a4d4f';
      ctx.fillRect(block.x, block.y, block.w, block.h);
      ctx.strokeStyle = 'rgba(229,232,232,0.8)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let bx = block.x + 14; bx < block.x + block.w - 10; bx += 30) {
        ctx.moveTo(bx, block.y + 16);
        ctx.lineTo(bx, block.y + 64);
      }
      ctx.stroke();
    } else if (block.kind === 'beach') {
      ctx.fillStyle = PALETTE.sand;
      ctx.fillRect(block.x, block.y, block.w, block.h);
    } else if (block.kind === 'water') {
      ctx.fillStyle = PALETTE.water;
      ctx.fillRect(block.x, block.y, block.w, block.h);
    }
  }
  // Sea water with animated wave lines.
  for (const w of state.city.water) {
    if (!visible(v, w.x, w.y, w.w, w.h)) continue;
    ctx.fillStyle = PALETTE.water;
    ctx.fillRect(w.x, w.y, w.w, w.h);
    for (let i = 0; i < 3; i++) {
      waveLine(ctx, w.x, w.x + w.w, w.y + 50 + i * 90, state.time, i * 2.1,
        'rgba(255,255,255,0.22)', 2);
    }
  }
}

// Buildings: a dark offset shadow for fake height, the body, a lighter
// rooftop, and a grid of windows on larger buildings.
function drawBuildings(ctx, state, v) {
  for (const b of state.city.buildings) {
    if (!visible(v, b.x, b.y, b.width, b.height)) continue;
    const lift = (b.elevation || 20) * 0.25;
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(b.x + lift, b.y + lift, b.width, b.height);
    ctx.fillStyle = b.color || PALETTE.building;
    ctx.fillRect(b.x, b.y, b.width, b.height);
    ctx.fillStyle = shade(b.color || PALETTE.building, 30);
    ctx.fillRect(b.x + 6, b.y + 6, b.width - 12, b.height - 12);
    if (b.width >= 90 && b.height >= 90) {
      const cols = Math.floor((b.width - 24) / 22);
      const rows = Math.floor((b.height - 24) / 22);
      for (let ix = 0; ix < cols; ix++) {
        for (let iy = 0; iy < rows; iy++) {
          const lit = (ix * 7 + iy * 13 + b.x) % 5 === 0;
          ctx.fillStyle = lit ? '#f7dc6f' : 'rgba(20,30,40,0.55)';
          ctx.fillRect(b.x + 14 + ix * 22, b.y + 14 + iy * 22, 10, 12);
        }
      }
    }
  }
}

// Cars: a rounded body in its own color, windshield, roof, headlights
// and taillights, rotated to the facing angle. Police cars get a light
// bar that flashes red and blue with the game time.
function drawCars(ctx, state, v) {
  const seen = new Set(state.cars);
  const all = [...state.cars];
  for (const p of state.police || []) {
    if (!seen.has(p)) all.push(p);
  }
  for (const car of all) {
    const len = car.length || (car.type === 'truck' ? 64 : 44);
    const wid = car.width || (car.type === 'truck' ? 26 : 22);
    if (!circleVisible(v, car.x, car.y, len)) continue;
    const angle = car.angle ?? car.heading ?? car.rotation ?? 0;
    const isPolice = car.type === 'police' || car.isPolice || car.police;
    ctx.save();
    ctx.translate(car.x, car.y);
    ctx.rotate(angle);
    roundRectPath(ctx, -len / 2, -wid / 2, len, wid, 6);
    ctx.fillStyle = car.color || car.bodyColor || '#7f8c8d';
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = 'rgba(174,214,241,0.9)';
    ctx.fillRect(len * 0.18, -wid / 2 + 3, len * 0.14, wid - 6);
    ctx.fillStyle = shade(car.color || car.bodyColor || '#7f8c8d', -28);
    ctx.fillRect(-len * 0.12, -wid / 2 + 4, len * 0.28, wid - 8);
    if (isPolice) {
      const phase = Math.floor(state.time * 3) % 2 === 0;
      ctx.fillStyle = phase ? '#e74c3c' : '#2471a3';
      ctx.fillRect(-4, -wid / 2 + 2, 8, 6);
      ctx.fillStyle = phase ? '#2471a3' : '#e74c3c';
      ctx.fillRect(-4, wid / 2 - 8, 8, 6);
    }
    ctx.fillStyle = '#fef9e7';
    ctx.fillRect(len / 2 - 3, -wid / 2 + 2, 3, 5);
    ctx.fillRect(len / 2 - 3, wid / 2 - 7, 3, 5);
    ctx.fillStyle = '#c0392b';
    ctx.fillRect(-len / 2, -wid / 2 + 2, 3, 5);
    ctx.fillRect(-len / 2, wid / 2 - 7, 3, 5);
    ctx.restore();
  }
}

// Pedestrians: small circles in varied shirt colors, with a tick
// showing which way they face.
function drawPedestrians(ctx, state, v) {
  const shirts = ['#e74c3c', '#2e86c1', '#f1c40f', '#8e44ad', '#16a085',
    '#e67e22', '#ecf0f1', '#1abc9c'];
  (state.pedestrians || []).forEach((ped, i) => {
    if (!circleVisible(v, ped.x, ped.y, 9)) return;
    const angle = ped.angle ?? ped.heading ?? 0;
    ctx.fillStyle = ped.color || ped.shirtColor || shirts[i % shirts.length];
    ctx.beginPath();
    ctx.arc(ped.x, ped.y, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(ped.x, ped.y);
    ctx.lineTo(ped.x + Math.cos(angle) * 10, ped.y + Math.sin(angle) * 10);
    ctx.stroke();
  });
}

// The player on foot: a distinct figure with a bright outline,
// hidden while driving.
function drawPlayer(ctx, state, v) {
  const player = state.player;
  if (!player.onFoot) return;
  if (!circleVisible(v, player.x, player.y, 12)) return;
  ctx.fillStyle = '#2ecc71';
  ctx.beginPath();
  ctx.arc(player.x, player.y, 10, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#f1c40f';
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(player.x, player.y, 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.7)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(player.x, player.y);
  ctx.lineTo(
    player.x + Math.cos(player.angle) * 14,
    player.y + Math.sin(player.angle) * 14);
  ctx.stroke();
}

// Particles: smoke puffs, sparks, muzzle flashes and skid marks,
// each fading out over its remaining life.
function drawParticles(ctx, state, v) {
  for (const p of state.particles || []) {
    if (!circleVisible(v, p.x, p.y, 24)) continue;
    const life = p.life ?? 1;
    const max = p.maxLife ?? 1;
    const alpha = p.alpha ?? clamp(life / max, 0, 1);
    const kind = p.type || p.kind || 'smoke';
    if (kind === 'smoke') {
      ctx.fillStyle = `rgba(200,200,200,${(alpha * 0.5).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size || p.radius || 8, 0, Math.PI * 2);
      ctx.fill();
    } else if (kind === 'spark') {
      ctx.fillStyle = `rgba(247,220,111,${alpha.toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size || 3, 0, Math.PI * 2);
      ctx.fill();
    } else if (kind === 'muzzle') {
      ctx.fillStyle = `rgba(249,231,159,${alpha.toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size || 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = `rgba(255,255,255,${alpha.toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, (p.size || 10) * 0.45, 0, Math.PI * 2);
      ctx.fill();
    } else if (kind === 'skid') {
      const a = p.angle || 0;
      const len = p.length || 18;
      ctx.strokeStyle = `rgba(0,0,0,${(alpha * 0.6).toFixed(3)})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x + Math.cos(a) * len, p.y + Math.sin(a) * len);
      ctx.stroke();
    } else {
      ctx.fillStyle = p.color || '#ffffff';
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size || 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }
}

// Where the current mission wants the player to go: the mission data
// may carry it as data.objective, data.target, or a top-level field.
function missionObjective(state) {
  const m = state.mission || {};
  const data = m.data || {};
  return data.objective || data.target || m.objective || state.objective ||
    null;
}

function drawMissionMarker(ctx, state, v) {
  const target = missionObjective(state);
  if (!target || typeof target.x !== 'number' || typeof target.y !== 'number') {
    return;
  }
  if (!circleVisible(v, target.x, target.y, 40)) return;
  const pulse = 16 + Math.sin(state.time * 4) * 5;
  ctx.strokeStyle = 'rgba(241,196,15,0.9)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(target.x, target.y, pulse, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(target.x, target.y);
  ctx.lineTo(target.x, target.y - 34);
  ctx.stroke();
  ctx.fillStyle = '#e74c3c';
  ctx.beginPath();
  ctx.moveTo(target.x, target.y - 34);
  ctx.lineTo(target.x + 18, target.y - 28);
  ctx.lineTo(target.x, target.y - 22);
  ctx.closePath();
  ctx.fill();
}

// Draw the whole game: world-space layers under the camera transform,
// then the warm sun tint and the edge vignette in screen space.
export function drawGame(state, ctx, width, height) {
  const zoom = state.camera.zoom || 1;
  ctx.save();
  ctx.clearRect(0, 0, width, height);
  ctx.translate(width / 2, height / 2);
  ctx.scale(zoom, zoom);
  ctx.translate(-state.camera.x, -state.camera.y);

  const v = viewBounds(state, width, height);
  if (state.city) {
    drawGround(ctx, state, v);
    drawRoads(ctx, state, v);
    drawBlocks(ctx, state, v);
    drawBuildings(ctx, state, v);
  } else {
    ctx.fillStyle = FALLBACK_GROUND;
    ctx.fillRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
  }
  drawCars(ctx, state, v);
  drawPedestrians(ctx, state, v);
  drawPlayer(ctx, state, v);
  drawParticles(ctx, state, v);
  drawMissionMarker(ctx, state, v);
  ctx.restore();

  // Warm sun tint over everything, then a soft dark vignette.
  ctx.fillStyle = 'rgba(255,190,90,0.05)';
  ctx.fillRect(0, 0, width, height);
  if (typeof ctx.createRadialGradient === 'function') {
    const cx = width / 2;
    const cy = height / 2;
    const outer = Math.hypot(cx, cy);
    const grad = ctx.createRadialGradient(cx, cy, outer * 0.45, cx, cy, outer);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, 'rgba(0,0,0,0.32)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);
  }
}

// Smoothly follow the player — or the player's car while driving —
// and clamp the camera so it never shows outside the world bounds.
// viewWidth/viewHeight are CSS pixels; they default to a 960x540 view.
export function updateCamera(state, dt = 1 / 60, viewWidth = 960,
  viewHeight = 540) {
  let target = state.player;
  if (!state.player.onFoot && state.player.carId != null) {
    const car = (state.cars || []).find((c) => c.id === state.player.carId);
    if (car) target = car;
  }
  const step = dt > 0 ? 1 - Math.exp(-5 * dt) : 1;
  state.camera.x = lerp(state.camera.x, target.x, step);
  state.camera.y = lerp(state.camera.y, target.y, step);
  const zoom = state.camera.zoom || 1;
  const halfW = viewWidth / 2 / zoom;
  const halfH = viewHeight / 2 / zoom;
  state.camera.x = halfW * 2 >= WORLD_WIDTH
    ? WORLD_WIDTH / 2
    : clamp(state.camera.x, halfW, WORLD_WIDTH - halfW);
  state.camera.y = halfH * 2 >= WORLD_HEIGHT
    ? WORLD_HEIGHT / 2
    : clamp(state.camera.y, halfH, WORLD_HEIGHT - halfH);
}

export { drawGame as render };
export default drawGame;
