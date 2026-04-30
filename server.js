const fs = require('fs')
const path = require('path')

const compiledEntry = path.join(__dirname, 'dist', 'server.js')

if (!fs.existsSync(compiledEntry)) {
  console.error('[startup] Missing dist/server.js')
  console.error('[startup] Run: npm run build')
  process.exit(1)
}

require(compiledEntry)
