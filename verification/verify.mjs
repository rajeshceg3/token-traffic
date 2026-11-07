import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, SCENARIOS, compareConfigs, normalizeConfig, simulate } from '../model.js';

const checks = [];
function check(name, fn) {
  try {
    fn();
    checks.push({ name, pass: true });
  } catch (error) {
    checks.push({ name, pass: false, error });
  }
}

const base = { ...DEFAULT_CONFIG, requests: 18, promptTokens: 1200, outputTokens: 220 };

check('simulation finishes all requests', () => {
  const result = simulate(base);
  assert.equal(result.metrics.finished, result.metrics.requested);
  assert.equal(result.metrics.timedOut, false);
  assert.ok(result.metrics.makespanMs > 0);
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

check('8-bit weights lower peak memory', () => {
  const bf16 = simulate({ ...base, quant8: false }).metrics;
  const quant = simulate({ ...base, quant8: true }).metrics;
  assert.ok(quant.peakMemoryGb < bf16.peakMemoryGb);
});

check('speculative draft lowers decode time', () => {
  const normal = simulate({ ...base, speculative: false }).metrics;
  const speculative = simulate({ ...base, speculative: true }).metrics;
  assert.ok(speculative.avgDecodeMs < normal.avgDecodeMs);
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

check('no NaN leaks into metrics or snapshots', () => {
  const result = simulate({ promptTokens: 64, outputTokens: 16, requests: 1 });
  for (const value of Object.values(result.metrics)) {
    if (typeof value === 'number') assert.ok(Number.isFinite(value));
  }
  assert.ok(result.snapshots.every((s) => Number.isFinite(s.ms) && Number.isFinite(s.memoryGb)));
});

const [html, css, app] = await Promise.all([
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../styles.css', import.meta.url), 'utf8'),
  readFile(new URL('../app.js', import.meta.url), 'utf8'),
]);

check('required interactive controls exist', () => {
  for (const id of ['promptRange','outputRange','requestRange','kvToggle','continuousToggle','chunkedToggle','specToggle','quantToggle','challengeToggle','runButton','guideButton','nextStep']) {
    assert.ok(html.includes(`id="${id}"`), id);
  }
});

check('guided step-through and sources are present', () => {
  assert.ok(html.includes('id="nextStep"'));
  assert.ok(html.includes('huggingface.co/blog/continuous_batching'));
  assert.ok(html.includes('docs.vllm.ai/en/stable/configuration/optimization'));
  assert.ok(app.includes('GUIDED_STEPS'));
});

check('privacy guard: no user names or personal context', () => {
  const combined = `${html}\n${css}\n${app}`.toLowerCase();
  for (const forbidden of ['rajesh', 'nishanth', 'almond fudge', 'chennai']) {
    assert.ok(!combined.includes(forbidden), forbidden);
  }
});

check('responsive and reduced-motion rules exist', () => {
  assert.ok(css.includes('@media (max-width: 520px)'));
  assert.ok(css.includes('@media (prefers-reduced-motion: reduce)'));
});

const failed = checks.filter((c) => !c.pass);
for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'} ${c.name}${c.error ? ` - ${c.error.message}` : ''}`);
console.log(`${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) process.exit(1);
