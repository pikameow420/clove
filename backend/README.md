# Character Chat Backend (MVP)

Fastify + Prisma backend for a swipe-to-chat character app with local Ollama LLM integration.

## Supabase Database Notes

- Supabase works directly because it is PostgreSQL.
- Set `DATABASE_URL` to your Supabase connection string in `.env`.
- Use the direct Supabase URL without `sslmode` query params (`prisma.ts` configures SSL for pg v8+).
- Run migrations against Supabase:
  - `npm run prisma:deploy`

## Quick Start

1. Copy env file:
   - `cp .env.example .env`
2. Update `DATABASE_URL`, `SUPABASE_URL`, and `ADMIN_API_KEY` in `.env`.
3. Install dependencies:
   - `npm install`
4. Generate Prisma client:
   - `npm run prisma:generate`
5. Run migrations:
   - `npm run prisma:deploy`
6. Start dev server:
   - `npm run dev`

## CLI Model Test Mode

Use this when you want to quickly test character behavior with Ollama before wiring frontend/app flows.

1. Ensure `.env` has working values for:
   - `DATABASE_URL` (Supabase Postgres)
   - `OLLAMA_BASE_URL`
   - `OLLAMA_MODEL`
2. Ensure characters exist in DB (import at least one active character).
3. Run:
   - `npm run cli:chat`
4. Pick a character number and chat in terminal.
5. Commands:
   - `/reset` clears current CLI conversation history
   - `/exit` exits CLI mode

## Auth Model

- User routes require `Authorization: Bearer <supabase_access_token>`.
- Backend verifies the JWT against Supabase JWKS (`SUPABASE_URL/auth/v1/.well-known/jwks.json`).
- Token `sub` is upserted into Prisma `User.externalId`.
- Exempt routes: `/health`, `/characters/admin/import` (uses `x-admin-key` instead).

## Endpoints

- `GET /health`
- `GET /characters?limit=20&cursor=<id>&excludeSwiped=true`
- `POST /characters/admin/import` (requires `x-admin-key`)
- `POST /swipes`
- `GET /matches`
- `GET /conversations`
- `POST /conversations/by-character`
- `GET /conversations/:id/messages?limit=50&cursor=<id>`
- `POST /conversations/:id/messages?stream=true`

## Chat Streaming

- Streaming endpoint uses Server-Sent Events.
- Events emitted:
  - `token`
  - `done`
  - `error`

## Ollama

- Configure:
  - `OLLAMA_BASE_URL`
  - `OLLAMA_MODEL`
- Frontend should never call Ollama directly; always go through backend.

## Frontend Integration Guide (React AI Agent UI)

### 1) Configure frontend env

- Add API base URL in your frontend env (example):
  - `VITE_API_BASE_URL=http://localhost:3001`

### 2) Send Supabase access token on every request

- Backend expects `Authorization: Bearer <access_token>` on all user routes.
- Read `session.access_token` from Supabase Auth in the Expo app.

```ts
const api = (path: string, accessToken: string, init: RequestInit = {}) =>
  fetch(`${import.meta.env.VITE_API_BASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      ...(init.headers ?? {})
    }
  });
