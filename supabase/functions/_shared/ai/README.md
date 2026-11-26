# Generated — do not edit

These files are a byte-identical copy of [`js/ai/`](../../../../js/ai/), the shared AI core that the web app and the Android app also run. The `ai-proxy` Edge Function imports this copy because Supabase bundles a function from `supabase/functions/`.

Edit `js/ai/*.js`, then regenerate:

```bash
cd mobile && npm run sync:shared-ai
```

`mobile/tests/shared-ai-sync.test.js` fails if this copy drifts from `js/ai/`.
