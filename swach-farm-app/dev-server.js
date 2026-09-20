/**
 * Lightweight local dev server (alternative to `netlify dev`).
 * Serves the static site from public/ and mounts the same Express app
 * used by the Netlify function at /api/*.
 */

const path = require('path');
const express = require('express');
const { app: apiApp } = require('./netlify/functions/api');

const PORT = process.env.PORT || 8888;

const app = express();

app.use(express.static(path.join(__dirname, 'public')));
app.use(apiApp);

app.listen(PORT, () => {
  console.log(`Swach Farm dev server running at http://localhost:${PORT}`);
});
