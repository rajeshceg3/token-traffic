import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONFIG,
  MODEL_ASSUMPTIONS,
  QUANT_WEIGHTS_GB,
  SCENARIOS,
  WEIGHTS_GB,
  compareConfigs,
  normalizeConfig,
  simulate,
} from '../model.js';
import { APP_STATES, transitionState } from '../statechart.js';

const checks = [];
function check(name, fn) {
  try {
    fn();
    checks.push({ name, pass: true });
  } catch (error) {
    checks.push({ name, pass: false, error });
  }
}

const base = { ...DEFAULT_CONFIG, continuousBatching: false, chunkedPrefill: false, requests: 18, promptTokens: 1200, outputTokens: 220 };

check('simulation finishes all requests', () => {
  const result = simulate(base);
  assert.equal(result.metrics.finished, result.metrics.requested);
  assert.equal(result.metrics.timedOut, false);
  assert.ok(result.metrics.makespanMs > 0);
});

check('simulation state snapshots are coherent', () => {
  const result = simulate(base);
  let lastDone = 0;
  for (const snapshot of result.snapshots) {
    assert.ok(Number.isInteger(snapshot.doneCount));
    assert.ok(snapshot.doneCount >= lastDone);
    lastDone = snapshot.doneCount;
    assert.ok(snapshot.prefillingId === null || Number.isInteger(snapshot.prefillingId));
    assert.ok(snapshot.decodingIds.every(Number.isInteger));
    assert.ok(snapshot.queuedIds.every(Number.isInteger));
  }
  assert.equal(result.snapshots.at(-1).doneCount, result.metrics.requested);
});

check('KV cache improves decode-heavy workload', () => {
  const withCache = simulate({ ...base, kvCache: true }).metrics;
  const withoutCache = simulate({ ...base, kvCache: false }).metrics;
  assert.ok(withCache.avgDecodeMs < withoutCache.avgDecodeMs, `${withCache.avgDecodeMs} !< ${withoutCache.avgDecodeMs}`);
  assert.ok(withCache.throughputTokS > withoutCache.throughputTokS);
});

check('continuous batching improves throughput under concurrency', () => {
  const naive = simulate({ ...base, continuousBatching: false }).metrics;
  const continuous = simulate({ ...base, continuousBatching: true, chunkedPrefill: true }).metrics;
  assert.ok(continuous.throughputTokS > naive.throughputTokS, `${continuous.throughputTokS} !> ${naive.throughputTokS}`);
  assert.ok(continuous.makespanMs < naive.makespanMs);
});

check('chunked prefill keeps decode moving behind long prompts', () => {
  const longPrompt = { ...base, requests: 8, promptTokens: 4200, outputTokens: 180, continuousBatching: true };
  const monolithic = simulate({ ...longPrompt, chunkedPrefill: false }).metrics;
  const chunked = simulate({ ...longPrompt, chunkedPrefill: true }).metrics;
  assert.ok(chunked.avgDecodeMs < monolithic.avgDecodeMs, `${chunked.avgDecodeMs} !< ${monolithic.avgDecodeMs}`);
  assert.ok(chunked.makespanMs <= monolithic.makespanMs);
});

check('8-bit weights lower modeled weight memory only', () => {
  const bf16 = simulate({ ...base, quant8: false, speculative: false }).metrics;
  const quant = simulate({ ...base, quant8: true, speculative: false }).metrics;
  assert.ok(QUANT_WEIGHTS_GB < WEIGHTS_GB);
  assert.ok(quant.peakMemoryGb < bf16.peakMemoryGb);
  assert.equal(quant.avgDecodeMs, bf16.avgDecodeMs, 'quantization must not be a universal speed knob');
});

check('speculative decoding is conditional, not universal', () => {
  const longNormal = simulate({ ...base, outputTokens: 260, speculative: false }).metrics;
  const longSpec = simulate({ ...base, outputTokens: 260, speculative: true }).metrics;
  const shortNormal = simulate({ ...base, outputTokens: 64, speculative: false }).metrics;
  const shortSpec = simulate({ ...base, outputTokens: 64, speculative: true }).metrics;
  assert.ok(longSpec.avgDecodeMs < longNormal.avgDecodeMs);
  assert.ok(shortSpec.avgDecodeMs >= shortNormal.avgDecodeMs);
});

check('inputs clamp to safe teaching ranges', () => {
  const config = normalizeConfig({ promptTokens: 999999, outputTokens: -4, requests: 999 });
  assert.equal(config.promptTokens, 8192);
  assert.equal(config.outputTokens, 16);
  assert.equal(config.requests, 48);
});

check('scenario presets stay distinct', () => {
  assert.ok(SCENARIOS.longBrief.promptTokens > SCENARIOS.balanced.promptTokens);
  assert.ok(SCENARIOS.bursts.requests > SCENARIOS.balanced.requests);
});

check('comparison metrics have expected direction', () => {
  const comparison = compareConfigs(base, { ...base, continuousBatching: true, chunkedPrefill: true });
  assert.ok(comparison.throughputDeltaPct > 0);
  assert.ok(comparison.makespanDeltaPct < 0);
});

check('default optimized journey has meaningful naive deltas', () => {
  const naive = simulate({
    ...DEFAULT_CONFIG,
    kvCache: false,
    continuousBatching: false,
    chunkedPrefill: false,
    speculative: false,
    quant8: false,
  }).metrics;
  const optimized = simulate(DEFAULT_CONFIG).metrics;
  assert.ok(optimized.throughputTokS > naive.throughputTokS);
  assert.ok(optimized.makespanMs < naive.makespanMs);
  assert.ok(optimized.avgTtftMs < naive.avgTtftMs);
});

