// Teste de Diagnóstico Forense sem simulação simplista
const fs = require('fs');
const path = require('path');

async function forensicAudit() {
  console.log('====================================================');
  console.log('  AUDITORIA FORENSE DE CONTRATO DE DADOS & HANDOFF  ');
  console.log('====================================================');

  // 1. Inspeciona youtube.js
  const youtubeCode = fs.readFileSync(path.resolve('./content/youtube.js'), 'utf8');
  
  // Extrai objeto enviado em NOW_PLAYING_DETECTED
  const payloadRegex = /chrome\.runtime\.sendMessage\(\{\s*type:\s*'NOW_PLAYING_DETECTED',\s*payload:\s*\{([^}]+)\}/s;
  const matchPayload = youtubeCode.match(payloadRegex);
  console.log('\n[FATO 1] Objeto enviado pelo content script (youtube.js):');
  console.log(matchPayload ? matchPayload[1].trim() : 'NÃO ENCONTRADO');

  // 2. Inspeciona background/service-worker.js
  const swCode = fs.readFileSync(path.resolve('./background/service-worker.js'), 'utf8');
  
  console.log('\n[FATO 2] Propriedades lidas em background/service-worker.js:');
  const checkedProperties = [
    'track.title',
    'track.artist',
    'track.normalizedTitle',
    'track.normalizedArtist',
    'track.rawTitle',
    'track.rawArtist'
  ];
  for (const prop of checkedProperties) {
    const count = (swCode.match(new RegExp(prop.replace('.', '\\.'), 'g')) || []).length;
    console.log(`  - ${prop}: ${count} ocorrência(s)`);
  }

  // 3. Avaliação da condição do Modo Automático
  console.log('\n[FATO 3] Avaliação da condição do Modo Automático com o payload atual:');
  const currentSentPayload = {
    rawTitle: 'POWER',
    rawArtist: 'Kanye West',
    album: 'My Beautiful Dark Twisted Fantasy',
    artworkUrl: null,
    normalizedTitle: 'POWER',
    normalizedArtist: 'Kanye West',
    metadataSource: 'media-session',
    source: 'youtube'
  };

  const autoModeEnabled = true;
  const lastSyncedTrackTitle = 'Musica Anterior';
  const isExecutingHandoff = false;

  const track = currentSentPayload;
  const isDifferentTrack = track.title && (track.title !== lastSyncedTrackTitle);
  const conditionEvaluated = autoModeEnabled && isDifferentTrack && !isExecutingHandoff;

  console.log('  Payload enviado:', currentSentPayload);
  console.log('  track.title é:', track.title);
  console.log('  isDifferentTrack avaliado para:', isDifferentTrack);
  console.log('  A condição do Modo Automático executa?', conditionEvaluated ? 'SIM' : 'NÃO (BLOQUEADO)');

  // 4. Se passar pelo if, como se comporta executeHandoff?
  console.log('\n[FATO 4] Comportamento dentro de executeHandoff(autoPause, tabId, trackData):');
  const handoffTrackCheck = !track || !track.title;
  console.log('  (!track || !track.title) avalia para:', handoffTrackCheck);
  console.log('  executeHandoff aborta com:', handoffTrackCheck ? 'Nenhuma música detectada no YouTube.' : 'Prossegue');

  // 5. Inspeciona comportamento ao dar F5 / Reload
  console.log('\n[FATO 5] Comportamento no F5 / Recarregar da página:');
  console.log('  Quando a página recarrega, se a música for a mesma de antes:');
  console.log('  lastSyncedTrackTitle no storage persistiu o título anterior.');
  console.log('  (track.title !== lastSyncedTrackTitle) será FALSE se for a mesma faixa!');
  console.log('  Portanto, ao dar F5 para ouvir a música no grupo de caixas, o Modo Automático NÃO DISPARA!');
}

forensicAudit().catch(console.error);
