// Port Vela — tuning constants and static data.
// Plain exported constants and small data objects only; no logic here.

// World geometry (pixels).
export const WORLD_WIDTH = 4800;
export const WORLD_HEIGHT = 3600;
export const ROAD_SPACING = 400;
export const ROAD_WIDTH = 64;
export const BLOCK_SIZE = 336;

// Coast along the south edge: sand strip, then open sea.
export const COAST = {
  beachHeight: 140,
  seaHeight: 320,
  beachY: WORLD_HEIGHT - 140 - 320,
  seaY: WORLD_HEIGHT - 320,
};

// Districts: name plus map region in world coordinates.
export const DISTRICTS = {
  downtown: { name: 'Downtown', x: 1600, y: 1100, w: 1600, h: 1400 },
  marina: { name: 'Marina', x: 0, y: 2300, w: 1600, h: 900 },
  oldTown: { name: 'Old Town', x: 0, y: 0, w: 1600, h: 1400 },
  industrial: { name: 'Industrial', x: 3200, y: 0, w: 1600, h: 1400 },
  suburbs: { name: 'Suburbs', x: 3200, y: 2300, w: 1600, h: 900 },
};

// Car types: topSpeed px/s, accel px/s^2, handling 0..1, palette.
export const CAR_TYPES = {
  sedan: { topSpeed: 340, accel: 220, handling: 0.62, colors: ['#c0392b', '#2e86c1', '#7f8c8d', '#f4f6f7'] },
  taxi: { topSpeed: 330, accel: 230, handling: 0.64, colors: ['#f1c40f', '#f39c12'] },
  truck: { topSpeed: 260, accel: 150, handling: 0.42, colors: ['#5d6d7e', '#a04000', '#1e8449'] },
  van: { topSpeed: 290, accel: 170, handling: 0.5, colors: ['#aab7b8', '#5d6d7e', '#eaf2f8'] },
  sports: { topSpeed: 470, accel: 330, handling: 0.82, colors: ['#e74c3c', '#8e44ad', '#f39c12', '#16a085'] },
  police: { topSpeed: 420, accel: 300, handling: 0.78, colors: ['#1a252f', '#f4f6f7'] },
  muscle: { topSpeed: 400, accel: 280, handling: 0.58, colors: ['#922b21', '#1c2833', '#7d6608'] },
};

// Player on foot (px/s).
export const PLAYER_WALK_SPEED = 150;
export const PLAYER_SPRINT_SPEED = 260;

// Health, wanted level and police tuning.
export const PLAYER_MAX_HEALTH = 100;
export const HEALTH_REGEN_DELAY = 8;
export const HEALTH_REGEN_RATE = 2;
export const WANTED_MAX = 5;
export const WANTED_DECAY_DELAY = 20;
export const WANTED_DECAY_RATE = 0.05;
export const HEAT_PER_CRIME = 12;
export const HEAT_DECAY = 1.5;
export const POLICE_SPAWN_INTERVAL = 4;
export const POLICE_MAX_ACTIVE = 8;
export const POLICE_CHASE_RANGE = 900;
export const POLICE_RAM_DAMAGE = 8;

// Mission rewards (cash).
export const MISSION_REWARDS = {
  tutorial: 150,
  taxiFare: 200,
  getaway: 450,
  delivery: 300,
  heist: 1200,
};

// Map palette.
export const PALETTE = {
  road: '#3a3f44',
  roadLine: '#e5e8e8',
  sidewalk: '#7b7d7d',
  building: '#5d6d7e',
  buildingRoof: '#2e4053',
  park: '#27ae60',
  parkTree: '#1e8449',
  water: '#2471a3',
  sand: '#f0d27a',
  grass: '#58d68d',
};
