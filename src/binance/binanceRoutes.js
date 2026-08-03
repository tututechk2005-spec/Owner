'use strict';
const express = require('express');
const db = require('../db');
const cryptoUtil = require('../utils/crypto');
const logger = require('../utils/logger');
const { requireAuth } = require('../auth/middleware');
const { BinanceClient, buildClient } = require('./binanceService');

const router = express.Router();
const VALID_TYPES = ['spot_testnet', 'spot_real', 'futures_testnet', 'futures_real'];

router.use(requireAuth);

router.get('/accounts', async (req, res) => {
  try {
    const rows = await db.all(
      'SELECT id, account_type, label, is_active, is_verified, last_verified_at, created_at, api_key_enc FROM binance_accounts WHERE user_id = ?',
      [req.user.id]
    );
    // Each row is masked independently: a single account with an
    // undecryptable key (e.g. ENCRYPTION_KEY changed since it was saved)
    // must never take down the entire account list. Previously one bad
    // row threw inside .map() and made every connected account vanish
    // from the response - this is exactly the "account disappears"
    // symptom, and it happened even when the account's credentials were
    // completely fine in the database.
    const sanitized = rows.map((r) => {
      const { api_key_enc, ...rest } = r;
      try {
        return { ...rest, api_key_masked: cryptoUtil.mask(cryptoUtil.decrypt(api_key_enc)), decryption_error: null };
      } catch (e) {
        logger.error('binance', `Failed to decrypt api_key for account #${r.id}: ${e.message}`);
        return { ...rest, api_key_masked: null, decryption_error: e.message || 'Decryption error' };
      }
    });
    res.json({ accounts: sanitized });
  } catch (e) {
    logger.error('binance', `Failed to list accounts for user ${req.user.id}: ${e.message}`);
    res.status(500).json({ error: 'Failed to load your connected accounts due to a database error.', errorType: 'database_error', detail: e.message });
  }
});

router.post('/accounts/connect', async (req, res) => {
  const { accountType, apiKey, apiSecret, label } = req.body;
  if (!VALID_TYPES.includes(accountType)) return res.status(400).json({ error: 'Invalid account type', errorType: 'validation_error' });
  if (!apiKey || !apiSecret) return res.status(400).json({ error: 'API key and secret are required', errorType: 'validation_error' });

  let validation;
  try {
    const client = new BinanceClient(accountType, apiKey, apiSecret);
    validation = await client.validateKeys();
  } catch (e) {
    logger.error('binance', `Unexpected error during validation: ${e.message}`);
    return res.status(500).json({ error: 'Unexpected error while validating with Binance', errorType: 'unknown_error', detail: e.message });
  }

  if (!validation.ok) {
    return res.status(400).json({
      error: 'Binance API validation failed',
      errorType: validation.errorType || 'unknown_error',
      detail: validation.error,
      hint: validation.hint,
    });
  }

  let apiKeyEnc, apiSecretEnc;
  try {
    apiKeyEnc = cryptoUtil.encrypt(apiKey);
    apiSecretEnc = cryptoUtil.encrypt(apiSecret);
  } catch (e) {
    logger.error('binance', `Encryption failed while connecting account: ${e.message}`);
    return res.status(500).json({ error: 'Your API key was validated successfully, but the server could not encrypt it for storage.', errorType: e.errorType || 'encryption_error', detail: e.message });
  }

  let accountId;
  try {
    const info = await db.run(
      `INSERT INTO binance_accounts (user_id, account_type, api_key_enc, api_secret_enc, label, is_active, is_verified, last_verified_at)
       VALUES (?, ?, ?, ?, ?, 1, 1, strftime('%s','now'))`,
      [req.user.id, accountType, apiKeyEnc, apiSecretEnc, label || accountType]
    );
    accountId = info.lastInsertRowid;
  } catch (e) {
    // The Binance key WAS valid - this is a database failure, which the
    // frontend needs to distinguish from an invalid-key failure.
    logger.error('binance', `Database error saving verified account: ${e.message}`);
    return res.status(500).json({ error: 'Your API key was validated successfully, but saving it failed due to a database error. Please try again.', errorType: 'database_error', detail: e.message });
  }

  // Mandatory persistence check: immediately read the row back and decrypt
  // it server-side to confirm it was actually saved correctly and remains
  // usable, rather than trusting the INSERT alone. If this round-trip ever
  // fails, the account is removed again so we never leave a row in the
  // database that looks "connected" but can't actually be decrypted or used.
  try {
    const saved = await db.get('SELECT * FROM binance_accounts WHERE id = ?', [accountId]);
    if (!saved) throw Object.assign(new Error('Saved account could not be found immediately after insert'), { errorType: 'database_error' });

    const readBackKey = cryptoUtil.decrypt(saved.api_key_enc);
    const readBackSecret = cryptoUtil.decrypt(saved.api_secret_enc);
    if (readBackKey !== apiKey || readBackSecret !== apiSecret) {
      throw Object.assign(new Error('Decrypted credentials do not match what was submitted'), { errorType: 'decryption_error' });
    }

    // Final confirmation: the round-tripped, decrypted credentials must
    // still work against Binance before we tell the frontend "CONNECTED".
    const verifyClient = new BinanceClient(accountType, readBackKey, readBackSecret);
    const reVerify = await verifyClient.validateKeys();
    if (!reVerify.ok) {
      throw Object.assign(new Error(`Post-save verification failed: ${reVerify.error}`), { errorType: reVerify.errorType || 'unknown_error' });
    }

    logger.info('binance', `User ${req.user.id} connected ${accountType} account #${accountId} - persistence verified`);
    return res.json({
      ok: true,
      status: 'CONNECTED',
      accountId,
      message: 'Account connected and verified successfully.',
      snapshot: reVerify.snapshot || validation.snapshot || null,
    });
  } catch (e) {
    logger.error('binance', `Post-save verification failed for account #${accountId}, removing row: ${e.message}`);
    // Don't leave a broken row behind that would confuse future GET /accounts
    // calls or auto-trading - remove it and tell the user plainly what failed.
    try { await db.run('DELETE FROM binance_accounts WHERE id = ?', [accountId]); } catch (_) { /* best-effort cleanup */ }
    return res.status(500).json({
      error: 'Your API key was valid, but the server could not confirm the saved credentials could be read back and reused. The account was not kept.',
      errorType: e.errorType || 'unknown_error',
      detail: e.message,
    });
  }
});

