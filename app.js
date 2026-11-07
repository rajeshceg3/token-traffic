import {
  DEFAULT_CONFIG,
  GPU_MEMORY_GB,
  MODEL_ASSUMPTIONS,
  SCENARIOS,
  WEIGHTS_GB,
  normalizeConfig,
  simulate,
} from './model.js';
import { APP_STATES, transitionState } from './statechart.js';

const els = {
  promptRange: document.querySelector('#promptRange'),
  outputRange: document.querySelector('#outputRange'),
  requestRange: document.querySelector('#requestRange'),
  promptValue: document.querySelector('#promptValue'),
  outputValue: document.querySelector('#outputValue'),
  requestValue: document.querySelector('#requestValue'),
  kvToggle: document.querySelector('#kvToggle'),
  continuousToggle: document.querySelector('#continuousToggle'),
  chunkedToggle: document.querySelector('#chunkedToggle'),
  specToggle: document.querySelector('#specToggle'),
  quantToggle: document.querySelector('#quantToggle'),
  challengeToggle: document.querySelector('#challengeToggle'),
  runButton: document.querySelector('#runButton'),
  guideButton: document.querySelector('#guideButton'),
  statusText: document.querySelector('#statusText'),
  insightTitle: document.querySelector('#insightTitle'),
  insightText: document.querySelector('#insightText'),
  ttftMetric: document.querySelector('#ttftMetric'),
  throughputMetric: document.querySelector('#throughputMetric'),
  memoryMetric: document.querySelector('#memoryMetric'),
  makespanMetric: document.querySelector('#makespanMetric'),
  deltaGrid: document.querySelector('#deltaGrid'),
  queueDots: document.querySelector('#queueDots'),
  decodeLane: document.querySelector('#decodeLane'),
  prefillLane: document.querySelector('#prefillLane'),
  doneCount: document.querySelector('#doneCount'),
  engineStatus: document.querySelector('#engineStatus'),
  memoryFill: document.querySelector('#memoryFill'),
  memoryLabel: document.querySelector('#memoryLabel'),
  requestStrip: document.querySelector('#requestStrip'),
  challengeCard: document.querySelector('#challengeCard'),
  challengeResult: document.querySelector('#challengeResult'),
  stepTitle: document.querySelector('#stepTitle'),
  stepText: document.querySelector('#stepText'),
  stepCount: document.querySelector('#stepCount'),
  nextStep: document.querySelector('#nextStep'),
  stepDots: document.querySelector('#stepDots'),
  assumptionList: document.querySelector('#assumptionList'),
  liveClock: document.querySelector('#liveClock'),
};

const GUIDED_STEPS = [
  {
    title: '1. Prefill writes the first cache',
    text: 'One prompt enters. The model reads the whole prompt, stores key and value states, then emits the first token. That first wait is TTFT.',
    config: { requests: 1, promptTokens: 900, outputTokens: 120, kvCache: true, continuousBatching: false, chunkedPrefill: false, speculative: false, quant8: false, challenge: false },
  },
  {
    title: '2. Decode is one step at a time',
    text: 'The cache saves old work, but generation is still sequential: one token, append it, then the next. Turn the cache off later to feel why reuse matters.',
    config: { requests: 1, promptTokens: 900, outputTokens: 260, kvCache: true, continuousBatching: false, chunkedPrefill: false, speculative: false, quant8: false, challenge: false },
  },
  {
    title: '3. A queue changes the problem',
    text: 'With many requests, a naive engine lets one conversation own the GPU from prompt through final token. Everyone behind it waits.',
    config: { requests: 18, promptTokens: 900, outputTokens: 180, kvCache: true, continuousBatching: false, chunkedPrefill: false, speculative: false, quant8: false, challenge: false },
  },
  {
    title: '4. Continuous batching swaps finished work out',
    text: 'Finished requests leave immediately. Waiting requests fill the space, so the GPU spends fewer cycles idling between conversations.',
    config: { requests: 18, promptTokens: 900, outputTokens: 180, kvCache: true, continuousBatching: true, chunkedPrefill: false, speculative: false, quant8: false, challenge: false },
  },
  {
    title: '5. Chunked prefill stops the long prompt roadblock',
    text: 'A huge prompt no longer pauses every active decode. The engine takes one slice of prefill, lets decode progress, then takes another slice.',
    config: { requests: 8, promptTokens: 3600, outputTokens: 220, kvCache: true, continuousBatching: true, chunkedPrefill: true, speculative: false, quant8: false, challenge: false },
  },
  {
    title: '6. Every win has a bill',
    text: 'Speculation needs a useful draft. Quantization trades precision for memory, and its speed depends on the stack. More concurrency grows the KV cache. The right mix depends on the workload.',
    config: { requests: 24, promptTokens: 1300, outputTokens: 240, kvCache: true, continuousBatching: true, chunkedPrefill: true, speculative: true, quant8: true, challenge: true },
  },
];

