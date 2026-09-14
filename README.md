# Sync Music — Handoff do YouTube para Spotify Connect / Alexa

Extensão para Google Chrome (Manifest V3). Detecta a música tocando no **YouTube** ou **YouTube Music** e toca a mesma faixa num dispositivo **Spotify Connect** — por exemplo o grupo de Alexas **Tudo**, uma Echo ou uma Fire TV.

---

## Funções

- **Handoff manual:** botão ♫ no player do YouTube ou botão principal do popup.
- **Modo automático** (chave ⚡ no popup):
  - troca de música (playlist, outro vídeo, navegação interna do YouTube) e F5 enviam a faixa ao Spotify;
  - ligar o modo com música tocando envia a faixa atual;
  - trocas rápidas: só a última faixa toca (fila *latest-wins*);
  - anúncios do YouTube são ignorados; a música vai quando o anúncio termina;
  - páginas sem vídeo (home, busca) não disparam nada;
  - título trocado pela tradução do YouTube (ex.: "Shape of You" → "A Sua Forma") não conta como música nova; vale o primeiro título visto no vídeo;
  - falha transitória (dispositivo fora do ar, erro 5xx, rede) é re-tentada 2 vezes, após 10 s e 30 s. Match incerto, conta desconectada e recusa do Spotify (403) não são re-tentados;
  - o YouTube só é pausado depois que a faixa e o dispositivo estão prontos. Se o Spotify recusar o play, o som volta para o YouTube.
- **Confirmação real:** depois do play, a extensão consulta `GET /me/player`. O popup mostra o último envio como *tocando* (confirmado), *enviado, sem confirmação* ou *falhou* (com o motivo).
- **Conta Spotify:** card no topo do popup com **Conectar Spotify** (OAuth 2.0 PKCE), nome da conta conectada e Desconectar.
- **Login automático:** depois da primeira autorização, se a sessão cair (token revogado, expirado ou apagado), a extensão entra de novo sozinha, sem abrir janela, enquanto o navegador estiver logado no spotify.com. A tentativa acontece no máximo a cada 2 minutos e fica desligada depois de **Desconectar**.
- **Controles:** play/pause, anterior/próxima, volume (com debounce e cancelamento de chamadas antigas) e escolha do dispositivo. Se o dispositivo escolhido sumir, a extensão usa o grupo **Tudo** sem apagar a sua escolha.
- **Telemetria:** eventos com `correlationId`, painel de debug, copiar e exportar logs.

---

## Instalação

1. Clone o repositório:
   ```bash
   git clone https://github.com/eduardo02138/Reprodo-ao.git
   ```
2. Abra `chrome://extensions`, ative **Modo do desenvolvedor**, clique em **Carregar sem compactação** e escolha a pasta do repositório.
3. Abra o popup. Todo o resto é feito no card **Conta Spotify**, no topo, sem editar código:
   1. Crie um app (grátis) em <https://developer.spotify.com/dashboard>, marque **Web API** e adicione a **Redirect URI** mostrada no card (`https://<id-da-extensão>.chromiumapp.org/spotify`, com botão de copiar).
   2. Cole o **Client ID** do app no campo do card e clique em **Salvar**. Use só o Client ID: o fluxo PKCE não usa o Client Secret, e ele nunca deve ser colado.
   3. Clique em **Conectar Spotify** e autorize. Das próximas vezes o login é automático.

Cada navegador ou pasta carregada gera um ID de extensão diferente, e com ele uma Redirect URI diferente. Cadastre a de cada um. Trocar o Client ID desconecta a conta, porque os tokens pertencem ao app que os emitiu.

Se o popup disser que o login está indisponível (sem `chrome.identity`), o navegador não concedeu a permissão `identity`. Remova a extensão e carregue a pasta de novo.

Requisitos:
- Conta **Spotify Premium** (a Web API só controla reprodução em contas Premium).
- O dispositivo precisa aparecer no Spotify Connect. Se as Alexas não aparecerem, diga "Alexa, tocar Spotify" para acordá-las.

---

## Segurança

- Nenhum token nem Client ID fica no código. Tokens e Client ID ficam só no `chrome.storage.local` do seu navegador.
- Os commits `08ec4cd`, `72bb9fc` e `06d59bc` deste repositório continham tokens reais do Spotify (`shared/default-token.json`). Se esses tokens eram da sua conta, revogue o acesso do app em <https://www.spotify.com/account/apps/>.
- Refresh de token serializado entre popup e service worker (Web Locks). O Spotify rotaciona o refresh token; dois refresh simultâneos derrubariam a sessão.

---

## Publicação

- Cada pessoa usa o próprio app do Spotify, então a extensão funciona para qualquer um sem aprovação do Spotify. Um app em modo de desenvolvimento só aceita as contas cadastradas no painel dele (até 25), por isso um app único compartilhado não serve para uso público.
- Publicada na Chrome Web Store, a extensão tem ID fixo, e a Redirect URI passa a ser a mesma para todos os usuários.

---

## Testes

```bash
npm test
```
Testes unitários do service worker **real** (`background/service-worker.js`) com `chrome.*` e a Web API do Spotify simulados: modo automático, F5, fila *latest-wins*, re-tentativa, confirmação, dispositivo preferido, 401/refresh, refresh concorrente, login PKCE e telemetria. Inclui normalização de títulos e pontuação de match.

```bash
npm install
npm run test:e2e
```
Carrega **esta pasta** como extensão no Chromium, usa o YouTube real e simula a API do Spotify. Nenhuma chamada chega ao Spotify e nada toca nas suas caixas. Precisa do Chromium do Playwright (`npx playwright install chromium`) ou de `CHROMIUM_PATH` apontando para um Chromium / Chrome for Testing; o Google Chrome comum ignora `--load-extension`. Relatório e captura do popup em `tests/e2e/.output/`.

---

## Estrutura

```
manifest.json
background/service-worker.js   Executor único de handoff, fila latest-wins, máquina de estados, login
content/youtube.js             Detecção de faixa (MediaSession + eventos SPA), anúncios, re-tentativa, botão ♫
content/track-normalizer.js    Limpeza de títulos do YouTube
providers/spotify-provider.js  Dispositivos, busca, play, transferência, volume
shared/spotify-client.js       Cliente Web API: refresh serializado, 401, 429/Retry-After
shared/auth.js                 OAuth PKCE (chrome.identity)
shared/spotify-config.js       Escopos e chaves de storage (o Client ID vem do painel)
shared/confidence-engine.js    Pontuação de match YouTube → Spotify
shared/logger.js               Telemetria
popup/                         Interface
tests/unit/                    node --test
tests/e2e/                     Playwright + YouTube real + Spotify simulado
```

---

## Limitações conhecidas

- Alexas levam de 1 a 3 s para começar, e grupos podem demorar a aparecer como ativos. Por isso "sem confirmação" não é tratado como erro nem re-tentado.
- O match depende do título do vídeo. Títulos fora do padrão "Artista - Música" podem ficar abaixo da confiança mínima (50) e não são enviados.
- A detecção de anúncios usa as classes do player do YouTube (`ad-showing`); não foi validada com anúncios do YouTube Music.
- Quando o YouTube já abre o vídeo com o título traduzido, a busca usa essa tradução e pode não achar a faixa original (ou achar outra).
- Fire TV e outras TVs não aceitam volume pela Web API.

---

## Licença

MIT.
