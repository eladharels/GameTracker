# GameTracker

A modern, full-stack app for tracking games, their metadata, and your play status. Features a dark, glassmorphism-inspired UI and supports both local and LDAP users.

---

## Features

- **Game Search:** Unified search using IGDB, RAWG, and TheGamesDB APIs.
- **Personal Library:** Track your play status (wishlist, playing, done).
- **User Management:** Admin UI, LDAP support, permission management.
- **Modern UI:** Responsive, dark, and visually rich frontend.
- **Persistence:** SQLite database for easy setup.

---

## Quick Start

### 1. Clone the Repository

```bash
git clone https://github.com/yourusername/gametracker.git
cd gametracker
```

### 2. Install Dependencies

#### Backend

```bash
npm install
```

#### Frontend

```bash
cd frontend
npm install
cd ..
```

### 3. Configure Environment Variables

Create a `.env` file in the project root (same directory as `index.js`). You will need API keys from [Twitch/IGDB](https://dev.twitch.tv/console/apps) and [RAWG](https://rawg.io/apidocs). TheGamesDB API key is optional but recommended.

```env
# .env (in project root)
IGDB_CLIENT_ID=your_igdb_client_id
IGDB_BEARER_TOKEN=your_igdb_bearer_token
RAWG_API_KEY=your_rawg_api_key
THEGAMESDB_API_KEY=your_thegamesdb_api_key  # Optional but recommended
JWT_SECRET=your_super_secret_jwt_key
```

- **IGDB_CLIENT_ID** and **IGDB_BEARER_TOKEN**: Get these from the [Twitch Developer Console](https://dev.twitch.tv/console/apps).
- **RAWG_API_KEY**: Get this from [RAWG.io](https://rawg.io/apidocs).
- **THEGAMESDB_API_KEY**: Get this from [TheGamesDB](https://api.thegamesdb.net/key.php) (optional - improves cover image availability).
- **JWT_SECRET**: Any random string for signing authentication tokens.

> **Note:** Never commit your `.env` file or API keys to version control.

### 4. Run the App

#### Backend

```bash
node index.js
```

#### Frontend (in a new terminal)

```bash
cd frontend
npm run dev
```

Visit [http://localhost:5173](http://localhost:5173) (or the port shown in your terminal) to use the app.

---

## Docker (Optional)

You can run the entire stack with Docker:

```bash
docker-compose up --build
```

This will start both the backend (on port 3000) and frontend (on port 8080).

---

## API Endpoints

- `GET /api/health` — Health check
- `GET /api/games/search?q=game_name` — Search games (IGDB + RAWG + TheGamesDB)
- `POST /api/user/:username/games` — Add/update game status
- `GET /api/user/:username/games` — Get user's game library

---

## Development Notes

- **Database:** Uses SQLite (`gametracker.db`).
- **User Management:** Admins can manage users and permissions. LDAP users are supported if configured.
- **Frontend:** Built with React + Vite. All API calls are proxied to the backend.

---

## Environment Variables Reference

| Variable            | Description                        | Where to get it                |
|---------------------|------------------------------------|-------------------------------|
| IGDB_CLIENT_ID      | Twitch/IGDB API client ID          | [Twitch Dev Console](https://dev.twitch.tv/console/apps) |
| IGDB_BEARER_TOKEN   | Twitch/IGDB OAuth token            | [Twitch Dev Console](https://dev.twitch.tv/console/apps) |
| RAWG_API_KEY        | RAWG.io API key                    | [RAWG.io](https://rawg.io/apidocs) |
| THEGAMESDB_API_KEY  | TheGamesDB API key (optional)        | [TheGamesDB](https://api.thegamesdb.net/key.php) |
| JWT_SECRET          | JWT signing secret (any string)     | Generate yourself              |

---

## Contributing

Pull requests and issues are welcome! Please open an issue for bugs or feature requests.

---

## License

MIT 