router.delete('/accounts/:id', async (req, res) => {
  try {
    const account = await db.get('SELECT * FROM binance_accounts WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    await db.run('DELETE FROM binance_accounts WHERE id = ?', [account.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Error types that mean the credentials themselves are actually bad -
// only these should ever downgrade an account's verified status. Anything
// else (network blips, Binance rate limiting, Binance-side outages, clock
// drift) is transient and must NOT make a working account look disconnected.
const CREDENTIAL_ERROR_TYPES = new Set(['invalid_api_key', 'invalid_secret', 'missing_permissions']);

router.post('/accounts/:id/revalidate', async (req, res) => {
  try {
    const account = await db.get('SELECT * FROM binance_accounts WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    let client;
    try {
      client = buildClient(account.account_type, account.api_key_enc, account.api_secret_enc);
    } catch (e) {
      // Decryption failed - this is a server/config problem, not evidence
      // the stored credentials are wrong, so is_verified is left untouched.
      logger.error('binance', `Could not decrypt account #${account.id} for revalidation: ${e.message}`);
      return res.status(500).json({ error: e.message, errorType: e.errorType || 'decryption_error' });
    }

    const validation = await client.validateKeys();

    if (validation.ok) {
      await db.run(
        "UPDATE binance_accounts SET is_verified = 1, last_verified_at = strftime('%s','now') WHERE id = ?",
        [account.id]
      );
      return res.json({ ok: true, status: 'CONNECTED', snapshot: validation.snapshot || null });
    }

    const isCredentialFailure = CREDENTIAL_ERROR_TYPES.has(validation.errorType);
    if (isCredentialFailure) {
      await db.run(
        "UPDATE binance_accounts SET is_verified = 0, last_verified_at = strftime('%s','now') WHERE id = ?",
        [account.id]
      );
    } else {
      // Transient failure (network, rate limit, Binance outage, clock skew
      // that survived the automatic resync-and-retry) - do NOT touch
      // is_verified. The account stays shown as connected; the user just
      // sees that this particular check failed and why.
      logger.warn('binance', `Transient revalidation failure for account #${account.id} - leaving is_verified unchanged: ${validation.error}`);
      await db.run("UPDATE binance_accounts SET last_verified_at = strftime('%s','now') WHERE id = ?", [account.id]);
    }

    return res.status(isCredentialFailure ? 400 : 502).json({
      error: validation.error,
      errorType: validation.errorType,
      hint: validation.hint,
      transient: !isCredentialFailure,
      stillConnected: !isCredentialFailure && !!account.is_verified,
    });
  } catch (e) {
    logger.error('binance', `Unexpected error during revalidation: ${e.message}`);
    res.status(500).json({ error: e.message, errorType: e.errorType || 'unknown_error' });
  }
});

router.get('/accounts/:id/snapshot', async (req, res) => {
  try {
    const account = await db.get('SELECT * FROM binance_accounts WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const client = buildClient(account.account_type, account.api_key_enc, account.api_secret_enc);
    const [accountInfo, openOrders, positions] = await Promise.all([
      client.accountInfo(),
      client.openOrders(),
      client.positionRisk(),
    ]);

    let positionMode = null;
    if (account.account_type.startsWith('futures')) {
      try {
        const mode = await client.positionMode();
        positionMode = mode?.dualSidePosition ? 'Hedge Mode' : 'One-way Mode';
      } catch (e) {
        positionMode = null;
      }
    }

    const trades = await db.all(
      'SELECT * FROM trade_history WHERE account_id = ? ORDER BY closed_at DESC LIMIT 100',
      [account.id]
    );
    const wins = trades.filter((t) => t.result === 'win').length;
    const winRate = trades.length ? (wins / trades.length) * 100 : 0;

    res.json({
      accountInfo: sanitizeAccountInfo(accountInfo, account.account_type),
      accountStatus: { canTrade: !!accountInfo.canTrade, canDeposit: !!accountInfo.canDeposit, canWithdraw: !!accountInfo.canWithdraw },
      positionMode,
      openOrders,
      positions,
      localTradeHistory: trades,
      winRate,
    });
  } catch (e) {
    res.status(400).json({ error: e.message, errorType: e.errorType || 'unknown_error' });
  }
});

function sanitizeAccountInfo(info, accountType) {
  if (accountType.startsWith('futures')) {
    return {
      totalWalletBalance: info.totalWalletBalance,
      totalMarginBalance: info.totalMarginBalance,
      availableBalance: info.availableBalance,
      totalUnrealizedProfit: info.totalUnrealizedProfit,
    };
  }
  return { balances: (info.balances || []).filter((b) => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0) };
}

module.exports = router;
