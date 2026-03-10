import { defineConfig } from "vitepress";
import type MarkdownIt from "markdown-it";

export default defineConfig({
  title: "Ripline",
  description:
    "Graph-native pipeline engine for orchestrating multi-agent workflows.",

  // Set base to match the GitHub Pages subdirectory path
  base: "/ripline/",

  // Escape {{ }} in inline code so Vue doesn't treat it as a template expression
  markdown: {
    config: (md: MarkdownIt) => {
      const originalCodeInline = md.renderer.rules["code_inline"];
      md.renderer.rules["code_inline"] = (tokens, idx, options, env, self) => {
        const token = tokens[idx];
        if (token) {
          token.content = token.content
            .replace(/\{\{/g, "&#123;&#123;")
            .replace(/\}\}/g, "&#125;&#125;");
        }
        if (originalCodeInline) {
          return originalCodeInline(tokens, idx, options, env, self);
        }
        return self.renderToken(tokens, idx, options);
      };
    },
  },

  themeConfig: {
    nav: [
      { text: "Get Started", link: "/getting-started" },
      {
        text: "Reference",
        items: [
          { text: "Pipeline DSL", link: "/pipeline-reference" },
          { text: "CLI", link: "/cli-reference" },
          { text: "Configuration", link: "/configuration" },
          { text: "HTTP API", link: "/http-api" },
        ],
      },
      {
        text: "Guides",
        items: [
          { text: "Pipelines & Profiles", link: "/pipelines-and-profiles" },
          { text: "Agent Integration", link: "/agent-integration" },
          { text: "Automation & Cron", link: "/automation-cron" },
          { text: "Migrating from OpenClaw", link: "/migrating-from-openclaw" },
        ],
      },
      { text: "API Reference", link: "/api/" },
    ],

    sidebar: [
      {
        text: "Getting Started",
        items: [{ text: "Introduction", link: "/getting-started" }],
      },
      {
        text: "Reference",
        items: [
          { text: "Pipeline DSL", link: "/pipeline-reference" },
          { text: "CLI", link: "/cli-reference" },
          { text: "Configuration", link: "/configuration" },
          { text: "HTTP API", link: "/http-api" },
        ],
      },
      {
        text: "Guides",
        items: [
          { text: "Pipelines & Profiles", link: "/pipelines-and-profiles" },
          { text: "Agent Integration", link: "/agent-integration" },
          { text: "Automation & Cron", link: "/automation-cron" },
          {
            text: "Migrating from OpenClaw",
            link: "/migrating-from-openclaw",
          },
        ],
      },
      {
        text: "Templates",
        items: [
          { text: "Area-Owner", link: "/templates/ripline-area-owner" },
        ],
      },
      {
        text: "API Reference",
        items: [
          { text: "Overview", link: "/api/" },
          { text: "Functions & exports", link: "/api/index-1" },
          { text: "Type definitions", link: "/api/types" },
        ],
      },
    ],

    socialLinks: [
      {
        icon: "github",
        link: "https://github.com/craigjmidwinter/ripline",
      },
    ],

    search: {
      provider: "local",
    },

    editLink: {
      pattern:
        "https://github.com/craigjmidwinter/ripline/edit/main/docs/:path",
      text: "Edit this page on GitHub",
    },

    footer: {
      message: "Released under the MIT License.",
      copyright: "Copyright © Craig Midwinter",
    },
  },

  // Clean URLs (no .html suffix)
  cleanUrls: true,

  // Ignore dead links in internal dev story docs that aren't published yet
  ignoreDeadLinks: [/\/stories\//],

  // Exclude internal/dev-only docs from the built site
  srcExclude: [
    "SKILL.md",
    "brand.md",
    "pipeline-stories.md",
    "mission-control-feature-pipeline.md",
    "pipelines/mission-control-demo.md",
  ],
});
