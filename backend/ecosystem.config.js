module.exports = {
  apps: [
    {
      name: "clove-api",
      cwd: __dirname,
      script: "node",
      args: "dist/server.js",
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      time: true
    },
    {
      name: "clove-proactive",
      cwd: __dirname,
      script: "node",
      args: "dist/worker/proactive-worker.js",
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      time: true
    },
    {
      name: "clove-images",
      cwd: __dirname,
      script: "node",
      args: "dist/worker/image-worker.js",
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      time: true
    }
  ]
};