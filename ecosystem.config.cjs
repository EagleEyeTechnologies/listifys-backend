/**
 * PM2 process file for AWS EC2 / any Linux host.
 * Usage: NODE_ENV=production pm2 start ecosystem.config.cjs
 */
module.exports = {
  apps: [
    {
      name: "listifys-api",
      script: "dist/index.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
      },
      max_memory_restart: "512M",
      time: true,
      kill_timeout: 10_000,
      listen_timeout: 15_000,
    },
  ],
};
