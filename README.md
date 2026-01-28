# ALGTP Backend

Backend authentication and payment service using Google OAuth and Stripe.

## Setup

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment Variables
Copy `.env.example` to `.env` and fill in your credentials:
```bash
cp .env.example .env
```

### 3. Get Google OAuth Credentials
1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select an existing one
3. Enable the Google+ API
4. Go to **Credentials** → **Create Credentials** → **OAuth 2.0 Client ID**
5. Configure the OAuth consent screen if needed
6. Choose **Web application** as the application type
7. Add authorized redirect URIs:
   - `http://localhost:3000/ui/auth/google/callback` (for development)
   - Your production callback URL (when deploying)
8. Copy the **Client ID** and **Client Secret** to your `.env` file

### 4. Get Stripe Credentials
1. Go to [Stripe Dashboard](https://dashboard.stripe.com/)
2. Get your **Secret Key** from the Developers section
3. Create a subscription product and get the **Price ID**
4. Add these to your `.env` file

### 5. Run the Server
```bash
node index.js
```

The server will start on `http://localhost:3000`

## Routes

- `GET /` - API info
- `GET /health` - Health check
- `GET /login` - Login page
- `GET /auth/google` - Initiate Google OAuth
- `GET /ui/auth/google/callback` - Google OAuth callback
- `GET /ui` - Protected user dashboard
- `GET /subscribe` - Create Stripe checkout session
- `GET /logout` - Logout

## Environment Variables

| Variable | Description |
|----------|-------------|
| `PORT` | Server port (default: 3000) |
| `NODE_ENV` | Environment (development/production) |
| `APP_URL` | Application URL |
| `SESSION_SECRET` | Secret for session encryption |
| `GOOGLE_CLIENT_ID` | Google OAuth Client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth Client Secret |
| `GOOGLE_CALLBACK_URL` | Google OAuth callback URL |
| `STRIPE_SECRET_KEY` | Stripe secret key |
| `STRIPE_PRICE_ID` | Stripe price ID for subscription |