let config = normalizeConfig(DEFAULT_CONFIG);
let appState = 'ready';
let lastCompletedMode = 'optimized';
let previewResult = simulate(config);
let activeResult = null;
let optimizedResult = null;
let naiveResult = null;
let playTimer = null;
let snapshotIndex = 0;
let guidedIndex = 0;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function init() {
  bindControls();
  setControls(config);
  renderAssumptions();
  renderGuide();
  resetRun('Ready. Run the current mix.');
}

function bindControls() {
  document.querySelectorAll('[data-scenario]').forEach((button) => {
    button.addEventListener('click', () => {
      const scenario = SCENARIOS[button.dataset.scenario];
      config = normalizeConfig({ ...config, ...pickScenario(scenario) });
      setControls(config);
      markScenario(button);
      resetRun(`Ready: ${scenario.label}. ${scenario.note}`);
    });
  });

  for (const el of [els.promptRange, els.outputRange, els.requestRange]) {
    el.addEventListener('input', () => {
      config = normalizeConfig(readControls());
      updateRangeLabels();
      resetRun('Controls changed. Run the updated mix.');
    });
  }

  for (const el of [els.kvToggle, els.continuousToggle, els.chunkedToggle, els.specToggle, els.quantToggle]) {
    el.addEventListener('change', () => {
      config = normalizeConfig(readControls());
      resetRun('Engine mix changed. Run it to see the effect.');
    });
  }

  els.challengeToggle.addEventListener('change', () => {
    config = normalizeConfig(readControls());
    resetRun(config.challenge ? 'Challenge on. Run the mix to check the goal.' : 'Challenge off. Run the current mix.');
  });

  els.runButton.addEventListener('click', () => {
    if (!APP_STATES[appState].canRun) return;
    const nextMode = appState === 'complete' && lastCompletedMode === 'optimized' ? 'naive' : 'optimized';
    startRun(nextMode);
  });

  els.guideButton.addEventListener('click', () => {
    document.querySelector('#guided').scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
    applyGuidedStep(0);
  });
  els.nextStep.addEventListener('click', () => applyGuidedStep((guidedIndex + 1) % GUIDED_STEPS.length));
}

function pickScenario(scenario) {
  return {
    promptTokens: scenario.promptTokens,
    outputTokens: scenario.outputTokens,
    requests: scenario.requests,
  };
}

function readControls() {
  return {
    promptTokens: Number(els.promptRange.value),
    outputTokens: Number(els.outputRange.value),
    requests: Number(els.requestRange.value),
    kvCache: els.kvToggle.checked,
    continuousBatching: els.continuousToggle.checked,
    chunkedPrefill: els.chunkedToggle.checked,
    speculative: els.specToggle.checked,
    quant8: els.quantToggle.checked,
    challenge: els.challengeToggle.checked,
  };
}

function setControls(next) {
  els.promptRange.value = next.promptTokens;
  els.outputRange.value = next.outputTokens;
  els.requestRange.value = next.requests;
  els.kvToggle.checked = next.kvCache;
  els.continuousToggle.checked = next.continuousBatching;
  els.chunkedToggle.checked = next.chunkedPrefill;
  els.specToggle.checked = next.speculative;
  els.quantToggle.checked = next.quant8;
  els.challengeToggle.checked = Boolean(next.challenge);
  els.challengeCard.hidden = !next.challenge;
  updateRangeLabels();
}

function updateRangeLabels() {
  els.promptValue.textContent = `${Number(els.promptRange.value).toLocaleString()} tokens`;
  els.outputValue.textContent = `${Number(els.outputRange.value).toLocaleString()} tokens`;
  els.requestValue.textContent = `${els.requestRange.value} requests`;
}

function resetRun(message) {
  stopPlayback();
  appState = transitionState(appState, 'RESET');
  lastCompletedMode = 'optimized';
  previewResult = simulate(config);
  activeResult = null;
  optimizedResult = null;
  naiveResult = null;
  renderReady(message);
}

