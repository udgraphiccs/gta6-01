// Port Vela — keyboard and mouse input.
// Tracks held keys, edge-triggered "just pressed" keys (consumed once),
// mouse position over the canvas and mouse button state. Plain ES
// module; the listeners only touch window/document when they exist, so
// the factory can be built headlessly for tests.

import { clamp } from './util.js';

// Movement keys: WASD plus the arrow keys.
const MOVE_KEYS = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
]);

// Every key the game cares about, so the browser's default behaviour
// (scrolling, etc.) can be suppressed for all of them.
const GAME_KEYS = new Set([
  ...MOVE_KEYS,
  'Space',
  'ShiftLeft', 'ShiftRight',
  'KeyE',
  'KeyP', 'Escape',
  'KeyM',
]);

// Normalize an event's key/code into one canonical name per game key.
function normalizeKey(event) {
  const code = event.code || event.key;
  if (code === ' ') return 'Space';
  if (code === 'Shift') return 'ShiftLeft';
  return code;
}

// The logical name of a game action from a normalized key, or null.
function actionForKey(key) {
  switch (key) {
    case 'KeyW':
    case 'ArrowUp': return 'up';
    case 'KeyS':
    case 'ArrowDown': return 'down';
    case 'KeyA':
    case 'ArrowLeft': return 'left';
    case 'KeyD':
    case 'ArrowRight': return 'right';
    case 'KeyE': return 'enterExit';
    case 'Space': return 'action';
    case 'ShiftLeft':
    case 'ShiftRight': return 'sprint';
    case 'KeyP':
    case 'Escape': return 'pause';
    case 'KeyM': return 'mute';
    default: return null;
  }
}

// All action names, so callers may ask about an action ('enterExit')
// or a physical key ('KeyE') interchangeably.
const ACTIONS = new Set([
  'up', 'down', 'left', 'right', 'enterExit', 'action', 'sprint',
  'pause', 'mute',
]);

// Resolve a key code or an action name to its action, or null.
function resolveAction(keyOrAction) {
  if (ACTIONS.has(keyOrAction)) return keyOrAction;
  return actionForKey(keyOrAction);
}

