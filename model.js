const GB = 1_000_000_000;
export const MODEL_BYTES_PER_TOKEN = 16_384; // Llama-2-7B example from the cited KV-cache derivation: 16 KB/token.
export const WEIGHTS_GB = 13.74; // Mistral-7B bf16 example from the cited inference guide.
export const QUANT_WEIGHTS_GB = 6.87; // Same guide's 8-bit example.
export const GPU_MEMORY_GB = 80; // Teaching budget, not a claim about the visitor's hardware.

export const DEFAULT_CONFIG = Object.freeze({
  promptTokens: 900,
  outputTokens: 180,
  requests: 16,
  kvCache: true,
  continuousBatching: false,
  chunkedPrefill: false,
  speculative: false,
  quant8: false,
  challenge: false,
});

export const MODEL_ASSUMPTIONS = Object.freeze([
  'All times and tokens/s are illustrative teaching units from a deterministic model, not measurements from a real GPU.',
  'KV cache memory uses the cited 7B example of 16 KB per token; real cache size varies by layers, heads, precision and implementation.',
  'Continuous batching and chunked prefill are scheduling and overlap techniques; this model explores one workload mix rather than promising a universal speedup.',
  'Speculative decoding is modeled with workload-dependent draft acceptance; a weak draft or short answer can erase the gain.',
  '8-bit weights lower modeled weight memory; speed and quality effects depend on the model, hardware and quantization method.',
]);

export const SCENARIOS = Object.freeze({
  balanced: {
    label: 'Busy chat hour',
    promptTokens: 900,
    outputTokens: 180,
    requests: 16,
    note: 'A middle path: enough concurrency for scheduling to matter, enough context for cache pressure to show.',
  },
  longBrief: {
    label: 'Long prompt',
    promptTokens: 3200,
    outputTokens: 220,
    requests: 5,
    note: 'A repository-scale prompt makes prefill the event everyone else waits behind.',
  },
  bursts: {
    label: 'Short bursts',
    promptTokens: 260,
    outputTokens: 110,
    requests: 30,
    note: 'Many small requests expose queueing and batch turnover more than raw prompt length.',
  },
});

