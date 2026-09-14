# Sync Music - Multi-Device Audio Stream (Chrome Extension)

Extensão para Google Chrome (Manifest V3) criada para sincronizar e controlar músicas tocando no **YouTube** e **YouTube Music** para reprodução em múltiplos dispositivos de som (4 dispositivos Echo/Alexa em grupo Multi-Room, FireTV/Smart TV e Google Cast).

---

## 📁 Estrutura dos Arquivos Criados

```
sync-music-extension/
├── manifest.json              # Configuração Manifest V3
├── icons/
│   ├── icon-16.png            # Ícone 16x16 px
│   ├── icon-48.png            # Ícone 48x48 px
│   └── icon-128.png           # Ícone 128x128 px
├── background/
│   └── service-worker.js      # Gerenciamento de eventos e chamadas de API
├── content/
│   ├── youtube.js             # Detecção em tempo real de faixas no YouTube / YT Music
│   └── youtube.css            # Botão de atalho integrado no player do YouTube
└── popup/
    ├── popup.html             # Painel no estilo Spotify Connect
    ├── popup.css              # Interface escura moderna
    └── popup.js               # Lógica de seleção e disparo de faixas
```

---

## 🚀 Como Instalar e Testar no Google Chrome

1. Abra o Google Chrome e digite na barra de endereços:
   `chrome://extensions`
2. Ative o seletor **"Modo do desenvolvedor"** (Developer mode) no canto superior direito.
3. Clique no botão **"Carregar sem compactação"** (Load unpacked).
4. Selecione a pasta da extensão:
   `/home/edu/.gemini/antigravity/scratch/sync-music-extension`
5. Abra qualquer vídeo musical no [YouTube](https://www.youtube.com) ou no [YouTube Music](https://music.youtube.com).
6. Clique no ícone da extensão no navegador ou no botão verde injetado no player para sincronizar a reprodução nos seus dispositivos!
