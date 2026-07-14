# HELUX AI Workforce - Daisy 3.0

Production outbound calling service for the DPA Help Center. Daisy 3.0 separates the customer conversation from HELUX background operations while preserving the existing Express, PostgreSQL, Twilio, OpenAI Realtime, Monday.com, callback, retry, transfer, and reporting behavior.

## Run

1. Copy `.env.example` into your deployment environment and supply all required secrets.
2. Install dependencies with `npm install`.
3. Run `npm test` and `npm run check`.
4. Start with `npm start`.

The service keeps all existing API and webhook routes. See [Daisy 3.0 migration notes](docs/DAISY_3_MIGRATION.md) for architecture, behavior changes, preserved functionality, and rollout guidance.
