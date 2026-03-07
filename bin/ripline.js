#!/usr/bin/env node
/**
 * Ripline CLI entry point for npm/npx.
 * Use: npx @vector/openclaw-pipeline-plugin run --pipeline <path> [options]
 * Or after install: ripline run --pipeline <path> [options]
 */
const path = require("path");
require(path.join(__dirname, "..", "dist", "cli", "run.js"));
