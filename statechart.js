export const APP_STATES = Object.freeze({
  ready: Object.freeze({
    label: 'ready',
    canRun: true,
    metricsVisible: false,
    transitions: Object.freeze({ RUN: 'running' }),
  }),
  running: Object.freeze({
    label: 'running',
    canRun: false,
    metricsVisible: false,
    transitions: Object.freeze({ FINISH: 'complete', RESET: 'ready' }),
  }),
  complete: Object.freeze({
    label: 'complete',
    canRun: true,
    metricsVisible: true,
    transitions: Object.freeze({ RUN: 'running', RESET: 'ready' }),
  }),
});

export function transitionState(current, event) {
  const state = APP_STATES[current];
  if (!state) throw new Error(`Unknown app state: ${current}`);
  if (event === 'RESET') return 'ready';
  const next = state.transitions[event];
  if (!next) throw new Error(`Invalid app transition: ${current} + ${event}`);
  return next;
}
