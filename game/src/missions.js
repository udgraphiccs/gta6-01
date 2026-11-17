// Port Vela — story missions for Jay Carter, getaway driver.
// A short chain of jobs from fixer Mama Rosa and hacker Pix: pick up
// a package, steal a getaway car, and run a timed delivery across the
// city. Missions live in state.mission ({ id, stage, data }) and the
// current objective is kept in state.mission.data.objective, the exact
// field render.js reads for its pulsing map marker. No new fields are
// added to the game state; per-mission runtime (timers, target car)
// lives inside mission.data.
//
// The main loop should call updateMission(state, dt) every frame while
// playing; it auto-starts the next job when none is active.

import { WORLD_WIDTH, WORLD_HEIGHT, COAST } from './config.js';
import { clamp } from './util.js';
import { nearestRoadPoint } from './world.js';
import { raiseWanted } from './police.js';

// How close (px) the player must get to a marker to finish a stage.
const REACH_RADIUS = 70;
// How close the player must be to a parked car to steal it for Pix.
const STEAL_RADIUS = 400;
// Seconds of quiet after the getaway before the heat dies down.
const EVADE_SECONDS = 20;
// Seconds after a failed timed job before Mama Rosa calls again.
const RETRY_DELAY = 10;

// Per-state flag: true once a mission has been started for this state,
// so updateMission only auto-starts the very first job.
const meta = new WeakMap();

function stateMeta(state) {
  let m = meta.get(state);
  if (!m) {
    m = { autoStarted: false };
    meta.set(state, m);
  }
  return m;
}

// Fixed anchor points per district; resolved onto the nearest road at
// mission start so markers always sit somewhere drivable/walkable.
const SPOTS = {
  oldTown: { x: 800, y: 700 },
  downtown: { x: 2400, y: 1800 },
  marina: { x: 800, y: 2750 },
  industrial: { x: 4000, y: 700 },
  suburbs: { x: 4000, y: 2750 },
};

// Stage types:
//   reach      — get to the marker, on foot or by car.
//   deliver    — reach the marker (same check, different flavour text).
//   enterCar   — get into the marked car (or any car near the marker).
//   evade      — survive with the police looking for you until the
//                timer runs out; the heat is then cleared.
//   timedReach — reach the marker before the timer runs out, or the
//                job fails and Mama Rosa calls again later.
export const MISSIONS = [
  {
    id: 'rosa-package',
    title: "Mama Rosa's Package",
    description: 'Mama Rosa has a package in Old Town that needs to reach '
      + 'a buyer at the Marina. No questions, no shortcuts.',
    reward: 150,
    stages: [
      {
        type: 'reach', spot: 'oldTown',
        label: 'Pick up the package in Old Town',
        done: 'Package collected. Mama Rosa says the buyer is waiting.',
      },
      {
        type: 'deliver', spot: 'marina',
        label: 'Deliver the package to the Marina',
        done: 'Delivered. The buyer paid without a word.',
      },
    ],
  },
  {
    id: 'pix-wheels',
    title: 'Pix Needs Wheels',
    description: 'Pix has a job lined up but no getaway car. Lift something '
      + 'fast near the Downtown garage, drop it in Industrial, then '
      + 'shake the heat.',
    reward: 450,
    stages: [
      {
        type: 'enterCar', spot: 'downtown',
        label: 'Steal a car near the Downtown garage',
        done: 'Got wheels. Pix is already wiping the plates.',
      },
      {
        type: 'deliver', spot: 'industrial',
        label: 'Drive the car to the Industrial drop-off',
        done: 'Car dropped. But someone called it in — the heat is on.',
      },
      {
        type: 'evade', duration: EVADE_SECONDS,
        label: 'Lose the police and lay low',
        done: 'Heat died down. Pix says the job paid out clean.',
      },
    ],
  },
  {
    id: 'sunset-run',
    title: 'The Sunset Run',
    description: 'One last parcel, one deadline: get it from the garage to '
      + 'the Suburbs before the sun drops. Late means no pay.',
    reward: 300,
    stages: [
      {
        type: 'reach', spot: 'downtown',
        label: 'Pick up the parcel at the Downtown garage',
        done: 'Parcel in hand. The clock is ticking — drive!',
      },
      {
        type: 'timedReach', spot: 'suburbs', duration: 75,
        label: 'Deliver to the Suburbs before sunset',
        done: 'Made it with time to spare. Port Vela is yours, Jay.',
      },
    ],
  },
];

