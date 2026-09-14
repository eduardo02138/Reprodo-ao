# Sync Music — Multi-Device Handoff & Auto-Sync (Manifest V3)

Extensão para Google Chrome (Manifest V3) de alta fidelidade arquitetural para sincronização e transferência contínua (*handoff*) de músicas em reprodução no **YouTube** e **YouTube Music** diretamente para caixas de som **Spotify Connect**, grupos **Amazon Alexa** (ex: *Tudo*, *Casa*), Smart TVs e dispositivos de áudio conectados.

---

## 🚀 Funcionalidades Principais

- ⚡ **Modo Automático Resiliente (Auto Mode ON):**
  - Monitoramento de eventos em Single Page Application (SPA) do YouTube (`yt-navigate-finish`, `yt-page-data-updated`, `pushState`, `replaceState`, `loadedmetadata`).
  - **Fila com arquitetura *Single Flight + Latest-Wins*:** Se o usuário avançar várias faixas rapidamente (A → B → C), apenas a faixa final mais recente (C) assume a reprodução no Spotify Connect.
  - **Prevenção de falsos positivos pós-F5:** Atribuição dinâmica de `pageInstanceId` e identificação por assinatura normalizada (`normalizedTitle|normalizedArtist`).
  - **Ordem segura de execução:** Só pausa o áudio do YouTube quando a faixa no Spotify e o dispositivo de destino estiverem prontos para assumir, com fallback para restaurar o som em caso de falha.
- 🎯 **Motor de Correspondência & Confiança (*Confidence Engine*):**
  - Algoritmo ponderado de similaridade fonética e textual entre títulos e artistas do YouTube e catálogo Spotify.
  - Limpeza automática de ruídos comuns de títulos do YouTube (*Clipe Oficial, Official Music Video, 4K, Remastered, Vevo, etc.*).
- 🔊 **Seleção Dinâmica de Dispositivos & Volume Master:**
  - Resolução resiliente de grupos e caixas (ex: grupo *Tudo* da Alexa) sem dependência de IDs voláteis.
  - Proteção contra corridas assíncronas (*race conditions*) em ajustes rápidos de volume usando `AbortController`.
- 🐞 **Painel de Depuração & Telemetria em Tempo Real:**
  - Máquina de estados explícita (`IDLE`, `DETECTED`, `MATCHING`, `DEVICE_RESOLVING`, `READY_TO_TRANSFER`, `PLAY_COMMAND_SENT`, `VERIFYING`, `PLAYING`).
  - Cada ciclo gera um `correlationId` rastreável.
  - Exportação e cópia de logs com rotação automática em memória persistente (`chrome.storage.local`).
- 🔒 **Segurança e Conformidade Manifest V3:**
  - Arquitetura OAuth 2.0 PKCE.
  - Nenhuma chave secreta ou refresh token empacotado no repositório.

---

## 📁 Estrutura do Projeto

```
sync-music-extension/
├── manifest.json              # Manifesto V3 modular (Service Worker + Content Scripts)
├── .gitignore                 # Exclusão de tokens, logs e arquivos de ambiente
├── background/
│   └── service-worker.js      # Orquestrador assíncrono, State Machine e Fila Latest-Wins
├── content/
│   ├── track-normalizer.js    # Normalizador de títulos e remoção de ruídos
│   ├── youtube.js             # Content Script (MediaSession, SPA navigation e HUD)
│   └── youtube.css            # Estilização do botão rápido injetado no player
├── popup/
│   ├── popup.html             # Interface gráfica do usuário
│   ├── popup.css              # Design escuro no padrão Spotify Connect
│   └── popup.js               # Controlador do popup, sliders, switch e painel debug
├── providers/
│   └── spotify-provider.js    # Camada de integração com a Spotify Web API
├── shared/
│   ├── auth.js                # Fluxo OAuth 2.0 PKCE para extensões Chrome
│   ├── confidence-engine.js   # Algoritmo de pontuação e matching de catálogo
│   ├── logger.js              # Sistema de telemetria persistente com Correlation ID
│   └── spotify-client.js      # Cliente HTTP com auto-refresh, retry de 429 e rate-limit
└── tests/
    ├── mock-chrome.js         # Mock isolado das APIs do Chrome para testes em Node.js
    ├── test-unit.js           # Suíte de testes unitários (Sintaxe, Normalizer, Matcher)
    └── test-integration.js    # Suíte de testes de integração (Pipeline, Fila, Storage)
```

---

## ⚙️ Como Instalar no Google Chrome

1. Clone ou baixe este repositório:
   ```bash
   git clone https://github.com/eduardo02138/Reprodo-ao.git
   ```
2. Abra o Google Chrome e navegue até:
   ```
   chrome://extensions
   ```
3. No canto superior direito, ative a chave **"Modo do desenvolvedor"** (*Developer mode*).
4. Clique no botão **"Carregar sem compactação"** (*Load unpacked*).
5. Selecione a pasta raiz da extensão (`sync-music-extension` ou a pasta clonada).
6. A extensão estará pronta e visível na barra de ferramentas do Chrome.

---

## 🧪 Testes Automatizados

O projeto conta com testes unitários e de integração sem resultados falsos ou hardcoded:

```bash
# Executa os testes unitários (sintaxe estrita individual, normalização e pontuação)
node tests/test-unit.js

# Executa os testes de integração (fila latest-wins, decisões do modo automático, persistência)
node tests/test-integration.js
```

Ambos os scripts retornam status de saída real (`process.exitCode = 1` em caso de falha), garantindo validação em pipelines de CI/CD.

---

## 📄 Licença

Este projeto é disponibilizado sob os termos da licença MIT.