```

### 3) Wire swipe flow

- Card feed: `GET /characters`
- Swipe action: `POST /swipes` with `{ characterId, decision }`
- Chat list source: `GET /conversations` (or `GET /matches` for simple liked list)

### 4) Open chat thread for selected character

- Call `POST /conversations/by-character` with `{ characterId }`
- Store returned `conversation.id`
- Load history with `GET /conversations/:id/messages`

### 5) Send chat messages (non-stream)

- `POST /conversations/:id/messages?stream=false` with `{ content }`
- Response returns both saved `userMessage` and `assistantMessage`

### 6) Stream assistant tokens (recommended for agent UX)

- `POST /conversations/:id/messages?stream=true`
- Parse Server-Sent Events (`token`, `done`, `error`) and append `token` chunks to the live message.

### 7) Suggested frontend state model

- `charactersFeed[]`
- `matches[]` / `chatList[]`
- `activeConversationId`
- `messagesByConversation[conversationId]`
- `isGenerating`, `streamBuffer`, `generationError`

## Windows + WSL Setup (Ollama local model)

This setup runs Ollama inside WSL and connects your backend to it.

### Prerequisites

- Windows 11 (or Windows 10 with WSL2 support)
- WSL Ubuntu installed
- Node.js 20+ (where backend will run)
- PostgreSQL available (local install, Docker, or remote DB)

### Step 1: Install/prepare WSL Ubuntu

In PowerShell (Admin):

```powershell
wsl --install -d Ubuntu
```

Then reboot if prompted and open Ubuntu.

### Step 2: Install Node inside WSL (recommended)

In Ubuntu:

```bash
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
source ~/.bashrc
nvm install 20
nvm use 20
node -v
npm -v
```

### Step 3: Install and start Ollama in WSL

In Ubuntu:

```bash
curl -fsSL https://ollama.com/install.sh | sh
ollama serve
```

In a second Ubuntu terminal:

```bash
ollama pull mistral:7b-instruct
ollama run mistral:7b-instruct "Hello"
```

### Step 4: Configure backend env

In `backend/.env`:

- `OLLAMA_MODEL="mistral:7b-instruct"`
- If backend also runs in WSL: `OLLAMA_BASE_URL="http://127.0.0.1:11434"`
- If backend runs on Windows host: start Ollama with:
  - `OLLAMA_HOST=0.0.0.0:11434 ollama serve`
  - set `OLLAMA_BASE_URL="http://<wsl-ip>:11434"` in backend `.env`
  - get WSL IP: `hostname -I`

### Step 5: Configure database and run backend

From `backend` directory:

```bash
cp .env.example .env
# edit .env values (DATABASE_URL, ADMIN_API_KEY, OLLAMA_BASE_URL, OLLAMA_MODEL, HOST, CORS_ORIGIN)
npm install
npm run prisma:generate
npm run prisma:deploy
npm run dev
```

Use these values if this laptop is your shared backend host:

- `HOST="0.0.0.0"` (bind to all interfaces, not localhost-only)
- `PORT="3001"`
- `CORS_ORIGIN="http://<frontend-machine-ip>:<frontend-port>"` (or `*` during testing)

### Step 6: Seed/import characters

Use admin import endpoint (from frontend admin page, Postman, or curl):

```bash
curl -X POST "http://<backend-laptop-ip>:3001/characters/admin/import" \
  -H "Content-Type: application/json" \
  -H "x-admin-key: change-me" \
  -d '{
    "characters":[
      {
        "name":"Marcia",
        "imageUrl":"https://example.com/marcia.png",
        "about":"Night-shift writer who lives on coffee and vinyl.",
        "gender":"female",
        "interests":["music","writing","late-night diners"],
        "personaSystemPrompt":"Voice: witty, a little guarded, warms up slowly. You have your own life — do not make every message about the user. Occasionally mention what you are doing today, a small win, or something bothering you. Let intimacy build over many chats.",
        "personaFacts":[
          "VOICE: lowercase texts, no asterisks, usually 1-3 lines",
          "JOB: barista by day, writes fiction at 2am",
          "ARC NOW: trying to finish a short story for a contest — deadline in 10 days",
          "DRAMA: fighting with roommate over rent",
          "GOAL: wants her own place by summer",
          "WITH USER: flirty only after user flirts first; remember details they share"
        ]
      }
    ]
  }'
```

### Step 7: Connect frontend

- Set frontend API URL to `http://<backend-laptop-ip>:3001`
- Send Supabase `session.access_token` as Bearer token on each API request
- Implement swipe list, matches/chat list, and conversation chat flow using endpoints above

### Step 8: Make backend reachable from other machines

On the backend laptop:

1. Find LAN IP:
   - Windows PowerShell: `ipconfig`
   - Use IPv4 like `192.168.1.25`
2. Allow inbound backend port in Windows Firewall:
   - `3001/tcp` for backend API
3. Keep Ollama private to backend host (recommended):
   - Backend calls Ollama internally via `OLLAMA_BASE_URL`
   - Frontend never talks to Ollama directly
4. Test from another machine:
   - `curl http://<backend-laptop-ip>:3001/health`
5. Update frontend env:
   - `VITE_API_BASE_URL=http://<backend-laptop-ip>:3001`

## Troubleshooting (Windows + WSL)

- `ECONNREFUSED` to Ollama:
  - Check `ollama serve` is running in WSL
  - Verify `OLLAMA_BASE_URL`
  - If cross-boundary (Windows -> WSL), use `OLLAMA_HOST=0.0.0.0:11434`
- Backend reachable locally but not from other machine:
  - Verify backend binds to `HOST=0.0.0.0`
  - Open Windows Firewall for port `3001`
  - Confirm client and server are on same LAN/VPN
- Slow responses:
  - Start with smaller quantized model
  - Increase `LLM_TIMEOUT_MS`
- No chat replies but endpoints work:
  - Test Ollama directly with `ollama run mistral:7b-instruct "test"`
  - Check backend logs for Ollama errors

## Security Notes

- Prisma tables in `public` (`"User"`, `"Character"`, etc.) are not protected by Supabase RLS.
- The mobile app must only reach product data through `clove_backend`, never via Supabase client queries.
- Before a broad public launch, harden DB access (private schema and/or RLS policies on Prisma tables).
