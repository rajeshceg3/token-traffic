import { DEFAULT_CONFIG, SCENARIOS, compareConfigs, simulate } from './model.js';

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
  naiveButton: document.querySelector('#naiveButton'),
  statusText: document.querySelector('#statusText'),
  insightTitle: document.querySelector('#insightTitle'),
  insightText: document.querySelector('#insightText'),
  ttftMetric: document.querySelector('#ttftMetric'),
  throughputMetric: document.querySelector('#throughputMetric'),
  memoryMetric: document.querySelector('#memoryMetric'),
  makespanMetric: document.querySelector('#makespanMetric'),
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
    config: { requests: 1, promptTokens: 900, outputTokens: 120, kvCache: true, continuousBatching: false, chunkedPrefill: false, speculative: false, quant8: false },
  },
  {
    title: '2. Decode is one step at a time',
    text: 'The cache saves old work, but generation is still sequential: one token, append it, then the next. Turn the cache off later to feel why reuse matters.',
    config: { requests: 1, promptTokens: 900, outputTokens: 260, kvCache: true, continuousBatching: false, chunkedPrefill: false, speculative: false, quant8: false },
  },
  {
    title: '3. A queue changes the problem',
    text: 'With many requests, a naive engine lets one conversation own the GPU from prompt through final token. Everyone behind it waits.',
    config: { requests: 18, promptTokens: 900, outputTokens: 180, kvCache: true, continuousBatching: false, chunkedPrefill: false, speculative: false, quant8: false },
  },
  {
    title: '4. Continuous batching swaps finished work out',
    text: 'Finished requests leave immediately. Waiting requests fill the space, so the GPU spends fewer cycles idling between conversations.',
    config: { requests: 18, promptTokens: 900, outputTokens: 180, kvCache: true, continuousBatching: true, chunkedPrefill: false, speculative: false, quant8: false },
  },
  {
    title: '5. Chunked prefill stops the long prompt roadblock',
    text: 'A huge prompt no longer pauses every active decode. The engine takes one slice of prefill, lets decode progress, then takes another slice.',
    config: { requests: 8, promptTokens: 3600, outputTokens: 220, kvCache: true, continuousBatching: true, chunkedPrefill: true, speculative: false, quant8: false },
  },
  {
    title: '6. Every win has a bill',
    text: 'Speculation needs a useful draft. Quantization trades precision for memory and speed. More concurrency grows the KV cache. The right mix depends on the workload.',
    config: { requests: 24, promptTokens: 1300, outputTokens: 240, kvCache: true, continuousBatching: true, chunkedPrefill: true, speculative: true, quant8: true, challenge: true },
  },
];

let config = { ...DEFAULT_CONFIG };
let result = simulate(config);
let previousConfig = null;
let playTimer = null;
let snapshotIndex = 0;
let guidedIndex = 0;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function init() {
  bindControls();
  setControls(config);
  renderAssumptions();
  renderGuide();
  renderResult({ autoplay: false });
}