function renderReady(message) {
  const requestCount = previewResult.metrics.requested;
  els.statusText.textContent = message;
  els.engineStatus.textContent = 'Ready';
  els.liveClock.textContent = '0ms';
  els.doneCount.textContent = `0/${requestCount} complete`;
  els.memoryLabel.textContent = `${weightMemoryGb(config).toFixed(1)} GB weights`;
  setMemoryFill(weightMemoryGb(config));
  els.queueDots.replaceChildren(...previewResult.requests.slice(0, 14).map((request) => tokenDot(request.id)));
  els.prefillLane.replaceChildren(emptyNote('idle'));
  els.decodeLane.replaceChildren(emptyNote('idle'));
  renderStrip(previewResult, null);
  renderMetrics(null);
  renderJourneyReady();
  els.challengeCard.hidden = !config.challenge;
  els.challengeResult.textContent = '';
  els.runButton.disabled = false;
  els.runButton.textContent = 'Run the queue';
}

function startRun(mode) {
  appState = transitionState(appState, 'RUN');
  const runConfig = mode === 'naive' ? naiveConfig(config) : config;
  activeResult = simulate(runConfig);
  renderRunning(mode);
  if (reducedMotion) {
    renderSnapshot(activeResult.snapshots[activeResult.snapshots.length - 1]);
    finishRun(mode);
    return;
  }
  startPlayback(mode);
}

function renderRunning(mode) {
  els.statusText.textContent = mode === 'naive' ? 'Running the naive baseline...' : 'Running the current mix...';
  els.engineStatus.textContent = 'Starting';
  els.liveClock.textContent = '0ms';
  els.doneCount.textContent = `0/${activeResult.metrics.requested} complete`;
  els.runButton.disabled = true;
  els.runButton.textContent = 'Running...';
  els.deltaGrid.hidden = true;
  renderMetrics(null);
  renderStrip(activeResult, null);
  renderSnapshot(activeResult.snapshots[0]);
}

function startPlayback(mode) {
  stopPlayback();
  snapshotIndex = 0;
  const delay = Math.max(35, Math.min(160, activeResult.metrics.makespanMs / Math.max(1, activeResult.snapshots.length) / 12));
  playTimer = window.setInterval(() => {
    snapshotIndex += 1;
    if (snapshotIndex >= activeResult.snapshots.length) {
      stopPlayback();
      finishRun(mode);
      return;
    }
    renderSnapshot(activeResult.snapshots[snapshotIndex]);
  }, delay);
}

function finishRun(mode) {
  if (appState !== 'complete') appState = transitionState(appState, 'FINISH');
  lastCompletedMode = mode;
  const finalSnapshot = activeResult.snapshots[activeResult.snapshots.length - 1];
  renderSnapshot(finalSnapshot, { complete: true });
  renderMetrics(activeResult.metrics);
  renderStrip(activeResult, finalSnapshot);
  if (mode === 'optimized') {
    optimizedResult = activeResult;
    naiveResult = null;
    renderOptimizedComplete();
  } else {
    naiveResult = activeResult;
    renderNaiveComplete();
  }
  renderChallenge();
  els.runButton.disabled = false;
  els.runButton.textContent = mode === 'optimized' ? 'Run naive baseline' : 'Replay optimized mix';
}

function renderOptimizedComplete() {
  els.statusText.textContent = 'Current mix complete. Next: run the naive baseline.';
  els.insightTitle.textContent = 'Current mix complete';
  els.insightText.textContent = 'These are illustrative model estimates for this workload. Run the naive baseline next to isolate what the scheduler and optimizations changed.';
  els.deltaGrid.hidden = true;
}

function renderNaiveComplete() {
  els.statusText.textContent = 'Naive baseline complete. Compare the deltas.';
  if (!optimizedResult) {
    els.insightTitle.textContent = 'Naive baseline complete';
    els.insightText.textContent = 'Run the current mix to compare it with this baseline.';
    return;
  }
  const comparison = compareMetrics(naiveResult.metrics, optimizedResult.metrics);
  renderDeltas(comparison);
  renderComparisonCopy(comparison);
}