// Create an input object attached to the window and canvas.
// Pass null for canvas to track keys only; pass null for both to build
// a headless input object that tests can drive by hand.
export function createInput(canvas = null) {
  const held = new Set();
  const pressed = new Set();
  const mouse = { x: 0, y: 0, inside: false };
  const mouseButtons = new Set();
  const mouseClicks = [];

  // Movement axes from the held keys: x right, y down, each in [-1, 1].
  function moveVector() {
    let x = 0;
    let y = 0;
    if (held.has('KeyA') || held.has('ArrowLeft')) x -= 1;
    if (held.has('KeyD') || held.has('ArrowRight')) x += 1;
    if (held.has('KeyW') || held.has('ArrowUp')) y -= 1;
    if (held.has('KeyS') || held.has('ArrowDown')) y += 1;
    return { x, y };
  }

  // True while the key (or any key mapped to the action) is held down.
  function isDown(keyOrAction) {
    const action = resolveAction(keyOrAction);
    if (action) {
      // An action name: held if any key mapping to it is held.
      for (const key of held) {
        if (actionForKey(key) === action) return true;
      }
      return false;
    }
    return held.has(keyOrAction);
  }

  // True once for a key pressed since the last consume, then cleared.
  function consumePressed(keyOrAction) {
    const action = resolveAction(keyOrAction);
    if (action) {
      for (const key of [...pressed]) {
        if (actionForKey(key) === action) {
          pressed.delete(key);
          return true;
        }
      }
      return false;
    }
    if (pressed.has(keyOrAction)) {
      pressed.delete(keyOrAction);
      return true;
    }
    return false;
  }

  // Mouse position in canvas CSS pixels, clamped to the canvas size.
  function mousePosition() {
    if (!canvas) return { x: mouse.x, y: mouse.y };
    const w = canvas.clientWidth || canvas.width || 0;
    const h = canvas.clientHeight || canvas.height || 0;
    return {
      x: clamp(mouse.x, 0, Math.max(w - 1, 0)),
      y: clamp(mouse.y, 0, Math.max(h - 1, 0)),
    };
  }

  // True while the given mouse button (0 = left) is held down.
  function isMouseDown(button = 0) {
    return mouseButtons.has(button);
  }

  // True once for a click recorded since the last consume, then cleared.
  function consumeClick(button = 0) {
    const i = mouseClicks.indexOf(button);
    if (i === -1) return false;
    mouseClicks.splice(i, 1);
    return true;
  }

  // Update the stored mouse position from a pointer/mouse event.
  function trackMouse(event) {
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect
      ? canvas.getBoundingClientRect()
      : { left: 0, top: 0 };
    mouse.x = event.clientX - rect.left;
    mouse.y = event.clientY - rect.top;
    mouse.inside = true;
  }

  function onKeyDown(event) {
    const key = normalizeKey(event);
    if (GAME_KEYS.has(key)) {
      if (typeof event.preventDefault === 'function') {
        event.preventDefault();
      }
      // Edge-trigger only on the first press, not on key repeats.
      if (!event.repeat && !held.has(key)) pressed.add(key);
      held.add(key);
    }
  }

  function onKeyUp(event) {
    held.delete(normalizeKey(event));
  }

  function onBlur() {
    // Losing focus must not leave keys stuck down.
    held.clear();
    mouseButtons.clear();
  }

  function onMouseMove(event) {
    trackMouse(event);
  }

  function onMouseDown(event) {
    trackMouse(event);
    mouseButtons.add(event.button ?? 0);
  }

  function onMouseUp(event) {
    trackMouse(event);
    const button = event.button ?? 0;
    mouseButtons.delete(button);
    mouseClicks.push(button);
  }

  function onMouseLeave() {
    mouse.inside = false;
    mouseButtons.clear();
  }

  // Prevent the context menu from opening on a right-click in the game.
  function onContextMenu(event) {
    if (typeof event.preventDefault === 'function') {
      event.preventDefault();
    }
  }

  // Attach the listeners; safe to call when window/document are absent.
  function attach() {
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('keydown', onKeyDown);
      window.addEventListener('keyup', onKeyUp);
      window.addEventListener('blur', onBlur);
    }
    if (canvas && canvas.addEventListener) {
      canvas.addEventListener('mousemove', onMouseMove);
      canvas.addEventListener('mousedown', onMouseDown);
      canvas.addEventListener('mouseup', onMouseUp);
      canvas.addEventListener('mouseleave', onMouseLeave);
      canvas.addEventListener('contextmenu', onContextMenu);
    }
  }

  // Detach every listener added by attach().
  function detach() {
    if (typeof window !== 'undefined' && window.removeEventListener) {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    }
    if (canvas && canvas.removeEventListener) {
      canvas.removeEventListener('mousemove', onMouseMove);
      canvas.removeEventListener('mousedown', onMouseDown);
      canvas.removeEventListener('mouseup', onMouseUp);
      canvas.removeEventListener('mouseleave', onMouseLeave);
      canvas.removeEventListener('contextmenu', onContextMenu);
    }
  }

  attach();

  const input = {
    moveVector,
    isDown,
    consumePressed,
    mousePosition,
    isMouseDown,
    consumeClick,
    attach,
    detach,
    // Read-only views for tests and debugging.
    get mouse() {
      return { x: mouse.x, y: mouse.y, inside: mouse.inside };
    },
    get heldKeys() {
      return [...held];
    },
    // Test hook: feed a synthetic key/mouse event without a browser.
    _inject(event, kind) {
      if (kind === 'keydown') onKeyDown(event);
      else if (kind === 'keyup') onKeyUp(event);
      else if (kind === 'mousemove') onMouseMove(event);
      else if (kind === 'mousedown') onMouseDown(event);
      else if (kind === 'mouseup') onMouseUp(event);
      else if (kind === 'blur') onBlur();
    },
  };

  return input;
}

export default createInput;
