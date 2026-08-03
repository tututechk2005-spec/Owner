'use strict';
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth/middleware');

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  try {
    const user = await db.get('SELECT referral_code FROM users WHERE id = ?', [req.user.id]);
    const referrals = await db.all(
      `SELECT r.*, u.name, u.email, u.created_at as joined_at
       FROM referrals r JOIN users u ON u.id = r.referred_id
       WHERE r.referrer_id = ? ORDER BY r.created_at DESC`,
      [req.user.id]
    );
    const totalReferrals = referrals.length;
    const activeReferrals = referrals.filter((r) => r.status === 'active').length;
    const totalEarnings = referrals.reduce((a, r) => a + (r.earnings || 0), 0);
    const link = `${process.env.APP_URL || 'http://localhost:3000'}/register.html?ref=${user.referral_code}`;
    res.json({ referralCode: user.referral_code, referralLink: link, totalReferrals, activeReferrals, totalEarnings, balance: totalEarnings, history: referrals });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/leaderboard', async (req, res) => {
  try {
    const rows = await db.all(
      `SELECT u.name, u.referral_code, COUNT(r.id) as referral_count, COALESCE(SUM(r.earnings),0) as total_earnings
       FROM users u LEFT JOIN referrals r ON r.referrer_id = u.id
       GROUP BY u.id ORDER BY referral_count DESC LIMIT 20`
    );
    res.json({ leaderboard: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