function compareMetrics(naive, optimized) {
  return {
    ttft: pctDelta(naive.avgTtftMs, optimized.avgTtftMs),
    throughput: pctDelta(naive.throughputTokS, optimized.throughputTokS),
    memory: pctDelta(naive.peakMemoryGb, optimized.peakMemoryGb),
    makespan: pctDelta(naive.makespanMs, optimized.makespanMs),
  };
}

function pctDelta(before, after) {
  if (!before) return 0;
  return Math.round(((after - before) / before) * 1000) / 10;
}

function renderDeltas(comparison) {
  const rows = [
    { label: 'Average TTFT', value: comparison.ttft, good: comparison.ttft < 0, hint: 'lower is better' },
    { label: 'Throughput', value: comparison.throughput, good: comparison.throughput > 0, hint: 'higher is better' },
    { label: 'Peak memory', value: comparison.memory, good: comparison.memory < 0, hint: 'lower is better' },
    { label: 'Total time', value: comparison.makespan, good: comparison.makespan < 0, hint: 'lower is better' },
  ];
  els.deltaGrid.replaceChildren(...rows.map((row) => {
    const card = document.createElement('div');
    card.className = 'delta-card';
    card.dataset.good = String(row.good);
    const value = document.createElement('strong');
    value.textContent = `${row.value > 0 ? '+' : ''}${row.value}%`;
    const label = document.createElement('span');
    label.textContent = row.label;
    const hint = document.createElement('small');
    hint.textContent = row.hint;
    card.append(label, value, hint);
    return card;
  }));
  els.deltaGrid.hidden = false;
}

function renderComparisonCopy(comparison) {
  if (comparison.ttft <= -15) {
    els.insightTitle.textContent = 'First tokens move sooner in this workload';
    els.insightText.textContent = 'The modeled queue wait fell. Continuous batching and chunked prefill can reduce blocking here, but the size of the effect depends on the real model, hardware and traffic.';
  } else if (comparison.throughput >= 20) {
    els.insightTitle.textContent = 'Throughput moved first';
    els.insightText.textContent = 'Finished requests leave the modeled engine sooner, making room for waiting work. This is a scheduling effect in one workload, not a universal speedup.';
  } else if (comparison.memory <= -10) {
    els.insightTitle.textContent = 'The memory bill is lower';
    els.insightText.textContent = 'The 8-bit setting lowers modeled weight memory. Speed and quality still depend on the model, hardware and quantization method.';
  } else {
    els.insightTitle.textContent = 'A small trade, not magic';
    els.insightText.textContent = 'This mix changes the balance between queue wait, token speed and cache pressure. Try one switch at a time and watch which metric moves.';
  }
}

function renderMetrics(metrics) {
  if (!metrics) {
    els.ttftMetric.textContent = '—';
    els.throughputMetric.textContent = '—';
    els.memoryMetric.textContent = '—';
    els.makespanMetric.textContent = '—';
    return;
  }
  els.ttftMetric.textContent = formatMs(metrics.avgTtftMs);
  els.throughputMetric.textContent = `${metrics.throughputTokS.toLocaleString()} tok/s`;
  els.memoryMetric.textContent = `${metrics.peakMemoryGb.toFixed(1)} GB`;
  els.makespanMetric.textContent = formatMs(metrics.makespanMs);
}

function renderJourneyReady() {
  els.insightTitle.textContent = 'Ready when you are';
  els.insightText.textContent = 'Run the current mix first. Then run the naive baseline against the same workload to see what changed. Times are illustrative, not measured GPU benchmarks.';
  els.deltaGrid.hidden = true;
}

function renderChallenge() {
  if (!config.challenge || !activeResult) return;
  const m = activeResult.metrics;
  const pass = m.avgTtftMs <= 1800 && m.throughputTokS >= 55 && m.peakMemoryGb <= 72;
  els.challengeResult.dataset.pass = String(pass);
  els.challengeResult.innerHTML = pass
    ? '<strong>SLA met.</strong> First tokens stay quick, throughput clears the room, and the cache still fits in this model.'
    : '<strong>SLA missed.</strong> Try continuous batching for queue wait, chunked prefill for long prompts, then decide whether speculation or quantization is worth its tradeoff.';
}

function renderStrip(result, snapshot) {
  const frag = document.createDocumentFragment();
  result.requests.forEach((request) => {
    const chip = document.createElement('span');
    chip.className = 'request-chip';
    chip.textContent = request.id;
    chip.title = `Request ${request.id}: ${request.promptTokens} prompt tokens, ${request.outputTokens} output tokens`;
    if (!snapshot) chip.dataset.state = 'queued';
    frag.append(chip);
  });
  els.requestStrip.replaceChildren(frag);
  if (snapshot) paintStrip(snapshot);
}

