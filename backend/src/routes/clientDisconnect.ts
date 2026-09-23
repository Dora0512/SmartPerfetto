// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Abort signal that fires when the HTTP client disconnects, so model calls an
 * abandoned request started stop instead of running (and spending provider
 * budget) to their deadline.
 *
 * Watches the *response*, not the request: `IncomingMessage` 'close' also fires
 * on a normally consumed body, which would abort healthy requests. A response
 * that closes without `writableEnded` is a real disconnect.
 *
 * Create it before the first long await in a handler: a listener attached
 * after the client has already gone never fires.
 */
export function clientDisconnectSignal(res: {
  writableEnded: boolean;
  on(event: 'close', listener: () => void): unknown;
}): AbortSignal {
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });
  return controller.signal;
}