export function normalizeConfig(input = {}) {
  const c = { ...DEFAULT_CONFIG, ...input };
  return {
    promptTokens: clamp(Math.round(Number(c.promptTokens)), 64, 8192),
    outputTokens: clamp(Math.round(Number(c.outputTokens)), 16, 1024),
    requests: clamp(Math.round(Number(c.requests)), 1, 48),
    kvCache: Boolean(c.kvCache),
    continuousBatching: Boolean(c.continuousBatching),
    chunkedPrefill: Boolean(c.chunkedPrefill),
    speculative: Boolean(c.speculative),
    quant8: Boolean(c.quant8),
    challenge: Boolean(c.challenge),
  };
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function requestShape(i, config) {
  // Deterministic variation keeps the simulation stable while making the queue feel real.
  const promptJitter = 0.86 + ((i * 37) % 29) / 100; // 0.86 - 1.14
  const outputJitter = 0.84 + ((i * 53) % 33) / 100; // 0.84 - 1.16
  const arrivalMs = i * Math.max(70, Math.round(2600 / Math.sqrt(config.requests + 1)));
  return {
    id: i + 1,
    promptTokens: Math.max(32, Math.round(config.promptTokens * promptJitter)),
    outputTokens: Math.max(8, Math.round(config.outputTokens * outputJitter)),
    arrivalMs,
    prefilledTokens: 0,
    generatedTokens: 0,
    state: 'arriving',
    startPrefillMs: null,
    firstTokenMs: null,
    finishMs: null,
  };
}

function rateFactors(config) {
  // Quantization changes the modeled memory bill and can leave room for more seats.
  // It is not treated as a universal speed knob because the cited guide notes
  // that quantization can add dequantization latency on some hardware.
  const spec = speculativeFactor(config);
  return {
    prefillTokensPerMs: 1.55,
    decodeTokensPerMsSingle: 0.052 * spec,
    decodeTokensPerMsAggregate: (config.continuousBatching ? 0.205 : 0.052) * spec,
    maxActive: config.continuousBatching ? (config.quant8 ? 12 : 9) : 1,
  };
}

function speculativeFactor(config) {
  if (!config.speculative) return 1;
  // The teaching model assumes a helpful draft only when there is enough output
  // for accepted runs to amortize verification. Short answers can get slower.
  return config.outputTokens >= 128 ? 1.28 : 0.94;
}

export function simulate(input = {}) {
  const config = normalizeConfig(input);
  const rates = rateFactors(config);
  const requests = Array.from({ length: config.requests }, (_, i) => requestShape(i, config));
  const dt = 25;
  const maxMs = 180_000;
  let now = 0;
  let prefilling = null;
  let peakCacheBytes = 0;
  let preemptions = 0;
  const snapshots = [];

  const pending = () => requests.filter((r) => r.state === 'queued');
  const decoding = () => requests.filter((r) => r.state === 'decoding');
  const done = () => requests.filter((r) => r.state === 'done');
  const unfinished = () => requests.some((r) => r.state !== 'done');

  function cacheBytes() {
    const open = requests.filter((r) => r.state === 'prefilling' || r.state === 'decoding');
    const bytes = open.reduce((sum, r) => sum + (r.prefilledTokens + r.generatedTokens) * MODEL_BYTES_PER_TOKEN, 0);
    return config.kvCache ? bytes : Math.round(bytes * 0.18); // no reusable cache: only the active working set is counted
  }

  function memoryGb() {
    return (config.quant8 ? QUANT_WEIGHTS_GB : WEIGHTS_GB) + cacheBytes() / GB;
  }

  function admit() {
    const activeCount = decoding().length + (prefilling ? 1 : 0);
    if (prefilling || activeCount >= rates.maxActive) return;
    const next = pending().sort((a, b) => a.arrivalMs - b.arrivalMs || a.id - b.id)[0];
    if (!next || next.arrivalMs > now) return;
    const projectedMemory = memoryGb() + next.promptTokens * MODEL_BYTES_PER_TOKEN / GB;
    if (projectedMemory > GPU_MEMORY_GB * 0.94) {
      preemptions += 1;
      return;
    }
    next.state = 'prefilling';
    next.startPrefillMs = now;
    prefilling = next;
  }

  function processPrefill() {
    if (!prefilling) return;
    const chunkLimit = config.chunkedPrefill ? 480 : Infinity;
    const remaining = prefilling.promptTokens - prefilling.prefilledTokens;
    const amount = Math.min(remaining, chunkLimit, rates.prefillTokensPerMs * dt);
    prefilling.prefilledTokens += amount;
    if (prefilling.prefilledTokens >= prefilling.promptTokens - 1e-6) {
      prefilling.prefilledTokens = prefilling.promptTokens;
      prefilling.state = 'decoding';
      prefilling.firstTokenMs = now + dt;
      prefilling = null;
    }
  }

  function decodeRateFor(request, activeCount) {
    if (!config.kvCache) {
      const contextPenalty = 1 + (request.promptTokens + request.generatedTokens) / 950;
      return (rates.decodeTokensPerMsSingle / contextPenalty) / Math.max(1, activeCount * 0.45);
    }
    if (!config.continuousBatching) return rates.decodeTokensPerMsSingle;
    return Math.min(rates.decodeTokensPerMsSingle, rates.decodeTokensPerMsAggregate / Math.max(1, activeCount));
  }

  function processDecode() {
    const active = decoding();
    if (!active.length) return;
    // A monolithic long prefill occupies the engine; chunked prefill lets decode tokens piggyback.
    if (prefilling && !config.chunkedPrefill) return;
    for (const request of active) {
      const amount = decodeRateFor(request, active.length) * dt;
      request.generatedTokens = Math.min(request.outputTokens, request.generatedTokens + amount);
      if (request.generatedTokens >= request.outputTokens - 1e-6) {
        request.generatedTokens = request.outputTokens;
        request.state = 'done';
        request.finishMs = now + dt;
      }
    }
  }

  while (unfinished() && now < maxMs) {
    for (const request of requests) {
      if (request.state === 'arriving' && request.arrivalMs <= now) request.state = 'queued';
    }
    if (config.continuousBatching) {
      admit();
      processPrefill();
      processDecode();
      admit();
    } else {
      // One request owns the engine from prompt through final token.
      if (!prefilling && decoding().length === 0) admit();
      if (prefilling) processPrefill();
      else processDecode();
    }
    peakCacheBytes = Math.max(peakCacheBytes, cacheBytes());
    if (now % 250 === 0 || (!unfinished() && snapshots[snapshots.length - 1]?.ms !== now)) {
      snapshots.push({
        ms: now,
        prefillingId: prefilling?.id ?? null,
        decodingIds: decoding().map((r) => r.id),
        queuedIds: pending().map((r) => r.id),
        doneCount: done().length,
        memoryGb: round(memoryGb(), 2),
      });
    }
    now += dt;
  }

  const finished = requests.filter((r) => Number.isFinite(r.finishMs));
  const totalOutput = finished.reduce((sum, r) => sum + r.outputTokens, 0);
  const totalInput = finished.reduce((sum, r) => sum + r.promptTokens, 0);
  const firstArrival = Math.min(...requests.map((r) => r.arrivalMs));
  const makespanMs = finished.length ? Math.max(...finished.map((r) => r.finishMs)) - firstArrival : 0;
  const ttfts = finished.map((r) => r.firstTokenMs - r.arrivalMs).sort((a, b) => a - b);
  const decodeDelays = finished.map((r) => r.finishMs - r.firstTokenMs);
  const metrics = {
    finished: finished.length,
    requested: requests.length,
    totalInput,
    totalOutput,
    avgTtftMs: round(mean(ttfts), 0),
    p95TtftMs: round(percentile(ttfts, 0.95), 0),
    avgDecodeMs: round(mean(decodeDelays), 0),
    makespanMs: round(makespanMs, 0),
    throughputTokS: makespanMs > 0 ? round(totalOutput / (makespanMs / 1000), 1) : 0,
    peakCacheGb: round(peakCacheBytes / GB, 2),
    peakMemoryGb: round((config.quant8 ? QUANT_WEIGHTS_GB : WEIGHTS_GB) + peakCacheBytes / GB, 2),
    cachePressurePct: round((((config.quant8 ? QUANT_WEIGHTS_GB : WEIGHTS_GB) + peakCacheBytes / GB) / GPU_MEMORY_GB) * 100, 1),
    preemptions,
    timedOut: unfinished(),
  };

  return {
    config,
    requests: requests.map((r) => ({
      id: r.id,
      promptTokens: r.promptTokens,
      outputTokens: r.outputTokens,
      arrivalMs: r.arrivalMs,
      firstTokenMs: nullableRound(r.firstTokenMs),
      finishMs: nullableRound(r.finishMs),
      state: r.state,
    })),
    metrics,
    snapshots: limitSnapshots(snapshots, 96),
    assumptions: [...MODEL_ASSUMPTIONS],
  };
}

function limitSnapshots(snapshots, max) {
  if (snapshots.length <= max) return snapshots;
  const stride = Math.ceil(snapshots.length / max);
  const picked = snapshots.filter((_, i) => i % stride === 0);
  const last = snapshots[snapshots.length - 1];
  if (picked[picked.length - 1] !== last) picked.push(last);
  return picked;
}

function mean(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1);
  return sorted[idx];
}

function round(value, digits = 0) {
  const f = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * f) / f;
}

function nullableRound(value) {
  return Number.isFinite(value) ? round(value, 0) : null;
}

export function compareConfigs(baseInput, changedInput) {
  const base = simulate(baseInput).metrics;
  const changed = simulate(changedInput).metrics;
  return {
    ttftDeltaPct: pctDelta(base.avgTtftMs, changed.avgTtftMs),
    throughputDeltaPct: pctDelta(base.throughputTokS, changed.throughputTokS),
    memoryDeltaPct: pctDelta(base.peakMemoryGb, changed.peakMemoryGb),
    makespanDeltaPct: pctDelta(base.makespanMs, changed.makespanMs),
  };
}

function pctDelta(before, after) {
  if (!before) return 0;
  return round(((after - before) / before) * 100, 1);
}