check('no NaN leaks into metrics or snapshots', () => {
  const result = simulate({ promptTokens: 64, outputTokens: 16, requests: 1 });
  for (const value of Object.values(result.metrics)) {
    if (typeof value === 'number') assert.ok(Number.isFinite(value));
  }
  assert.ok(result.snapshots.every((s) => Number.isFinite(s.ms) && Number.isFinite(s.memoryGb)));
});

check('model limits distinguish teaching units from GPU measurements', () => {
  const text = MODEL_ASSUMPTIONS.join(' ');
  assert.match(text, /not measurements from a real GPU/i);
  assert.match(text, /rather than promising a universal speedup/i);
  assert.match(text, /speed and quality effects depend/i);
});

check('statechart allows the intended run journey only', () => {
  assert.deepEqual(Object.keys(APP_STATES), ['ready', 'running', 'complete']);
  assert.equal(transitionState('ready', 'RUN'), 'running');
  assert.equal(transitionState('running', 'FINISH'), 'complete');
  assert.equal(transitionState('complete', 'RUN'), 'running');
  assert.equal(transitionState('complete', 'RESET'), 'ready');
  assert.throws(() => transitionState('ready', 'FINISH'), /Invalid app transition/);
});

const [html, css, app, statechart] = await Promise.all([
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../styles.css', import.meta.url), 'utf8'),
  readFile(new URL('../app.js', import.meta.url), 'utf8'),
  readFile(new URL('../statechart.js', import.meta.url), 'utf8'),
]);

check('purpose-fit order puts simulator and one next action first', () => {
  const hero = html.indexOf('class="hero"');
  const simulator = html.indexOf('class="simulator-grid"');
  const engine = html.indexOf('class="panel engine-panel"');
  const journey = html.indexOf('class="panel journey-panel"');
  const guided = html.indexOf('id="guided"');
  const tuner = html.indexOf('class="panel tuner-panel"');
  assert.ok(hero > -1 && hero < simulator);
  assert.ok(engine > -1 && engine < journey);
  assert.ok(journey < guided && guided < tuner);
  const heroHtml = html.slice(hero, simulator);
  assert.equal((heroHtml.match(/class="primary"/g) || []).length, 1);
  assert.ok(heroHtml.includes('id="runButton"'));
});

check('advanced controls use progressive disclosure', () => {
  assert.ok(html.includes('<details class="panel tuner-panel" id="tunerPanel">'));
  assert.ok(html.includes('<summary>'));
  assert.ok(html.indexOf('id="guided"') < html.indexOf('id="tunerPanel"'));
  assert.ok(html.indexOf('id="tunerPanel"') < html.indexOf('id="challengeCard"'));
});

check('eyebrow text is removed', () => {
  assert.ok(!html.includes('class="kicker"'));
  assert.ok(!css.includes('.kicker'));
});

check('required native keyboard-reachable controls exist', () => {
  for (const id of ['promptRange','outputRange','requestRange','kvToggle','continuousToggle','chunkedToggle','specToggle','quantToggle','challengeToggle','runButton','guideButton','nextStep']) {
    assert.ok(html.includes(`id="${id}"`), id);
  }
  assert.ok(html.includes('type="range"'));
  assert.ok(html.includes('type="checkbox"'));
  assert.ok(html.includes('<summary>'));
  assert.ok(css.includes(':focus-visible'));
});

check('guided step-through and sources are present', () => {
  assert.ok(html.includes('id="nextStep"'));
  assert.ok(html.includes('huggingface.co/blog/continuous_batching'));
  assert.ok(html.includes('docs.vllm.ai/en/stable/configuration/optimization'));
  assert.ok(app.includes('GUIDED_STEPS'));
});

check('copy avoids benchmark and universal-speed claims', () => {
  const combined = `${html}\n${app}`;
  assert.match(combined, /not measured GPU benchmarks/i);
  assert.match(combined, /not a universal speedup/i);
  assert.match(combined, /speed and quality depend/i);
  assert.ok(!/always faster|guaranteed speedup|measured on your GPU/i.test(combined));
});

check('app uses explicit ready-running-complete state', () => {
  assert.ok(app.includes("transitionState(appState, 'RESET')"));
  assert.ok(app.includes("transitionState(appState, 'RUN')"));
  assert.ok(app.includes("transitionState(appState, 'FINISH')"));
  assert.ok(statechart.includes("ready") && statechart.includes("running") && statechart.includes("complete"));
  assert.ok(app.includes("els.engineStatus.textContent = 'Ready'"));
  assert.ok(app.includes("? 'Complete'"));
});

check('privacy guard: no user names or personal context', () => {
  const combined = `${html}\n${css}\n${app}\n${statechart}`.toLowerCase();
  for (const forbidden of ['rajesh', 'nishanth', 'almond fudge', 'chennai']) {
    assert.ok(!combined.includes(forbidden), forbidden);
  }
});

check('responsive portrait, landscape, and reduced-motion rules exist', () => {
  assert.ok(css.includes('@media (max-width: 520px)'));
  assert.ok(css.includes('@media (orientation: landscape) and (max-height: 540px)'));
  assert.ok(css.includes('@media (prefers-reduced-motion: reduce)'));
  assert.ok(app.includes("window.matchMedia('(prefers-reduced-motion: reduce)')"));
  assert.ok(app.includes('if (reducedMotion)'));
});

check('hidden state is honored over author styles', () => {
  assert.ok(css.includes('[hidden] { display: none !important; }'));
});

const failed = checks.filter((c) => !c.pass);
for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'} ${c.name}${c.error ? ` - ${c.error.message}` : ''}`);
console.log(`${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) process.exit(1);
