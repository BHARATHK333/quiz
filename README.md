
# 🎯 QuizMaster Live

A lightweight, self‑hosted, Kahoot‑style quiz app that can handle ~150 players per game on a modest Node.js instance.

## Features

- Host creates a game PIN and builds a quiz in the browser (4 options / question)
- Players join via link + PIN and enter a display name
- Timed questions with speed-based scoring
- Reveal correct answer after each question
- Live leaderboard (top 10) and final standings
- Clean, fun UI with confetti 🎉
- No database; everything runs in memory for simplicity

---

## Quick start (Localhost)

1. **Install Node.js 18+**  
   Check with:
   ```bash
   node -v
   ```

2. **Unzip and install dependencies**
   ```bash
   cd quizmaster-live
   npm install
   npm run dev
   ```

3. **Open the host page**  
   - Host: http://localhost:3000/host.html  
   - Players: http://localhost:3000/

4. **Flow**
   - Click **Create New Game** → share the **PIN** (and `http://localhost:3000/`).
   - Build your quiz (add questions or import/export JSON).
   - When everyone has joined, click **Start Quiz**.
   - After each reveal, click **Next** until the game ends.

> Tip: To let others on your **Wi‑Fi/LAN** join, share your local IP instead of `localhost`, e.g. `http://192.168.1.5:3000/` + the PIN.

---

## Deploying for a large group (public internet)

The app is a single Node.js process serving static files + Socket.IO. Free or low‑cost hosting options work well for ~150 concurrent players.

### Option A: Render (simple)

1. Create a new **Web Service** on Render.
2. Connect a repo or use “Public Git” and upload this folder (or push to your own GitHub).
3. Set **Build Command**: `npm install`  
   **Start Command**: `node server.js`
4. (Optional) Set **Environment**: `NODE_VERSION=18`
5. Deploy → you’ll get a public URL like `https://your-app.onrender.com`.  
   - Host page: `/host.html`  
   - Player page: `/`
6. Share that domain + the **PIN**.

### Option B: Railway / Fly.io / Heroku (similar)

- Create a Node.js app, set Start Command to `node server.js`, and expose port `3000`.
- Make sure **WebSockets** are enabled (Socket.IO uses websockets w/ fallback to polling).
- After deploy, use `https://yourdomain/host.html` for host, and `https://yourdomain/` for players.

### Option C: Docker (any VPS/cloud)

1. Create a simple `Dockerfile`:
   ```Dockerfile
   FROM node:18-alpine
   WORKDIR /app
   COPY package*.json ./
   RUN npm ci --only=production
   COPY . .
   EXPOSE 3000
   CMD ["node","server.js"]
   ```
2. Build & run:
   ```bash
   docker build -t quizmaster-live .
   docker run -p 3000:3000 --name quiz quizmaster-live
   ```
3. Point your domain (via reverse proxy) to the server’s port 3000.

> Scaling: For >150 players, a small VM (e.g., 1–2 vCPU, 1–2 GB RAM) is usually enough. If you horizontally scale multiple instances behind a load balancer, enable **sticky sessions** (session affinity) so that a given room stays on the same instance.

---

## Authoring quizzes

- Use the **Build Quiz** section on the host page:
  - Add questions, edit 4 options, mark the correct one, and choose a per‑question timer.
  - Click **Export JSON** to save, or **Import JSON** to reuse.
- **JSON format** (array of questions):
  ```json
  [
    {
      "prompt": "Capital of France?",
      "options": ["Paris","Rome","Berlin","Madrid"],
      "correctIndex": 0,
      "timeLimitSec": 15
    }
  ]
  ```

---

## Notes & recommendations

- This app does not persist data; restart clears games.
- Names are made unique with a suffix if duplicates join.
- Scoring: correct = `500 + speed bonus` where speed bonus scales with remaining time.
- For very large events, minimize other heavy tabs on the host machine and prefer a wired connection.
- If using a reverse proxy or CDN, ensure **WebSocket** upgrade headers are forwarded.

Enjoy!


---

## 🔐 Securing the host dashboard

By default, only the *host* should be able to control the quiz. This build enforces a shared secret:

- Set an environment variable on the server: `HOST_KEY=some-strong-secret`  
- The **host** will be prompted for this key when opening `/host.html`.
- All `host:*` Socket.IO events are rejected unless the connecting socket provided the correct `HOST_KEY` during handshake.

### How to set it

**Local (temporary):**
```bash
HOST_KEY="ChangeMe123" npm run dev
# open http://localhost:3000/host.html and enter ChangeMe123 when prompted
```

**Render / Railway / Heroku:**
- Add `HOST_KEY` in the service's Environment Variables settings.
- Open `https://your-app/host.html` and enter the same key when prompted.

> Also note: the player page no longer shows any link to the host view.
