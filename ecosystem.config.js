module.exports = {
  apps: [
    {
      name: "ripline-prod",
      script: "dist/cli/run.js",
      args: "serve --pipelines-dir /home/openclaw/.ripline/pipelines --runs-dir /home/openclaw/ripline/.ripline/runs --max-concurrency 1 --queue spec:3 --queue build:1",
      cwd: "/home/openclaw/ripline",
      watch: false,
      env: {
        STAGE: "production",
        NODE_ENV: "production",
      },
    },
    {
      name: "ripline-staging",
      script: "dist/cli/run.js",
      args: "serve --pipelines-dir /home/openclaw/.ripline/pipelines --runs-dir /home/openclaw/ripline/.ripline/runs-staging --max-concurrency 1 --queue spec:3 --queue build:1",
      cwd: "/home/openclaw/ripline",
      watch: true,
      watch_delay: 1000,
      ignore_watch: ["node_modules", ".ripline", "*.log"],
      env: {
        STAGE: "staging",
        NODE_ENV: "development",
        BACKGROUND_QUEUE_DISABLED: "1",
      },
    },
  ],
};
