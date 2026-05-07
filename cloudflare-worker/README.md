# Bug-Report-Proxy (Cloudflare Worker)

Kleiner Worker, der den Web3Forms-Access-Key serverseitig haelt. Die App spricht
nur diesen Endpoint an, der Key kommt nie ins Renderer- oder gepackte App-Bundle.

## Setup (einmalig)

1. Cloudflare-Account anlegen (gratis: https://dash.cloudflare.com/sign-up).
2. Wrangler installieren oder via npx benutzen — kein globales Install noetig.
3. In diesem Ordner einloggen:

   ```
   cd cloudflare-worker
   npx wrangler login
   ```

4. Web3Forms-Key als Secret setzen (wird interaktiv abgefragt):

   ```
   npx wrangler secret put WEB3FORMS_KEY
   ```

   Wert: der bisher in `main.js` hardcodierte Key `269ca388-8c7d-41e9-9063-2b6429a81b6b`.
   **Tipp:** danach im Web3Forms-Dashboard einen NEUEN Key generieren und den
   alten ablaufen lassen — der alte ist bereits in den AppImage-/Snap-Releases
   geleakt und kann von jedem extrahiert werden, der ein altes Binary hat.

5. Optional: schwachen App-Check aktivieren. Erschwert Casual-Spam, ist aber
   trivial reverse-engineerbar (Secret liegt in der App).

   ```
   openssl rand -hex 32     # erzeugt 64-stelligen Hex-String
   npx wrangler secret put APP_SHARED_SECRET
   ```

   Den Wert dann auch in `main.js` als `BUG_REPORT_APP_SECRET` eintragen.

6. Optional: Rate-Limit aktivieren (5 Submits/Stunde/IP).

   ```
   npx wrangler kv namespace create RATE_LIMIT
   ```

   Die zurueckgegebene `id` in `wrangler.toml` eintragen und den Block
   ein-kommentieren.

7. Deployen:

   ```
   npx wrangler deploy
   ```

   Im Output steht die URL, z.B.
   `https://claude-desktop-bugreport.<account>.workers.dev`. Diese URL in
   `main.js` als `BUG_REPORT_ENDPOINT` eintragen.

## Endpoint

`POST <worker-url>/submit` — JSON-Body:

```json
{
  "subject": "Bug-Title",
  "message": "Beschreibung",
  "email": "optional@example.com"
}
```

Header `X-App-Secret` falls `APP_SHARED_SECRET` gesetzt ist.

Response: `{ "success": true|false, "message": "..." }`

## Re-Deploy nach Code-Aenderung

```
npx wrangler deploy
```

Secrets bleiben erhalten.

## Logs anschauen

```
npx wrangler tail
```
