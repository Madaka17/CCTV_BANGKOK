// Vercel serverless entrypoint.
// server.js exports a plain (req, res) handler and only calls listen()
// when it is NOT running on Vercel, so the same file works in both places.
module.exports = require('../server.js');
