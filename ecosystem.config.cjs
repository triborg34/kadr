module.exports = {
  apps: [{
    name: 'kadar',
    script: './server.js',
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    max_memory_restart: '100M',
    env: {
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: '8080',
    },
  }],
};
