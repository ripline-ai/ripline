[**Ripline API Reference v0.1.0**](index)

***

[Ripline API Reference](index) / types

# types

## Type Aliases

### AgentNode

> **AgentNode** = [`NodeBase`](#nodebase) & `object`

Defined in: [types.ts:63](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L63)

#### Type Declaration

##### agentId?

> `optional` **agentId**: `string`

##### channel?

> `optional` **channel**: `string`

##### cwd?

> `optional` **cwd**: `string`

Working directory for Claude Code (supports template interpolation).

##### dangerouslySkipPermissions?

> `optional` **dangerouslySkipPermissions**: `boolean`

When runner is claude-code and global bypass is allowed: set true to use bypass for this node only. Omit or false = dontAsk for this node. Safer to enable per-node than globally.

##### deliver?

> `optional` **deliver**: `boolean`

##### mode?

> `optional` **mode**: `"plan"` \| `"execute"`

For runner: claude-code — "plan" = read-only; "execute" = full access. Default when runner is claude-code: "execute".

##### prompt

> **prompt**: `string`

##### resetSession?

> `optional` **resetSession**: `boolean`

When true or omitted, use a new session per run (context isolation). When false, use run-level sessionId for continuity.

##### runner?

> `optional` **runner**: `"claude-code"`

Opt-in to Claude Code runner for this node. When set, claudeCodeRunner must be provided in runner options.

##### sessionId?

> `optional` **sessionId**: `string`

##### thinking?

> `optional` **thinking**: `"off"` \| `"minimal"` \| `"low"` \| `"medium"` \| `"high"`

##### timeoutSeconds?

> `optional` **timeoutSeconds**: `number`

##### type

> **type**: `"agent"`

***

### CheckpointNode

> **CheckpointNode** = [`NodeBase`](#nodebase) & `object`

Defined in: [types.ts:108](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L108)

#### Type Declaration

##### reason?

> `optional` **reason**: `string`

##### resumeKey?

> `optional` **resumeKey**: `string`

##### type

> **type**: `"checkpoint"`

***

### EnqueueNode

> **EnqueueNode** = [`NodeBase`](#nodebase) & `object`

Defined in: [types.ts:130](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L130)

#### Type Declaration

##### mode?

> `optional` **mode**: `"batch"` \| `"per-item"`

batch = one child run with inputs.tasks = full list; per-item = one run per task.

##### pipelineId

> **pipelineId**: `string`

Child pipeline to run for each task (or once with full list in batch mode).

##### tasksSource?

> `optional` **tasksSource**: `string`

Artifact key containing tasks array (default "tasks").

##### type

> **type**: `"enqueue"`

***

### InputNode

> **InputNode** = [`NodeBase`](#nodebase) & `object`

Defined in: [types.ts:52](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L52)

#### Type Declaration

##### path?

> `optional` **path**: `string`

##### type

> **type**: `"input"`

***

### LiteralNode

> **LiteralNode** = [`NodeBase`](#nodebase) & `object`

Defined in: [types.ts:47](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L47)

#### Type Declaration

##### type

> **type**: `"data"`

##### value

> **value**: `unknown`

***

### LoopBody

> **LoopBody** = `object`

Defined in: [types.ts:101](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L101)

#### Properties

##### edges?

> `optional` **edges**: [`PipelineEdge`](#pipelineedge)[]

Defined in: [types.ts:105](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L105)

##### entry?

> `optional` **entry**: `string`[]

Defined in: [types.ts:103](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L103)

##### nodes?

> `optional` **nodes**: [`PipelineNode`](#pipelinenode)[]

Defined in: [types.ts:104](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L104)

##### pipelineId?

> `optional` **pipelineId**: `string`

Defined in: [types.ts:102](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L102)

***

### LoopNode

> **LoopNode** = [`NodeBase`](#nodebase) & `object`

Defined in: [types.ts:91](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L91)

#### Type Declaration

##### body

> **body**: [`LoopBody`](#loopbody)

##### collection

> **collection**: `string`

##### exitCondition?

> `optional` **exitCondition**: `string`

##### indexVar?

> `optional` **indexVar**: `string`

##### itemVar?

> `optional` **itemVar**: `string`

##### maxIterations?

> `optional` **maxIterations**: `number`

##### type

> **type**: `"loop"`

***

### NodeBase

> **NodeBase** = `object`

Defined in: [types.ts:37](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L37)

#### Properties

##### contracts?

> `optional` **contracts**: [`NodeContract`](#nodecontract)

Defined in: [types.ts:41](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L41)

##### description?

> `optional` **description**: `string`

Defined in: [types.ts:40](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L40)

##### id

> **id**: `string`

Defined in: [types.ts:38](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L38)

##### metadata?

> `optional` **metadata**: `Record`\<`string`, `unknown`\>

Defined in: [types.ts:42](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L42)

##### name?

> `optional` **name**: `string`

Defined in: [types.ts:39](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L39)

##### retry?

> `optional` **retry**: [`NodeRetryConfig`](#noderetryconfig)

Defined in: [types.ts:44](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L44)

Retry transient failures: max attempts and optional delay between attempts.

***

### NodeContract

> **NodeContract** = `object`

Defined in: [types.ts:27](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L27)

#### Properties

##### input?

> `optional` **input**: `JSONSchema7`

Defined in: [types.ts:28](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L28)

##### output?

> `optional` **output**: `JSONSchema7`

Defined in: [types.ts:29](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L29)

***

### NodeRetryConfig

> **NodeRetryConfig** = `object`

Defined in: [types.ts:32](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L32)

#### Properties

##### delayMs?

> `optional` **delayMs**: `number`

Defined in: [types.ts:34](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L34)

##### maxAttempts

> **maxAttempts**: `number`

Defined in: [types.ts:33](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L33)

***

### OutputNode

> **OutputNode** = [`NodeBase`](#nodebase) & `object`

Defined in: [types.ts:114](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L114)

#### Type Declaration

##### merge?

> `optional` **merge**: `boolean`

##### path?

> `optional` **path**: `string`

##### source?

> `optional` **source**: `string`

Artifact key to write (default: this node's id).

##### type

> **type**: `"output"`

***

### PipelineContracts

> **PipelineContracts** = `object`

Defined in: [types.ts:158](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L158)

#### Properties

##### input?

> `optional` **input**: `JSONSchema7`

Defined in: [types.ts:159](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L159)

##### output?

> `optional` **output**: `JSONSchema7`

Defined in: [types.ts:160](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L160)

***

### PipelineDefinition

> **PipelineDefinition** = `object`

Defined in: [types.ts:163](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L163)

#### Properties

##### contracts?

> `optional` **contracts**: [`PipelineContracts`](#pipelinecontracts)

Defined in: [types.ts:171](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L171)

##### description?

> `optional` **description**: `string`

Defined in: [types.ts:167](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L167)

##### edges

> **edges**: [`PipelineEdge`](#pipelineedge)[]

Defined in: [types.ts:170](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L170)

##### entry

> **entry**: `string`[]

Defined in: [types.ts:168](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L168)

##### id

> **id**: `string`

Defined in: [types.ts:164](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L164)

##### metadata?

> `optional` **metadata**: `Record`\<`string`, `unknown`\>

Defined in: [types.ts:173](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L173)

##### name?

> `optional` **name**: `string`

Defined in: [types.ts:166](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L166)

##### nodes

> **nodes**: [`PipelineNode`](#pipelinenode)[]

Defined in: [types.ts:169](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L169)

##### tags?

> `optional` **tags**: `string`[]

Defined in: [types.ts:172](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L172)

##### version?

> `optional` **version**: `string` \| `number`

Defined in: [types.ts:165](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L165)

***

### PipelineEdge

> **PipelineEdge** = `object`

Defined in: [types.ts:151](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L151)

#### Properties

##### from

> **from**: `object`

Defined in: [types.ts:153](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L153)

###### node

> **node**: `string`

###### port?

> `optional` **port**: `string`

##### id?

> `optional` **id**: `string`

Defined in: [types.ts:152](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L152)

##### to

> **to**: `object`

Defined in: [types.ts:154](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L154)

###### node

> **node**: `string`

###### port?

> `optional` **port**: `string`

##### when?

> `optional` **when**: `string`

Defined in: [types.ts:155](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L155)

***

### PipelineNode

> **PipelineNode** = [`LiteralNode`](#literalnode) \| [`InputNode`](#inputnode) \| [`TransformNode`](#transformnode) \| [`AgentNode`](#agentnode) \| [`RunPipelineNode`](#runpipelinenode) \| [`LoopNode`](#loopnode) \| [`CheckpointNode`](#checkpointnode) \| [`OutputNode`](#outputnode) \| [`EnqueueNode`](#enqueuenode)

Defined in: [types.ts:140](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L140)

***

### PipelinePluginConfig

> **PipelinePluginConfig** = `object`

Defined in: [types.ts:17](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L17)

#### Properties

##### authToken?

> `optional` **authToken**: `string`

Defined in: [types.ts:22](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L22)

##### httpPath?

> `optional` **httpPath**: `string`

Defined in: [types.ts:20](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L20)

##### httpPort?

> `optional` **httpPort**: `number`

Defined in: [types.ts:21](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L21)

##### maxConcurrency?

> `optional` **maxConcurrency**: `number`

Defined in: [types.ts:19](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L19)

##### pipelinesDir

> **pipelinesDir**: `string`

Defined in: [types.ts:18](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L18)

##### runsDir?

> `optional` **runsDir**: `string`

Defined in: [types.ts:24](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L24)

Directory for run state (default .ripline/runs). Used by HTTP server.

***

### PipelineRegistryEntry

> **PipelineRegistryEntry** = `object`

Defined in: [types.ts:176](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L176)

#### Properties

##### definition

> **definition**: [`PipelineDefinition`](#pipelinedefinition)

Defined in: [types.ts:177](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L177)

##### mtimeMs

> **mtimeMs**: `number`

Defined in: [types.ts:178](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L178)

##### path

> **path**: `string`

Defined in: [types.ts:179](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L179)

***

### PipelineRunRecord

> **PipelineRunRecord** = `object`

Defined in: [types.ts:201](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L201)

#### Properties

##### childRunIds

> **childRunIds**: `string`[]

Defined in: [types.ts:209](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L209)

##### cursor?

> `optional` **cursor**: `object`

Defined in: [types.ts:215](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L215)

###### context

> **context**: `Record`\<`string`, `unknown`\>

###### nextNodeIndex

> **nextNodeIndex**: `number`

##### error?

> `optional` **error**: `string`

Defined in: [types.ts:225](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L225)

##### id

> **id**: `string`

Defined in: [types.ts:202](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L202)

##### inputs

> **inputs**: `Record`\<`string`, `unknown`\>

Defined in: [types.ts:213](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L213)

##### outputs?

> `optional` **outputs**: `Record`\<`string`, `unknown`\>

Defined in: [types.ts:214](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L214)

##### parentRunId?

> `optional` **parentRunId**: `string`

Defined in: [types.ts:204](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L204)

##### pipelineId

> **pipelineId**: `string`

Defined in: [types.ts:203](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L203)

##### queueMode?

> `optional` **queueMode**: [`QueueMode`](#queuemode-1)

Defined in: [types.ts:208](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L208)

When this run was created by an enqueue node.

##### startedAt

> **startedAt**: `number`

Defined in: [types.ts:211](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L211)

##### status

> **status**: [`PipelineRunStatus`](#pipelinerunstatus)

Defined in: [types.ts:210](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L210)

##### steps

> **steps**: [`PipelineRunStep`](#pipelinerunstep)[]

Defined in: [types.ts:224](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L224)

##### taskId?

> `optional` **taskId**: `string`

Defined in: [types.ts:206](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L206)

When this run was created by an enqueue node.

##### updatedAt

> **updatedAt**: `number`

Defined in: [types.ts:212](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L212)

##### waitFor?

> `optional` **waitFor**: `object`

Defined in: [types.ts:219](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L219)

###### nodeId

> **nodeId**: `string`

###### reason?

> `optional` **reason**: `string`

###### resumeKey?

> `optional` **resumeKey**: `string`

***

### PipelineRunStatus

> **PipelineRunStatus** = `"pending"` \| `"running"` \| `"paused"` \| `"errored"` \| `"completed"`

Defined in: [types.ts:182](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L182)

***

### PipelineRunStep

> **PipelineRunStep** = `object`

Defined in: [types.ts:189](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L189)

#### Properties

##### data?

> `optional` **data**: `unknown`

Defined in: [types.ts:194](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L194)

##### error?

> `optional` **error**: `string`

Defined in: [types.ts:195](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L195)

##### finishedAt?

> `optional` **finishedAt**: `number`

Defined in: [types.ts:193](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L193)

##### iteration?

> `optional` **iteration**: `number`

Defined in: [types.ts:196](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L196)

##### nodeId

> **nodeId**: `string`

Defined in: [types.ts:190](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L190)

##### startedAt?

> `optional` **startedAt**: `number`

Defined in: [types.ts:192](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L192)

##### status

> **status**: `"pending"` \| `"running"` \| `"completed"` \| `"errored"` \| `"skipped"` \| `"paused"`

Defined in: [types.ts:191](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L191)

***

### QueueMode

> **QueueMode** = `"batch"` \| `"per-item"`

Defined in: [types.ts:199](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L199)

***

### RiplineProfile

> **RiplineProfile** = `object`

Defined in: [types.ts:3](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L3)

#### Properties

##### description?

> `optional` **description**: `string`

Defined in: [types.ts:5](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L5)

##### inputs

> **inputs**: `Record`\<`string`, `unknown`\>

Defined in: [types.ts:6](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L6)

##### name

> **name**: `string`

Defined in: [types.ts:4](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L4)

***

### RiplineUserConfig

> **RiplineUserConfig** = `object`

Defined in: [types.ts:9](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L9)

#### Properties

##### claudeCode?

> `optional` **claudeCode**: `object`

Defined in: [types.ts:14](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L14)

Only from ~/.ripline/config.json; never from pipeline/profile/input.

###### allowDangerouslySkipPermissions?

> `optional` **allowDangerouslySkipPermissions**: `boolean`

##### defaultProfile?

> `optional` **defaultProfile**: `string`

Defined in: [types.ts:12](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L12)

##### pipelineDir?

> `optional` **pipelineDir**: `string`

Defined in: [types.ts:10](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L10)

##### profileDir?

> `optional` **profileDir**: `string`

Defined in: [types.ts:11](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L11)

***

### RunPipelineNode

> **RunPipelineNode** = [`NodeBase`](#nodebase) & `object`

Defined in: [types.ts:84](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L84)

#### Type Declaration

##### inputMapping?

> `optional` **inputMapping**: `Record`\<`string`, `string`\>

##### mode?

> `optional` **mode**: `"child"` \| `"inline"`

##### pipelineId

> **pipelineId**: `string`

##### type

> **type**: `"run_pipeline"`

***

### TaskItem

> **TaskItem** = `object`

Defined in: [types.ts:123](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L123)

Convention for breakdown nodes: emit tasks[] for downstream enqueue node.

#### Properties

##### detail?

> `optional` **detail**: `string`

Defined in: [types.ts:126](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L126)

##### id

> **id**: `string`

Defined in: [types.ts:124](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L124)

##### priority?

> `optional` **priority**: `number` \| `string`

Defined in: [types.ts:127](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L127)

##### title

> **title**: `string`

Defined in: [types.ts:125](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L125)

***

### TransformNode

> **TransformNode** = [`NodeBase`](#nodebase) & `object`

Defined in: [types.ts:57](https://github.com/craigjmidwinter/ripline/blob/4cab027380c6484d486beb7d8f0c73700d5e8f1d/src/types.ts#L57)

#### Type Declaration

##### assigns?

> `optional` **assigns**: `string`

##### expression

> **expression**: `string`

##### type

> **type**: `"transform"`
