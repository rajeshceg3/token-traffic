# Token Traffic

Token Traffic is a static, educational LLM serving simulator. It shows how prefill, decode, KV caching, continuous batching, chunked prefill, speculative decoding and quantization change queue wait, throughput and cache pressure.

## Run locally

Serve the folder with any static server:

```bash
python3 -m http.server 8080
```

Open `http://localhost:8080`.

## Verify

```bash
node verification/verify.mjs
```

The checks cover the deterministic teaching model, required controls, sources, privacy strings, responsive CSS and reduced-motion support.

## Teaching model limits

This is not a hardware benchmark. Rates are chosen to make system tradeoffs visible. The KV-cache estimate uses the cited 7B example of 16 KB per token; real usage depends on model shape, precision, implementation and workload.

Sources:

- https://huggingface.co/blog/continuous_batching
- https://huggingface.co/docs/transformers/kv_cache
- https://huggingface.co/docs/transformers/v5.5.4/assisted_decoding
- https://docs.vllm.ai/en/stable/configuration/optimization/
- https://huggingface.co/docs/transformers/main/en/llm_optims
