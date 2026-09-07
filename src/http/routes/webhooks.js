import express from 'express';

import { processWebhook } from '../../services/webhookService.js';
import { SignatureVerificationError } from '../../stripe/signature.js';

export function mountWebhookRoute(app) {
  app.post(
    '/webhooks/stripe',
    // Raw bytes, not parsed JSON. See the note in app.js.
    express.raw({ type: '*/*', limit: '1mb' }),
    async (req, res) => {
      const db = req.app.locals.db;
      const signature = req.get('stripe-signature');

      try {
        const result = await processWebhook(db, {
          rawBody: req.body,
          signatureHeader: signature,
        });

        // 200 for duplicate and stale as well as processed. All three mean
        // "received and handled, do not send it again"; a non-2xx would make
        // Stripe retry an event we have deliberately decided not to apply.
        res.status(200).json(result);
      } catch (err) {
        if (err instanceof SignatureVerificationError) {
          // Never leak why verification failed to an unauthenticated caller.
          // eslint-disable-next-line no-console
          console.warn(`[webhook] rejected: ${err.code} - ${err.message}`);
          res.status(400).json({ error: 'signature_verification_failed' });
          return;
        }
        if (err.statusCode === 400) {
          res.status(400).json({ error: 'bad_request', message: err.message });
          return;
        }
        // A processing failure must NOT be acknowledged: the transaction rolled
        // back, so returning 5xx is what gets the event redelivered and applied.
        // eslint-disable-next-line no-console
        console.error('[webhook] processing failed', err);
        res.status(500).json({ error: 'processing_failed' });
      }
    },
  );
}
