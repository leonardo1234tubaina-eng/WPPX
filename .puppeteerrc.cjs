const { join } = require('path');

/**
 * @type {import("puppeteer").Configuration}
 */
module.exports = {
  // Changes the cache location for Puppeteer to a directory inside the project
  // This ensures Render.com can find it after the build step.
  cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
};
