# Cron and automation

Ripline works well in cron, CI, or any non-interactive automation where you want a repeatable workflow invocation with explicit inputs and outputs.

## Minimal cron example

```bash
0 * * * * cd /path/to/ripline && node bin/ripline.js run \
  --pipeline pipelines/examples/hello-world.yaml \
  --input '{"person":"cron","goal":"hourly check-in"}' \
  --output /tmp/ripline-output.json
```

## Using input and output files

For larger inputs, keep them in files instead of embedding JSON in the cron entry:

```bash
node bin/ripline.js run \
  --pipeline /path/to/pipeline.yaml \
  --input /path/to/inputs.json \
  --output /path/to/output.json
```

This makes scheduled runs easier to review, diff, and regenerate.

## CI example

```bash
npm install
npm run build
node bin/ripline.js run \
  --pipeline pipelines/examples/hello-world.yaml \
  --input samples/hello-world-inputs.json
```

## Failure handling

- Ripline exits with a non-zero status on failure, so cron and CI can alert or retry.
- Use `ripline run --resume <runId>` when you want to continue a persisted run after a failure.
- Use `ripline logs <runId>` or the HTTP log endpoints to inspect failures without rerunning immediately.

## Helpful environment variables

| Variable | Description |
| --- | --- |
| `RIPLINE_INPUTS` | Path to a JSON input file for helper scripts or wrappers |
| `RIPLINE_OUT` | Path to write final JSON output for helper scripts or wrappers |
