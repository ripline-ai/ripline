# Central pipelines and profiles

Ripline uses a **central pipeline directory** and optional **profiles** so you can run the same pipeline against different projects or contexts without repeating input flags.

## Pipeline directory

Pipelines are resolved from a configurable directory. A file named `spec-design-implement.yaml` is addressable by the pipeline ID `spec-design-implement` (filename without extension).

### Default location

```
~/.ripline/pipelines/
```

### Resolution order

When you run `ripline run <pipelineId>` (or `ripline pipelines list`), the pipeline directory is chosen in this order:

1. **`--pipeline-dir`** (CLI flag for this run)
2. **`pipelineDir`** in `~/.ripline/config.json` (user config)
3. **`pipelineDir`** in `ripline.config.json` in the current working directory (local override; opt-in for teams)
4. **Default:** `~/.ripline/pipelines/`

So you can override per run, set a global override in user config, or commit a `ripline.config.json` in a repo to point at a local `./pipelines` (or similar) for that project.

### Local override (teams)

To keep pipelines next to the code they operate on, add a `ripline.config.json` in the project root:

```json
{
  "pipelineDir": "./pipelines"
}
```

Ripline does **not** auto-detect a pipeline directory from the repo; this is an explicit opt-in.

### Listing pipelines

```bash
ripline pipelines list
```

Optionally pass `--pipeline-dir <path>`. Output shows ID (filename stem), name, and entry node(s).

---

## Profiles

A **profile** is a named set of default inputs. When you pass `--profile <name>` (or set a default in user config), those inputs are merged with any `--input` you provide. **Explicit `--input` values always override profile values** for the same keys.

### Default profile directory

```
~/.ripline/profiles/
```

### Profile resolution

The profile directory is chosen in this order:

1. **`--profile-dir`** (CLI flag)
2. **`profileDir`** in `~/.ripline/config.json`
3. **Default:** `~/.ripline/profiles/`

### Profile file format

Profiles are YAML files. The filename (without extension) must match the `name` field.

```yaml
# ~/.ripline/profiles/myapp.yaml
name: myapp
description: "My Rails application"   # optional
inputs:
  projectRoot: /code/myapp
  memoryPath: /code/myapp/.context/memory.md
  ideasPath: /code/myapp/.context/ideas/
```

- **`name`** — must match the filename (without extension).
- **`description`** — optional; shown in `ripline profiles list`.
- **`inputs`** — arbitrary key/value pairs merged into pipeline input at run time.

Ripline does **not** validate that a profile’s keys match a pipeline’s expected inputs; that is left to the pipeline’s node contracts and prompts. Profiles are generic and reusable across pipelines.

### Input merge order (lowest to highest precedence)

1. Profile inputs
2. `--input` (or `--inputs`) values

So `--input '{"projectRoot": "/override"}'` always wins over the profile’s `projectRoot`.

### Profile commands

```bash
ripline profiles list              # list all profiles
ripline profiles show myapp        # show a profile’s inputs
ripline profiles create myapp     # create template and open $EDITOR (or use --no-edit)
ripline profiles validate myapp   # check profile is valid
```

---

## User config

Optional file: **`~/.ripline/config.json`**

```json
{
  "pipelineDir": "~/.ripline/pipelines",
  "profileDir": "~/.ripline/profiles",
  "defaultProfile": null
}
```

- **`pipelineDir`** — override default pipeline directory (supports `~`).
- **`profileDir`** — override default profile directory (supports `~`).
- **`defaultProfile`** — if set, this profile is applied to every run unless you pass `--profile <other>` or `--no-profile`.

Use **`--no-profile`** on a single run to disable the default profile for that run.

---

## Worked example: one pipeline, two projects

1. **Pipeline** (in `~/.ripline/pipelines/spec-then-implement.yaml`) uses inputs like `projectRoot` and `memoryPath` in prompts or node `cwd`.

2. **Profile for project A** (`~/.ripline/profiles/project-a.yaml`):

   ```yaml
   name: project-a
   description: "Frontend app"
   inputs:
     projectRoot: /code/frontend
     memoryPath: /code/frontend/.context/memory.md
   ```

3. **Profile for project B** (`~/.ripline/profiles/project-b.yaml`):

   ```yaml
   name: project-b
   description: "Backend API"
   inputs:
     projectRoot: /code/backend
     memoryPath: /code/backend/.context/memory.md
   ```

4. **Run the same pipeline against each:**

   ```bash
   ripline run spec-then-implement --profile project-a --input '{"task": "add login"}'
   ripline run spec-then-implement --profile project-b --input '{"task": "add login"}'
   ```

Each run gets the correct `projectRoot` and `memoryPath` from the profile, and `task` from the explicit `--input`.
