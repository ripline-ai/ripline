module.exports = {
  apps: [
    {
      name: "ollama",
      script: "/home/openclaw/.local/bin/ollama",
      args: "serve",
      cwd: "/home/openclaw",
      watch: false,
      env: {
        OLLAMA_HOST: "0.0.0.0:11434",
      },
    },
    {
      name: "ripline-prod",
      script: "dist/cli/run.js",
      args: "serve --pipelines-dir /home/openclaw/.ripline/pipelines --runs-dir /home/openclaw/ripline/.ripline/runs --max-concurrency 1 --queue spec:2 --queue build:1",
      cwd: "/home/openclaw/ripline",
      watch: false,
      env: {
        STAGE: "production",
        NODE_ENV: "production",
      },
    },

  ],
};
