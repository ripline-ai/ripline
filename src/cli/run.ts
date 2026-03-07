#!/usr/bin/env node
import { createRiplineCliProgram } from "./program.js";

createRiplineCliProgram().parse(process.argv);
