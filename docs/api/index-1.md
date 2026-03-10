[**Ripline API Reference v0.1.0**](index)

***

[Ripline API Reference](index) / index

# index

## Interfaces

### ClaudeCodeRunnerConfig

Defined in: [claude-code-runner.ts:27](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/claude-code-runner.ts#L27)

#### Properties

##### allowDangerouslySkipPermissions?

> `optional` **allowDangerouslySkipPermissions**: `boolean`

Defined in: [claude-code-runner.ts:36](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/claude-code-runner.ts#L36)

Opt-in bypass; only from user config or env, never from pipeline/profile.

##### allowedTools?

> `optional` **allowedTools**: `string`[]

Defined in: [claude-code-runner.ts:30](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/claude-code-runner.ts#L30)

##### cwd?

> `optional` **cwd**: `string`

Defined in: [claude-code-runner.ts:29](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/claude-code-runner.ts#L29)

##### disallowedTools?

> `optional` **disallowedTools**: `string`[]

Defined in: [claude-code-runner.ts:31](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/claude-code-runner.ts#L31)

##### maxTurns?

> `optional` **maxTurns**: `number`

Defined in: [claude-code-runner.ts:32](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/claude-code-runner.ts#L32)

##### mode

> **mode**: `"plan"` \| `"execute"`

Defined in: [claude-code-runner.ts:28](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/claude-code-runner.ts#L28)

##### outputFormat?

> `optional` **outputFormat**: `"text"` \| `"json"`

Defined in: [claude-code-runner.ts:34](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/claude-code-runner.ts#L34)

##### timeoutSeconds?

> `optional` **timeoutSeconds**: `number`

Defined in: [claude-code-runner.ts:33](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/claude-code-runner.ts#L33)

## Type Aliases

### LlmAgentRunnerConfig

> **LlmAgentRunnerConfig** = `object`

Defined in: [llm-agent-runner.ts:3](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/llm-agent-runner.ts#L3)

#### Properties

##### apiKey?

> `optional` **apiKey**: `string`

Defined in: [llm-agent-runner.ts:6](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/llm-agent-runner.ts#L6)

##### baseURL?

> `optional` **baseURL**: `string`

Defined in: [llm-agent-runner.ts:7](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/llm-agent-runner.ts#L7)

##### model

> **model**: `string`

Defined in: [llm-agent-runner.ts:5](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/llm-agent-runner.ts#L5)

##### provider

> **provider**: `"ollama"` \| `"openai"` \| `"anthropic"`

Defined in: [llm-agent-runner.ts:4](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/llm-agent-runner.ts#L4)

***

### NormalizedConfig

> **NormalizedConfig** = `object`

Defined in: [index.ts:32](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/index.ts#L32)

#### Properties

##### authToken?

> `optional` **authToken**: `string`

Defined in: [index.ts:38](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/index.ts#L38)

##### httpPath

> **httpPath**: `string`

Defined in: [index.ts:36](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/index.ts#L36)

##### httpPort

> **httpPort**: `number`

Defined in: [index.ts:35](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/index.ts#L35)

##### maxConcurrency

> **maxConcurrency**: `number`

Defined in: [index.ts:37](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/index.ts#L37)

##### pipelinesDir

> **pipelinesDir**: `string`

Defined in: [index.ts:33](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/index.ts#L33)

##### runsDir

> **runsDir**: `string`

Defined in: [index.ts:34](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/index.ts#L34)

***

### OpenClawPluginApi

> **OpenClawPluginApi** = `object`

Defined in: [openclaw-agent-runner.ts:5](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/openclaw-agent-runner.ts#L5)

OpenClaw plugin API surface used to run agent commands.

#### Properties

##### runtime

> **runtime**: `object`

Defined in: [openclaw-agent-runner.ts:6](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/openclaw-agent-runner.ts#L6)

###### system

> **system**: `object`

###### system.runCommandWithTimeout()

> **runCommandWithTimeout**(`command`, `options?`): `Promise`\<\{ `code`: `number` \| `null`; `signal?`: `string` \| `null`; `stderr`: `string`; `stdout`: `string`; \}\>

###### Parameters

###### command

`string`[]

###### options?

`number` | \{ `input?`: `string`; `timeoutMs?`: `number`; \}

###### Returns

`Promise`\<\{ `code`: `number` \| `null`; `signal?`: `string` \| `null`; `stderr`: `string`; `stdout`: `string`; \}\>

## Variables

### default

> **default**: `object`

Defined in: [index.ts:82](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/index.ts#L82)

#### Type Declaration

##### description

> **description**: `string` = `"Ripline pipeline engine + CLI"`

##### id

> **id**: `string` = `"ripline"`

##### name

> **name**: `string` = `"Ripline"`

##### register()

> **register**(`api`): `void`

###### Parameters

###### api

`PluginApi`

###### Returns

`void`

## Functions

### createClaudeCodeRunner()

> **createClaudeCodeRunner**(`config`): `AgentRunner`

Defined in: [claude-code-runner.ts:109](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/claude-code-runner.ts#L109)

Create an AgentRunner that invokes the Claude Code (Agent) SDK.
Use for nodes with runner: claude-code; supports plan (read-only) and execute modes.

#### Parameters

##### config

[`ClaudeCodeRunnerConfig`](#claudecoderunnerconfig)

#### Returns

`AgentRunner`

***

### createLlmAgentRunner()

> **createLlmAgentRunner**(`config`): `AgentRunner`

Defined in: [llm-agent-runner.ts:49](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/llm-agent-runner.ts#L49)

Create an AgentRunner that calls Ollama, OpenAI, or Anthropic APIs.
Use when running standalone without OpenClaw. Single model for all agent nodes.

#### Parameters

##### config

[`LlmAgentRunnerConfig`](#llmagentrunnerconfig)

#### Returns

`AgentRunner`

***

### createOpenClawAgentRunner()

> **createOpenClawAgentRunner**(`api`): `AgentRunner`

Defined in: [openclaw-agent-runner.ts:39](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/openclaw-agent-runner.ts#L39)

Create an AgentRunner that delegates to OpenClaw via `openclaw agent --json`.
Uses the plugin API's runCommandWithTimeout so pipelines use the configured models, tools, and sandbox.

#### Parameters

##### api

[`OpenClawPluginApi`](#openclawpluginapi)

#### Returns

`AgentRunner`

***

### loadLlmAgentConfigFromFile()

> **loadLlmAgentConfigFromFile**(`cwd`): [`LlmAgentRunnerConfig`](#llmagentrunnerconfig) \| `null`

Defined in: [agent-runner-config.ts:92](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/agent-runner-config.ts#L92)

Load LLM agent config from .ripline/agent.json or ripline.config.json (agent section).
Returns null if file missing or invalid.

#### Parameters

##### cwd

`string`

#### Returns

[`LlmAgentRunnerConfig`](#llmagentrunnerconfig) \| `null`

***

### normalizeClaudeCodeConfigFromPlugin()

> **normalizeClaudeCodeConfigFromPlugin**(`raw`): [`ClaudeCodeRunnerConfig`](#claudecoderunnerconfig) \| `null`

Defined in: [agent-runner-config.ts:166](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/agent-runner-config.ts#L166)

Extract Claude Code runner config from plugin config (claudeCode key).

#### Parameters

##### raw

`unknown`

#### Returns

[`ClaudeCodeRunnerConfig`](#claudecoderunnerconfig) \| `null`

***

### normalizeConfig()

> **normalizeConfig**(`raw`): [`NormalizedConfig`](#normalizedconfig)

Defined in: [index.ts:58](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/index.ts#L58)

#### Parameters

##### raw

`unknown`

#### Returns

[`NormalizedConfig`](#normalizedconfig)

***

### normalizeLlmAgentConfigFromPlugin()

> **normalizeLlmAgentConfigFromPlugin**(`raw`, `env?`): [`LlmAgentRunnerConfig`](#llmagentrunnerconfig) \| `null`

Defined in: [agent-runner-config.ts:34](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/agent-runner-config.ts#L34)

Extract and validate LLM agent config from plugin config (agentRunner or agent key).
Fills apiKey from OPENAI_API_KEY / ANTHROPIC_API_KEY when not set.

#### Parameters

##### raw

`unknown`

##### env?

`Record`\<`string`, `string`\>

#### Returns

[`LlmAgentRunnerConfig`](#llmagentrunnerconfig) \| `null`

***

### resolveClaudeCodeConfig()

> **resolveClaudeCodeConfig**(`options?`): [`ClaudeCodeRunnerConfig`](#claudecoderunnerconfig) \| `null`

Defined in: [agent-runner-config.ts:249](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/agent-runner-config.ts#L249)

Resolve Claude Code config: env + config file + user config (bypass flag only from env or ~/.ripline/config.json).

#### Parameters

##### options?

###### cwd?

`string`

###### env?

`Record`\<`string`, `string`\>

###### homedir?

`string`

#### Returns

[`ClaudeCodeRunnerConfig`](#claudecoderunnerconfig) \| `null`

***

### resolveLlmAgentConfigFromEnv()

> **resolveLlmAgentConfigFromEnv**(`env?`): [`LlmAgentRunnerConfig`](#llmagentrunnerconfig) \| `null`

Defined in: [agent-runner-config.ts:66](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/agent-runner-config.ts#L66)

Resolve LLM agent config from environment variables.
Requires RIPLINE_AGENT_PROVIDER and RIPLINE_AGENT_MODEL.

#### Parameters

##### env?

`Record`\<`string`, `string`\>

#### Returns

[`LlmAgentRunnerConfig`](#llmagentrunnerconfig) \| `null`

***

### resolveStandaloneLlmAgentConfig()

> **resolveStandaloneLlmAgentConfig**(`options?`): [`LlmAgentRunnerConfig`](#llmagentrunnerconfig) \| `null`

Defined in: [agent-runner-config.ts:124](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/agent-runner-config.ts#L124)

Resolve standalone LLM agent config: overrides (e.g. CLI) > env > config file.
Used by CLI when no OpenClaw runner is provided.

#### Parameters

##### options?

###### cwd?

`string`

###### env?

`Record`\<`string`, `string`\>

###### overrides?

`Partial`\<[`LlmAgentRunnerConfig`](#llmagentrunnerconfig)\>

#### Returns

[`LlmAgentRunnerConfig`](#llmagentrunnerconfig) \| `null`