// Keep the message log short so it never grows without bound.
function pushMessage(state, text) {
  if (!state.messages) state.messages = [];
  state.messages.push(text);
  if (state.messages.length > 6) {
    state.messages.splice(0, state.messages.length - 6);
  }
}

// Mission definition by id, or null.
export function missionById(id) {
  return MISSIONS.find((m) => m.id === id) || null;
}

// The next mission the player has not finished yet, or null when the
// chain is done.
export function nextMission(state) {
  const done = (state.stats && state.stats.missionsCompleted) || 0;
  return MISSIONS[done] || null;
}

// Resolve a named spot onto the nearest road point, clamped inside
// the world and north of the beach so the marker is always reachable.
function resolveSpot(state, spotKey) {
  const anchor = SPOTS[spotKey] || SPOTS.downtown;
  if (!state.city) return { x: anchor.x, y: anchor.y };
  const p = nearestRoadPoint(state.city, anchor.x, anchor.y) || anchor;
  return {
    x: clamp(p.x, 0, WORLD_WIDTH),
    y: clamp(p.y, 0, COAST.beachY - 40),
  };
}

// Nearest parked (still, unoccupied) car to a point, or null.
function nearestParkedCar(state, x, y, maxDist) {
  let best = null;
  let bestDist = maxDist;
  for (const car of state.cars || []) {
    if (car.occupied) continue;
    if ((car.speed || 0) !== 0) continue;
    const d = Math.hypot(car.x - x, car.y - y);
    if (d < bestDist) {
      bestDist = d;
      best = car;
    }
  }
  return best;
}

// Prepare mission.data for a stage: place the marker, pick the car to
// steal, or start a timer. Returns false when the stage cannot be set
// up (unknown type), so the caller can skip it.
function setupStage(state, mission, stageIndex) {
  const stage = mission.stages[stageIndex];
  if (!stage) return false;
  const data = state.mission.data;
  data.timer = 0;
  data.targetCarId = null;
  if (stage.type === 'reach' || stage.type === 'deliver' ||
      stage.type === 'timedReach') {
    data.objective = resolveSpot(state, stage.spot);
  } else if (stage.type === 'enterCar') {
    const spot = resolveSpot(state, stage.spot);
    const car = nearestParkedCar(state, spot.x, spot.y, STEAL_RADIUS);
    if (car) {
      data.targetCarId = car.id;
      data.objective = { x: car.x, y: car.y };
    } else {
      // No parked car nearby: any car near the marker will do.
      data.objective = spot;
    }
  } else if (stage.type === 'evade' || stage.type === 'timedReach') {
    data.objective = null;
    if (stage.type === 'evade') {
      // Someone called the car in: the police are on their way, so
      // laying low actually means something.
      raiseWanted(state, 2);
    }
  } else {
    return false;
  }
  if (stage.duration != null) data.timer = stage.duration;
  if (stage.type === 'evade') data.objective = null;
  return true;
}

// Start a mission by id, or the next unfinished one when no id is
// given. Returns true when a mission started.
export function startMission(state, id) {
  if (!state || !state.mission) return false;
  if (state.mission.id) return false;
  const mission = id ? missionById(id) : nextMission(state);
  if (!mission) return false;
  stateMeta(state).autoStarted = true;
  state.mission.id = mission.id;
  state.mission.stage = 0;
  state.mission.data = {};
  if (!setupStage(state, mission, 0)) return false;
  pushMessage(state, `New job: ${mission.title} — ${mission.description}`);
  pushMessage(state, mission.stages[0].label);
  return true;
}

