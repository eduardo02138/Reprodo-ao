// Teste forense para inspecionar inconsistências e bugs no payload
const fs = require('fs');

console.log('=== VERIFICAÇÃO FORENSE: PAYLOAD DE NOW_PLAYING_DETECTED ===');
const youtubeJs = fs.readFileSync('/home/edu/.gemini/antigravity/scratch/sync-music-extension/content/youtube.js', 'utf8');
const swJs = fs.readFileSync('/home/edu/.gemini/antigravity/scratch/sync-music-extension/background/service-worker.js', 'utf8');

// Verificando campos do payload em youtube.js
const payloadMatch = youtubeJs.match(/payload:\s*\{([^}]+)\}/);
console.log('Campos enviados por youtube.js:', payloadMatch ? payloadMatch[1].replace(/\s+/g, ' ') : 'Não encontrado');

// Verificando campos esperados no service-worker.js
const swFieldMatches = swJs.match(/track\.[a-zA-Z0-9_]+/g);
console.log('Campos acessados de track em service-worker.js:', [...new Set(swFieldMatches)]);