function bindControls() {
  document.querySelectorAll('[data-scenario]').forEach((button) => {
    button.addEventListener('click', () => {
      const scenario = SCENARIOS[button.dataset.scenario];
      config = { ...config, ...pickScenario(scenario) };
      setControls(config);
      runSimulation();
      announceScenario(button, scenario.note);
    });
  });

  for (const el of [els.promptRange, els.outputRange, els.requestRange]) {
    el.addEventListener('input', () => {
      config = readControls();
      updateRangeLabels();
      runSimulation({ quiet: true });
    });
  }

  for (const el of [els.kvToggle, els.continuousToggle, els.chunkedToggle, els.specToggle, els.quantToggle]) {
    el.addEventListener('change', () => {
      config = readControls();
      runSimulation();
    });
  }

  els.challengeToggle.addEventListener('change', () => {
    config = readControls();
    els.challengeCard.hidden = !config.challenge;
    runSimulation();
  });

  els.runButton.addEventListener('click', () => runSimulation({ autoplay: true }));
  els.guideButton.addEventListener('click', () => {
    document.querySelector('#guided').scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
    applyGuidedStep(0);
  });
  els.nextStep.addEventListener('click', () => applyGuidedStep((guidedIndex + 1) % GUIDED_STEPS.length));
  els.naiveButton.addEventListener('click', showNaiveComparison);
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

function runSimulation(options = {}) {
  stopPlayback();
  previousConfig = previousConfig || { ...config, continuousBatching: false, chunkedPrefill: false, speculative: false, quant8: false };
  result = simulate(config);
  renderResult(options);
}

function renderResult({ autoplay = true, quiet = false } = {}) {
  renderMetrics(result.metrics);
  renderInsight(previousConfig, config);
  renderChallenge();
  renderStrip();
  renderSnapshot(result.snapshots[0]);
  if (autoplay && !reducedMotion && !quiet) startPlayback();
  if (quiet) els.statusText.textContent = 'Controls update the simulation immediately.';
  else els.statusText.textContent = result.metrics.timedOut ? 'The educational run timed out before every request finished.' : 'Simulation complete. Replay the queue or change a switch.';
}

function renderMetrics(metrics) {
  els.ttftMetric.textContent = formatMs(metrics.avgTtftMs);
  els.throughputMetric.textContent = `${metrics.throughputTokS.toLocaleString()} tok/s`;
  els.memoryMetric.textContent = `${metrics.peakMemoryGb.toFixed(1)} GB`;
  els.makespanMetric.textContent = formatMs(metrics.makespanMs);
  els.memoryFill.style.width = `${Math.min(100, metrics.cachePressurePct)}%`;
  els.memoryFill.dataset.hot = metrics.cachePressurePct > 82 ? 'true' : 'false';
  els.memoryLabel.textContent = `${metrics.cachePressurePct}% of the teaching GPU`;
}

function renderInsight(beforeConfig, afterConfig) {
  if (!beforeConfig) {
    els.insightTitle.textContent = 'Start with the queue';
    els.insightText.textContent = 'Run it once, then flip one optimization. The comparison explains what changed without pretending this is hardware benchmarking.';
    return;
  }
  const comparison = compareConfigs(beforeConfig, afterConfig);
  if (!afterConfig.kvCache) {
    els.insightTitle.textContent = 'The cache bill came due';
    els.insightText.textContent = 'Decode slowed because each new token revisits old work. The memory gauge looks lighter, but the request queue pays for it.';
  } else if (comparison.throughputDeltaPct >= 20) {
    els.insightTitle.textContent = 'Throughput moved first';
    els.insightText.textContent = `Throughput rose ${Math.abs(comparison.throughputDeltaPct)}%. Finished work is leaving the engine instead of holding a seat.`;
  } else if (comparison.ttftDeltaPct <= -15) {
    els.insightTitle.textContent = 'First tokens arrive sooner';
    els.insightText.textContent = `Average TTFT fell ${Math.abs(comparison.ttftDeltaPct)}%. Long prompts are no longer blocking the whole room.`;
  } else if (comparison.memoryDeltaPct <= -10) {
    els.insightTitle.textContent = 'Memory pressure dropped';
    els.insightText.textContent = `Peak memory fell ${Math.abs(comparison.memoryDeltaPct)}%. That opens room for more concurrent requests, with a quality tradeoff to check.`;
  } else if (afterConfig.speculative) {
    els.insightTitle.textContent = 'Speculation helps when the draft is right';
    els.insightText.textContent = 'The helper proposes tokens and the main model verifies them. A poor assistant or low acceptance can erase the gain.';
  } else {
    els.insightTitle.textContent = 'A small trade, not magic';
    els.insightText.textContent = 'This mix changes the balance between queue wait, token speed and cache pressure. Watch which metric moved before calling it better.';
  }
  previousConfig = { ...afterConfig };
}

function renderChallenge() {
  if (!config.challenge) return;
  const m = result.metrics;
  const pass = m.avgTtftMs <= 1800 && m.throughputTokS >= 55 && m.peakMemoryGb <= 72;
  els.challengeResult.dataset.pass = String(pass);
  els.challengeResult.innerHTML = pass
    ? '<strong>SLA met.</strong> First tokens stay quick, throughput clears the room, and the cache still fits.'
    : '<strong>SLA missed.</strong> Try continuous batching for queue wait, chunked prefill for long prompts, then decide whether speculation or quantization is worth its tradeoff.';
}

function renderStrip() {
  const frag = document.createDocumentFragment();
  result.requests.forEach((request) => {
    const chip = document.createElement('span');
    chip.className = 'request-chip';
    chip.textContent = request.id;
    chip.title = `Request ${request.id}: ${request.promptTokens} prompt tokens, ${request.outputTokens} output tokens`;
    frag.append(chip);
  });
  els.requestStrip.replaceChildren(frag);
}

function startPlayback() {
  stopPlayback();
  snapshotIndex = 0;
  const delay = Math.max(35, Math.min(160, result.metrics.makespanMs / Math.max(1, result.snapshots.length) / 12));
  playTimer = window.setInterval(() => {
    snapshotIndex += 1;
    if (snapshotIndex >= result.snapshots.length) {
      stopPlayback();
      els.statusText.textContent = 'Every request finished. Change one switch and compare.';
      return;
    }
    renderSnapshot(result.snapshots[snapshotIndex]);
  }, delay);
}

function stopPlayback() {
  if (playTimer) window.clearInterval(playTimer);
  playTimer = null;
}

function renderSnapshot(snapshot) {
  if (!snapshot) return;
  els.liveClock.textContent = formatMs(snapshot.ms);
  els.doneCount.textContent = `${snapshot.doneCount}/${result.metrics.requested} complete`;
  els.engineStatus.textContent = snapshot.prefillingId
    ? `Prefill ${snapshot.prefillingId}${snapshot.decodingIds.length ? ` + decode ${snapshot.decodingIds.join(', ')}` : ''}`
    : snapshot.decodingIds.length
      ? `Decode ${snapshot.decodingIds.join(', ')}`
      : 'Waiting for work';
  els.memoryLabel.textContent = `${snapshot.memoryGb.toFixed(1)} GB live`;
  els.memoryFill.style.width = `${Math.min(100, (snapshot.memoryGb / 80) * 100)}%`;
  els.queueDots.replaceChildren(...snapshot.queuedIds.slice(0, 14).map(tokenDot));
  els.prefillLane.replaceChildren(...(snapshot.prefillingId ? [tokenDot(snapshot.prefillingId, 'hot')] : [emptyNote('idle')]));
  els.decodeLane.replaceChildren(...(snapshot.decodingIds.length ? snapshot.decodingIds.slice(0, 12).map((id) => tokenDot(id, 'cool')) : [emptyNote('idle')]));
  document.querySelectorAll('.request-chip').forEach((chip) => {
    const id = Number(chip.textContent);
    chip.dataset.state = snapshot.doneCount >= id ? 'done' : snapshot.decodingIds.includes(id) ? 'decoding' : snapshot.prefillingId === id ? 'prefilling' : snapshot.queuedIds.includes(id) ? 'queued' : 'arriving';
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

function showNaiveComparison() {
  const naive = { ...config, kvCache: true, continuousBatching: false, chunkedPrefill: false, speculative: false, quant8: false };
  const comparison = compareConfigs(naive, config);
  els.insightTitle.textContent = 'Against the naive engine';
  els.insightText.textContent = `This setup changes TTFT by ${comparison.ttftDeltaPct}%, throughput by ${comparison.throughputDeltaPct}%, total time by ${comparison.makespanDeltaPct}% and memory by ${comparison.memoryDeltaPct}%. Negative time is better; positive throughput is better.`;
}

function applyGuidedStep(index) {
  guidedIndex = index;
  config = { ...config, ...GUIDED_STEPS[index].config };
  setControls(config);
  renderGuide();
  runSimulation({ autoplay: true });
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
  els.assumptionList.replaceChildren(...result.assumptions.map((text) => {
    const li = document.createElement('li');
    li.textContent = text;
    return li;
  }));
}

function announceScenario(button, note) {
  document.querySelectorAll('[data-scenario]').forEach((el) => el.dataset.active = String(el === button));
  els.statusText.textContent = note;
}

function formatMs(ms) {
  if (ms >= 1000) return `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)}s`;
  return `${Math.round(ms)}ms`;
}

init();
