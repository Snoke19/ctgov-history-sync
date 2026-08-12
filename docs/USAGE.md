Running the project

Prerequisites
- Node 18+ (recommended)
- npm

Quick start
1. Install dependencies:
   npm install

2. Create an .env for runtime configuration (the project ships an example):
   cp .env.example .env

3. Run the application (development TypeScript runner):
   npm start

   The start script preloads environment variables from .env using dotenv and then runs TypeScript via tsx. If you prefer to manually set env vars, you can also run:
   DOTENV_CONFIG_PATH=.env npx tsx src/index.ts

Running tests
- Unit tests use Jest. The test script will preload DOTENV from .env.test (if present):

  npm test

Notes
- The project previously validated configuration at module import time. Validation is now exposed as an explicit helper: call ensureValidConfig() from your app bootstrap after loading environment files. See src/config/config.ts for details.
