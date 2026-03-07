# Cron and automation (AgentMail, Telegram)

Run the area-owner pipeline on a schedule and send the backlog summary by email or to Telegram.

## Cron entry (daily 13:00 CT)

```bash
# Run pipeline and email backlog summary
0 13 * * * cd /path/to/openclaw-pipeline-plugin && npm run build && node bin/ripline.js run -p pipelines/templates/ripline-area-owner.yaml -i samples/ripline-area-owner-inputs.json -o dist/backlog-cron.json 2>&1 | mail -s "Ripline backlog" you@example.com
```

Or use the dedicated cron script (prints summary to stdout):

```bash
0 13 * * * cd /path/to/openclaw-pipeline-plugin && npx tsx scripts/run-area-owner-cron.ts 2>&1 | mail -s "Ripline backlog" you@example.com
```

## AgentMail

To send the summary via [AgentMail](https://agentmail.to) (or OpenClaw’s email tool), run the pipeline and then have your agent read the output file and send it:

1. **Cron** runs at 13:00 CT and writes the backlog to `dist/backlog-cron.json` (or `RIPLINE_OUT`).
2. **OpenClaw cron job** (or a follow-up job) runs an agent that:
   - Reads `dist/backlog-cron.json` (or the summary text from the cron script’s stdout).
   - Composes a short “Ripline backlog” email and sends it via AgentMail (or your configured email tool).

Example (pseudo-config): schedule a daily job that runs `npx tsx scripts/run-area-owner-cron.ts`, captures stdout, and passes that text to the agent’s “send email” action with subject “Ripline backlog”.

## Telegram

To post the summary to a Telegram channel or chat:

1. Run the cron script and capture stdout:  
   `npx tsx scripts/run-area-owner-cron.ts > /tmp/ripline-summary.txt`
2. Use a Telegram bot or script to send the file (or its contents) to your channel/chat. For example, with `curl` and a bot token:

   ```bash
   curl -s -X POST "https://api.telegram.org/bot<BOT_TOKEN>/sendMessage" \
     -d "chat_id=<CHAT_ID>" \
     -d "text=$(cat /tmp/ripline-summary.txt)"
   ```

3. Or schedule an OpenClaw job that runs the pipeline, reads the summary (from file or script output), and calls your Telegram integration to post it.

## Env vars (optional)

| Variable        | Description |
|----------------|-------------|
| `RIPLINE_INPUTS` | Path to JSON inputs (default: `samples/ripline-area-owner-inputs.json`) |
| `RIPLINE_OUT`    | Path for backlog JSON (default: `dist/backlog-cron.json`) |
