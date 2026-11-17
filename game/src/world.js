// Port Vela — procedural city generation and spatial queries.
// The city is built deterministically from the state's seeded RNG:
// the same seed always produces the same roads, blocks and buildings.

import {
  WORLD_WIDTH,
  WORLD_HEIGHT,
  ROAD_SPACING,
  ROAD_WIDTH,
  BLOCK_SIZE,
  COAST,
  DISTRICTS,
} from './config.js';
import { pick, randInt, clamp } from './util.js';

// Facade colors for generated buildings.
const BUILDING_COLORS = [
  '#5d6d7e',
  '#2e4053',
  '#85929e',
  '#aeb6bf',
  '#7f8c8d',
  '#6e2c00',
  '#7d6608',
  '#1b4f72',
  '#4a235a',
  '#145a32',
];

// Road center coordinates along one axis of the map.
function roadCenters(length) {
  const centers = [];
  for (let c = ROAD_SPACING / 2; c < length; c += ROAD_SPACING) {
    centers.push(c);
  }
  return centers;
}

// Nearest value in a sorted list of road centers to a target coordinate.
function nearestCenter(centers, value) {
  let best = centers[0];
  let bestDist = Math.abs(value - best);
  for (const c of centers) {
    const d = Math.abs(value - c);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best;
}

// District name at a point: the district whose region contains it,
// otherwise the district whose region center is nearest.
export function districtAt(city, x, y) {
  for (const key of Object.keys(DISTRICTS)) {
    const d = DISTRICTS[key];
    if (x >= d.x && x < d.x + d.w && y >= d.y && y < d.y + d.h) {
      return d.name;
    }
  }
  let best = null;
  let bestDist = Infinity;
  for (const key of Object.keys(DISTRICTS)) {
    const d = DISTRICTS[key];
    const cx = d.x + d.w / 2;
    const cy = d.y + d.h / 2;
    const dist = (cx - x) * (cx - x) + (cy - y) * (cy - y);
    if (dist < bestDist) {
      bestDist = dist;
      best = d.name;
    }
  }
  return best;
}

// True when the point lies on a road strip (within half the road width
// of a horizontal or vertical road center line).
export function isOnRoad(city, x, y) {
  const half = ROAD_WIDTH / 2;
  for (const road of city.roads.vertical) {
    if (Math.abs(x - road.x) <= half) return true;
  }
  for (const road of city.roads.horizontal) {
    if (Math.abs(y - road.y) <= half) return true;
  }
  return false;
}

// True when the point lies inside any building footprint.
export function isInsideBuilding(city, x, y) {
  for (const b of city.buildings) {
    if (x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height) {
      return true;
    }
  }
  return false;
}

// Closest point on the road network to the given point: the nearest
// point on any road center line, clamped to the map.
export function nearestRoadPoint(city, x, y) {
  let best = null;
  let bestDist = Infinity;
  for (const road of city.roads.vertical) {
    const px = road.x;
    const py = clamp(y, 0, WORLD_HEIGHT);
    const d = (px - x) * (px - x) + (py - y) * (py - y);
    if (d < bestDist) {
      bestDist = d;
      best = { x: px, y: py };
    }
  }
  for (const road of city.roads.horizontal) {
    const px = clamp(x, 0, WORLD_WIDTH);
    const py = road.y;
    const d = (px - x) * (px - x) + (py - y) * (py - y);
    if (d < bestDist) {
      bestDist = d;
      best = { x: px, y: py };
    }
  }
  return best;
}

// A random point on a road: pick a random road strip, then a random
// position along it.
export function randomRoadPosition(city) {
  const rng = city.rng;
  if (rng() < 0.5) {
    const road = pick(rng, city.roads.vertical);
    return { x: road.x, y: rng() * WORLD_HEIGHT };
  }
  const road = pick(rng, city.roads.horizontal);
  return { x: rng() * WORLD_WIDTH, y: road.y };
}

// A random road position near a point, within the given radius.
// Tries random spots in the disc and snaps them to the nearest road;
// falls back to the nearest road point when nothing lands in range.
export function randomRoadPositionNear(city, x, y, radius) {
  const rng = city.rng;
  for (let attempt = 0; attempt < 24; attempt++) {
    const angle = rng() * Math.PI * 2;
    const dist = Math.sqrt(rng()) * radius;
    const px = clamp(x + Math.cos(angle) * dist, 0, WORLD_WIDTH);
    const py = clamp(y + Math.sin(angle) * dist, 0, WORLD_HEIGHT);
    const spot = nearestRoadPoint(city, px, py);
    const dx = spot.x - x;
    const dy = spot.y - y;
    if (dx * dx + dy * dy <= radius * radius) return spot;
  }
  return nearestRoadPoint(city, x, y);
}

// Build the city for the game, deterministically from state.rng.
// Attaches the city to state.city and returns it.
export function buildCity(state) {
  const rng = state.rng;
  const vertical = roadCenters(WORLD_WIDTH).map((x) => ({ x, width: ROAD_WIDTH }));
  const horizontal = roadCenters(WORLD_HEIGHT).map((y) => ({ y, width: ROAD_WIDTH }));

  const blocks = [];
  const buildings = [];
  const parks = [];
  const water = [];

  const cols = vertical.length - 1;
  const rows = horizontal.length - 1;

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const bx = vertical[col].x + ROAD_WIDTH / 2;
      const by = horizontal[row].y + ROAD_WIDTH / 2;
      const cx = bx + BLOCK_SIZE / 2;
      const cy = by + BLOCK_SIZE / 2;
      const district = districtAt(null, cx, cy);

      // The southernmost row of blocks meets the coast, so it is beach.
      let kind;
      if (by + BLOCK_SIZE > COAST.beachY) {
        kind = 'beach';
      } else {
        const roll = rng();
        if (roll < 0.62) kind = 'buildings';
        else if (roll < 0.74) kind = 'park';
        else if (roll < 0.86) kind = 'plaza';
        else kind = 'parking lot';
      }
      blocks.push({ x: bx, y: by, w: BLOCK_SIZE, h: BLOCK_SIZE, kind, district });

      if (kind === 'buildings') {
        // 1 to 4 buildings, laid out on a 2x2 cell grid inside the block
        // so they never overlap each other or spill past the block edge.
        const count = randInt(rng, 1, 4);
        const cell = BLOCK_SIZE / 2;
        for (let i = 0; i < count; i++) {
          const cellX = i % 2;
          const cellY = Math.floor(i / 2);
          const width = randInt(rng, 70, 140);
          const height = randInt(rng, 70, 140);
          const x = bx + cellX * cell + (cell - width) / 2 + randInt(rng, -8, 8);
          const y = by + cellY * cell + (cell - height) / 2 + randInt(rng, -8, 8);
          buildings.push({
            x,
            y,
            width,
            height,
            elevation: randInt(rng, 10, 70),
            color: pick(rng, BUILDING_COLORS),
            district,
          });
        }
      } else if (kind === 'park') {
        const treeCount = randInt(rng, 6, 14);
        const trees = [];
        for (let i = 0; i < treeCount; i++) {
          trees.push({
            x: bx + 24 + rng() * (BLOCK_SIZE - 48),
            y: by + 24 + rng() * (BLOCK_SIZE - 48),
          });
        }
        parks.push({ x: bx, y: by, w: BLOCK_SIZE, h: BLOCK_SIZE, district, trees });
      }
    }
  }

  // The sea strip along the south edge: one water block per column.
  for (let col = 0; col < cols; col++) {
    const bx = vertical[col].x + ROAD_WIDTH / 2;
    const cx = bx + BLOCK_SIZE / 2;
    const cy = COAST.seaY + COAST.seaHeight / 2;
    blocks.push({
      x: bx,
      y: COAST.seaY,
      w: BLOCK_SIZE,
      h: COAST.seaHeight,
      kind: 'water',
      district: districtAt(null, cx, cy),
    });
  }
  water.push({ x: 0, y: COAST.seaY, w: WORLD_WIDTH, h: COAST.seaHeight });

  // Spawn points on roads near downtown: the player starts at the road
  // intersection nearest the downtown center, and the garage sits one
  // road east and one road north of it.
  const downtown = DISTRICTS.downtown;
  const dcx = downtown.x + downtown.w / 2;
  const dcy = downtown.y + downtown.h / 2;
  const startX = nearestCenter(vertical.map((r) => r.x), dcx);
  const startY = nearestCenter(horizontal.map((r) => r.y), dcy);
  const playerStart = { x: startX, y: startY };
  const garage = { x: startX + ROAD_SPACING, y: startY - ROAD_SPACING };

  const city = {
    width: WORLD_WIDTH,
    height: WORLD_HEIGHT,
    rng,
    roads: { vertical, horizontal },
    blocks,
    buildings,
    parks,
    water,
    playerStart,
    garage,
  };
  state.city = city;
  return city;
}

export default buildCity;