function paintStrip(snapshot) {
  document.querySelectorAll('.request-chip').forEach((chip) => {
    const id = Number(chip.textContent);
    chip.dataset.state = snapshot.doneCount >= id ? 'done' : snapshot.decodingIds.includes(id) ? 'decoding' : snapshot.prefillingId === id ? 'prefilling' : snapshot.queuedIds.includes(id) ? 'queued' : 'arriving';
  });
}

function renderSnapshot(snapshot, { complete = false } = {}) {
  if (!snapshot || !activeResult) return;
  els.liveClock.textContent = formatMs(snapshot.ms);
  els.doneCount.textContent = `${snapshot.doneCount}/${activeResult.metrics.requested} complete`;
  els.engineStatus.textContent = complete
    ? 'Complete'
    : snapshot.prefillingId
      ? `Prefill ${snapshot.prefillingId}${snapshot.decodingIds.length ? ` + decode ${snapshot.decodingIds.join(', ')}` : ''}`
      : snapshot.decodingIds.length
        ? `Decode ${snapshot.decodingIds.join(', ')}`
        : 'Waiting for work';
  els.memoryLabel.textContent = `${snapshot.memoryGb.toFixed(1)} GB live`;
  setMemoryFill(snapshot.memoryGb);
  els.queueDots.replaceChildren(...snapshot.queuedIds.slice(0, 14).map(tokenDot));
  els.prefillLane.replaceChildren(...(snapshot.prefillingId ? [tokenDot(snapshot.prefillingId, 'hot')] : [emptyNote('idle')]));
  els.decodeLane.replaceChildren(...(snapshot.decodingIds.length ? snapshot.decodingIds.slice(0, 12).map((id) => tokenDot(id, 'cool')) : [emptyNote('idle')]));
  paintStrip(snapshot);
}

function setMemoryFill(memoryGb) {
  els.memoryFill.style.width = `${Math.min(100, (memoryGb / GPU_MEMORY_GB) * 100)}%`;
  els.memoryFill.dataset.hot = memoryGb / GPU_MEMORY_GB > 0.82 ? 'true' : 'false';
}

function weightMemoryGb(sourceConfig) {
  return sourceConfig.quant8 ? 6.87 : WEIGHTS_GB;
}

function naiveConfig(sourceConfig) {
  return normalizeConfig({
    ...sourceConfig,
    continuousBatching: false,
    chunkedPrefill: false,
    speculative: false,
    quant8: false,
  });
}

function tokenDot(id, tone = '') {
  const dot = document.createElement('span');
  dot.className = `token-dot ${tone}`.trim();
  dot.textContent = id;
  return dot;
}

function emptyNote(text) {
  const note = document.createElement('span');
  note.className = 'empty-note';
  note.textContent = text;
  return note;
}

function applyGuidedStep(index) {
  guidedIndex = index;
  config = normalizeConfig({ ...config, ...GUIDED_STEPS[index].config });
  setControls(config);
  renderGuide();
  resetRun(`Guided step ${index + 1} ready. Run the queue when you are.`);
}

function renderGuide() {
  const step = GUIDED_STEPS[guidedIndex];
  els.stepTitle.textContent = step.title;
  els.stepText.textContent = step.text;
  els.stepCount.textContent = `${guidedIndex + 1} / ${GUIDED_STEPS.length}`;
  els.stepDots.replaceChildren(...GUIDED_STEPS.map((_, i) => {
    const dot = document.createElement('span');
    dot.dataset.active = String(i === guidedIndex);
    return dot;
  }));
}

function renderAssumptions() {
  els.assumptionList.replaceChildren(...MODEL_ASSUMPTIONS.map((text) => {
    const li = document.createElement('li');
    li.textContent = text;
    return li;
  }));
}

function markScenario(activeButton) {
  document.querySelectorAll('[data-scenario]').forEach((el) => {
    const active = el === activeButton;
    el.dataset.active = String(active);
    el.setAttribute('aria-pressed', String(active));
  });
}

function stopPlayback() {
  if (playTimer) window.clearInterval(playTimer);
  playTimer = null;
}

function formatMs(ms) {
  if (ms >= 1000) return `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)}s`;
  return `${Math.round(ms)}ms`;
}

init();
