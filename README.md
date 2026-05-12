# ByoriDB Studio

Desktop management tool for ByoriDB - a distributed graph database.

## Features

- **Connection Management**: Connect to multiple ByoriDB servers with saved connection profiles
- **Server Settings**: Manage saved servers with built-in connection testing
- **Schema Browser**: Browse spaces, tags, and edges in a tree view
- **Query Editor**: Write and execute nGQL queries with syntax highlighting
- **Result Viewer**: View query results in table, JSON, or graph format
- **Query History**: Access previously executed queries

## Development

### Prerequisites

- Node.js 18+
- Rust 1.70+
- [Tauri CLI](https://tauri.app/v1/guides/getting-started/prerequisites)

### Setup

```bash
# Install dependencies
npm install

# Run in development mode
npm run tauri dev

# Build for production
npm run tauri build
```

### Testing

```bash
# Run frontend unit tests (Vitest)
npm test

# Frontend tests with coverage report
npm run coverage

# Run Rust backend tests
cd src-tauri && cargo test
```

### Project Structure

```
byori-studio/
├── src/                    # React frontend
│   ├── components/         # UI components (+ co-located *.test.tsx)
│   ├── styles/             # CSS styles
│   ├── test/               # Vitest setup (jsdom + jest-dom)
│   ├── App.tsx             # Main app component
│   ├── App.test.tsx
│   └── main.tsx            # Entry point
├── src-tauri/              # Tauri/Rust backend
│   ├── src/
│   │   ├── main.rs         # Tauri commands
│   │   └── client.rs       # ByoriDB client (+ unit tests)
│   ├── Cargo.toml
│   └── tauri.conf.json
├── package.json
└── vite.config.ts
```

## Tech Stack

- **Frontend**: React 19, TypeScript, Vite
- **Backend**: Rust, Tauri 2
- **Testing**: Vitest, Testing Library, jsdom (frontend); `cargo test` (backend)
- **Styling**: CSS (Catppuccin Mocha theme)

## License

Apache-2.0