// Finish the current mission: pay the reward, count it, and either
// unlock the next job or end the story.
export function completeMission(state) {
  const mission = missionById(state.mission.id);
  if (!mission) return false;
  state.cash = (state.cash || 0) + mission.reward;
  state.stats.missionsCompleted =
    ((state.stats && state.stats.missionsCompleted) || 0) + 1;
  pushMessage(state,
    `Job done: ${mission.title} — paid $${mission.reward}.`);
  state.mission.id = null;
  state.mission.stage = 0;
  state.mission.data = {};
  const next = nextMission(state);
  if (next) {
    pushMessage(state, `Next job unlocked: ${next.title}.`);
    startMission(state, next.id);
  } else {
    state.screen = 'complete';
    pushMessage(state,
      'All jobs done. Jay Carter owns the streets of Port Vela.');
  }
  return true;
}

// A timed job ran out of time: drop it and let the fixer call again.
// Returns true when a mission was failed.
export function failMission(state) {
  if (!state.mission.id) return false;
  const mission = missionById(state.mission.id);
  pushMessage(state,
    `Too slow — ${mission ? mission.title : 'the job'} fell through. `
    + 'Mama Rosa will call again.');
  state.mission.id = null;
  state.mission.stage = 0;
  // The fixer calls again after a short wait; updateMission counts
  // this down and restarts the job on its own.
  state.mission.data = { retryIn: RETRY_DELAY };
  return true;
}

// Move to the next stage, or complete the mission when the chain ends.
function advanceStage(state, mission) {
  const finished = state.mission.data && state.mission.data.doneText;
  if (finished) pushMessage(state, finished);
  state.mission.stage += 1;
  if (state.mission.stage >= mission.stages.length) {
    completeMission(state);
    return;
  }
  const stage = mission.stages[state.mission.stage];
  state.mission.data = {};
  if (!setupStage(state, mission, state.mission.stage)) {
    completeMission(state);
    return;
  }
  pushMessage(state, stage.label);
}

// True when the player is close enough to the marker to finish a
// reach-style stage.
function atObjective(state, radius) {
  const target = state.mission.data.objective;
  if (!target) return false;
  const d = Math.hypot(
    state.player.x - target.x, state.player.y - target.y);
  return d <= radius;
}

// Advance the current mission one frame: check the active stage's
// objective, move on when it is met, and start the next job when
// none is active. dt is seconds since the last frame.
export function updateMission(state, dt) {
  if (!state || !state.mission) return;
  const safeDt = dt > 0 && dt < 1 ? dt : 1 / 60;
  if (!state.mission.id) {
    if (state.screen !== 'playing') return;
    const data = state.mission.data || {};
    if (data.retryIn != null) {
      // A failed job is waiting for the fixer to call again.
      data.retryIn -= safeDt;
      if (data.retryIn <= 0) {
        state.mission.data = {};
        startMission(state);
      }
      return;
    }
    // No job yet: start the first one exactly once.
    if (!stateMeta(state).autoStarted) startMission(state);
    return;
  }
  const mission = missionById(state.mission.id);
  if (!mission) {
    state.mission.id = null;
    state.mission.stage = 0;
    state.mission.data = {};
    return;
  }
  const stage = mission.stages[state.mission.stage];
  if (!stage) {
    completeMission(state);
    return;
  }
  const data = state.mission.data;
  let done = false;
  if (stage.type === 'reach' || stage.type === 'deliver') {
    done = atObjective(state, REACH_RADIUS);
  } else if (stage.type === 'timedReach') {
    data.timer = Math.max(0, (data.timer || 0) - safeDt);
    if (atObjective(state, REACH_RADIUS)) done = true;
    else if (data.timer <= 0) {
      failMission(state);
      return;
    }
  } else if (stage.type === 'enterCar') {
    const drivingTarget = !state.player.onFoot &&
      data.targetCarId != null &&
      state.player.carId === data.targetCarId;
    const drivingAnyNear = !state.player.onFoot &&
      atObjective(state, 150);
    done = drivingTarget || drivingAnyNear;
  } else if (stage.type === 'evade') {
    data.timer = Math.max(0, (data.timer || 0) - safeDt);
    if (data.timer <= 0) {
      // The heat dies down: wanted level and heat clear together.
      state.heat = 0;
      state.wanted = 0;
      done = true;
    }
  }
  if (!done) return;
  data.doneText = stage.done;
  advanceStage(state, mission);
}

// The current mission definition, or null when no job is active.
export function currentMission(state) {
  if (!state || !state.mission || !state.mission.id) return null;
  return missionById(state.mission.id);
}

export default updateMission;
