# Evals

These scripts provide simple repeatable checks for memory behavior.

Run them after building:

```bash
npm run build
npm run eval:retrieval
```

Current evals:

- `retrieval-quality.mjs`: checks that prompt-ready context ranks an obviously relevant fact first
- `scenario-evals.mjs`: runs continuity scenarios for retrieval, bootstrap, unresolved work, and temporal recall
- `memory-quality/index.mjs`: runs the full memory-quality harness covering retention, contradictions, false memories, fidelity, and long-horizon behavior
