# V10 Pilot Deployment

Requirements: Node.js 22+ and persistent disk storage.

1. Set `NODE_ENV=production`, `PORT`, and `DATA_DIR` to a persistent writable directory.
2. Run `npm install` then `npm start`.
3. Check `/api/health`; it must return `ok: true` and `database: ok`.
4. Create a trial institute, log in, then open Pilot system status.
5. Use Export institute data regularly during the pilot.

The pilot works without an OpenAI key. Billing and WhatsApp remain sandbox adapters until real provider credentials/webhooks are deliberately enabled. Do not expose a production billing webhook without a strong `BILLING_WEBHOOK_SECRET`.
