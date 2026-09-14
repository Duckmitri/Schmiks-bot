const express = require('express');
const path = require('path');
const { readLoggingConfig, readPrefix, readRoleIds, readWarningEmbedConfig, writeDashboardConfig } = require('../config');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/assets', express.static(path.join(__dirname, '..', 'assets')));

// API to get config
app.get('/api/config', (req, res) => {
  try {
    res.json({ prefix: readPrefix(), ...readRoleIds(), logging: readLoggingConfig(), warningEmbed: readWarningEmbedConfig() });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Could not read config' });
  }
});

// API to update config
app.post('/api/config', (req, res) => {
  try {
    res.json({ success: true, ...writeDashboardConfig(req.body) });
  } catch (error) {
    if (error instanceof TypeError) return res.status(400).json({ error: error.message });
    console.error(error);
    res.status(500).json({ error: 'Could not write config' });
  }
});

// Serve the main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

if (require.main === module) {
  app.listen(PORT, '127.0.0.1', error => {
    if (error) {
      console.error(error.code === 'EADDRINUSE'
        ? `Dashboard is already running at http://127.0.0.1:${PORT}`
        : `Could not start dashboard: ${error.message}`);
      process.exitCode = 1;
      return;
    }
    console.log(`Dashboard server running at http://127.0.0.1:${PORT}`);
  });
}

module.exports = app;
