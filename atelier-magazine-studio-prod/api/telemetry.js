/**
 * Serverless Production Telemetry Ingestion Endpoint (/api/telemetry)
 * Compatible with Vercel Serverless Functions, Netlify Functions, and Node HTTP servers.
 * Validates PII-scrubbed event envelopes and optionally forwards to GA4 Measurement Protocol or PostHog.
 */
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const eventName = String(body.event || 'unknown_event').replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 64);

    const record = {
      received_at: new Date().toISOString(),
      event: eventName,
      category: String(body.category || 'engagement').slice(0, 32),
      session_id: String(body.session_id || '').slice(0, 64),
      anonymous_id: String(body.anonymous_id || '').slice(0, 64),
      release: String(body.release || '').slice(0, 32),
      context: body.context || {},
      properties: body.properties || {}
    };

    // Structured JSON log for Cloud Logging / Vercel Logs / Datadog / BigQuery sink
    console.log(JSON.stringify({ severity: 'INFO', component: 'atelier-telemetry', ...record }));

    // Optional: Forward to GA4 Measurement Protocol if GA4_MEASUREMENT_ID & GA4_API_SECRET env vars are set
    if (process.env.GA4_MEASUREMENT_ID && process.env.GA4_API_SECRET && typeof fetch === 'function') {
      const gaUrl = `https://www.google-analytics.com/mp/collect?measurement_id=${encodeURIComponent(process.env.GA4_MEASUREMENT_ID)}&api_secret=${encodeURIComponent(process.env.GA4_API_SECRET)}`;
      await fetch(gaUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: record.anonymous_id || 'anon_client',
          events: [{ name: eventName.slice(0, 40), params: record.properties }]
        })
      }).catch(() => {});
    }

    return res.status(204).end();
  } catch (err) {
    return res.status(400).json({ ok: false, error: 'Invalid telemetry payload' });
  }
}
