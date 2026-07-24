# 🧬 FDI Lineage Explorer

A modern, database-backed web application to explore Oracle Fusion Data Intelligence (FDI) semantic lineages for ERP, HCM, SCM, and CX pillars.

---

## 🛠️ Local Development Setup

### 1. Environment Configuration
Create a `.env` file in the root directory (based on `.env.example`) to store your database credentials securely:
```env
TURSO_DATABASE_URL="libsql://fdi-explorer-ashwik.aws-ap-south-1.turso.io"
TURSO_AUTH_TOKEN="your-secret-token"
PORT=5000
```
*(The `.gitignore` file is pre-configured to ensure this file and its secret tokens are never pushed to GitHub).*

### 2. Run the App
To start both the backend Node server and the Vite React frontend in development mode, open your terminal and run:
```bash
# In Command Prompt (CMD) or Git Bash:
npm run dev

# In PowerShell:
powershell -ExecutionPolicy Bypass -Command "npm run dev"
```

Open **[http://localhost:5173/](http://localhost:5173/)** to view the app.

---

## 🚀 Deployment Guide

This project is configured as a monorepo, meaning you can easily deploy it as a **single, unified service** on **Render** (or deploy the frontend and backend separately on **Vercel** and **Render**).

### Option 1: Unified Service on Render (Recommended)
This approach builds your React frontend and serves it directly from the Express backend, hosting the entire app on a single Render URL for free.

1. Push your repository to **GitHub**.
2. Go to **[Render](https://render.com/)**, log in, and click **New > Web Service**.
3. Link your GitHub repository.
4. Set the following configuration:
   * **Runtime:** `Node`
   * **Build Command:** `npm install && npm run build`
   * **Start Command:** `node server.js`
5. Under **Environment Variables**, add:
   * `TURSO_DATABASE_URL` = `libsql://fdi-explorer-ashwik.aws-ap-south-1.turso.io`
   * `TURSO_AUTH_TOKEN` = `your-auth-token-string`
6. Click **Deploy Web Service**!

---

### Option 2: Split Services (Vercel Frontend + Render Backend)

#### Part A: Backend API on Render
1. Follow the Render steps above but set:
   * **Build Command:** `npm install`
   * **Start Command:** `node server.js`
2. Add your `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` environment variables.

#### Part B: Frontend on Vercel
1. Go to **[Vercel](https://vercel.com/)** and import your GitHub repository.
2. Under **Framework Preset**, select **Vite**.
3. Under **Environment Variables**, add the API redirect destination:
   * `VITE_API_URL` = `https://your-render-backend-url.onrender.com`
4. Click **Deploy**!
