// Port Vela — fresh game state factory.
import { WORLD_WIDTH, WORLD_HEIGHT, PLAYER_MAX_HEALTH } from './config.js';
import { createRng, stringToSeed } from './util.js';

// Create a fresh game state for a given seed (number or string).
export function createGameState(seed) {
  const numericSeed = typeof seed === 'number' ? seed >>> 0 : stringToSeed(seed);
  const rng = createRng(numericSeed);

  return {
    seed: numericSeed,
    rng,
    time: 0,
    city: null,

    player: {
      x: WORLD_WIDTH / 2,
      y: WORLD_HEIGHT / 2,
      angle: -Math.PI / 2,
      speed: 0,
      health: PLAYER_MAX_HEALTH,
      onFoot: true,
      carId: null,
    },

    cars: [],
    pedestrians: [],
    police: [],
    bullets: [],
    particles: [],

    wanted: 0,
    heat: 0,
    cash: 0,

    mission: {
      id: null,
      stage: 0,
      data: {},
    },

    camera: {
      x: WORLD_WIDTH / 2,
      y: WORLD_HEIGHT / 2,
      zoom: 1,
    },

    messages: [],

    stats: {
      missionsCompleted: 0,
      carsStolen: 0,
      arrestsEscaped: 0,
      shotsFired: 0,
    },

    screen: 'title',
  };
}

export default createGameState;
