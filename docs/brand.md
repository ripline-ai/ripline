# Ripline Brand Kit (v0.1)

## 1. Idea + Story
- **Name:** **Ripline** — a nod to the section of surf where the pipeline wave crests. Ripline is where momentum becomes a usable line; the same idea applies to graph-based automation where inputs crest into outcomes.
- **Tagline:** “Flow orchestration for agents that live in the water column.”
- **Personality:** Calm confidence with a field-ops edge. Built for people who need to see what’s running and jump in without breaking the wave.
- **Promise:** Turn loosely coupled tools, prompts, and scripts into a visual current you can reroute mid-run.

## 2. Voice & Messaging
| Axis | Guidance |
| --- | --- |
| Tone | Conversational, marine-industrial. Swap corporate jargon for tactile verbs: splice, splice, reroute, crest. |
| Point of view | Speak as the operator (“you reroute a stalled run”), not as marketing copy. |
| Cadence | Short, declarative sentences. Lead with outcomes, then mention the mechanics. |
| Vocabulary anchors | current, swell, reef map, run log, trace, splice, relaunch, drop-in |

### Example microcopy
- Empty state: “No runs in the water. Drop a pipeline and light it up.”
- Success toast: “Pipeline relaunched. Watch the swell on /runs.”
- Error: “Node `summarize_articles` wiped out on a bad payload. Patch the inputs or reroute.”

## 3. Visual System
### Palette
| Token | Hex | Usage |
| --- | --- | --- |
| **Abyss** | `#031326` | Base background, hero panels, CLI shots |
| **Rip Current** | `#0B5AA3` | Primary brand accent, CTAs, highlights |
| **Seafoam** | `#2DD2C8` | Secondary accent, success states, selection lines |
| **Marshlight** | `#F9D977` | Signal tints, warnings, pointer glows |
| **Tide Mist** | `#B8CAD6` | Body text on dark, divider lines |

### Typography
- **Display / Wordmark:** Space Grotesk (Variable). Track tighter for uppercase logotype.
- **Body copy:** Inter (400/500). Maintain 1.5 line-height for doc legibility.
- **Numeric / code:** JetBrains Mono for pipeline graphs, node IDs, and CLI captures.

### Iconography
- Wordmark features a double-wave ligature inside the “R”.
- Secondary mark: rotated rectangle with two stacked wave strokes → works as favicon, lane badge, or compact product chip.
- Illustrations should feel like sonar readouts: thick strokes, minimal gradients, rely on noise or halftone textures over drop shadows.

### Motion cues
- Hover/focus: 120ms ease-out vertical drift (2–4px) to mimic buoyant motion.
- Loading: looping 8-frame wave traveling left-to-right on a line system.

## 4. Usage Notes
- Screenshots/documentation should stage Ripline on a dark canvas with teal overlays — avoid white backgrounds unless comparing to other tools.
- Headlines prefer verbs: “Trace every run.” “Splice in live agents.”
- When showing code, color blocks with Abyss background + Seafoam line numbers for continuity.

## 5. Assets & References
- **Docs:** `docs/pipeline-readme.md` (README drop-in)
- **Palette tokens:** Publish as `--ripline-*` design tokens when the shared design system is ready
- **Kanban card:** `task-pipeline-brand` updated with this spec

## 6. Next Iterations
1. Produce SVG wordmark + badge (Space Grotesk, double-wave ligature)
2. Generate 3 hero treatments (CLI shot, node graph, mission-control embed)
3. Add typography + palette tokens to design system Figma/Workbench
