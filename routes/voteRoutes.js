// routes/voteRoutes.js
import express   from 'express';
import rateLimit from 'express-rate-limit';
import {
  castFreeVote,
  initMobileMoneyVote, initCardVote, initPaidVote,
  fedapayCallback, fedapayMockRedirect, fedapayMock,
  verifyPayment,
  castJuryVote,
  getLiveResults, getStats, checkVoted, getVoteHistory,
} from '../controllers/voteController.js';
import { protect, authorize } from '../middlewares/authMiddleware.js';

const router    = express.Router();
const voteLimiter = rateLimit({
  windowMs: 60000, max: 30,
  message: { success: false, message: 'Trop de requêtes, réessayez dans 1 minute.' },
});

// ── Publiques ──────────────────────────────────────────────────────────────────
router.get('/results',          getLiveResults);
router.get('/stats',            getStats);
router.get('/check/:artistId',  checkVoted);

// Vote gratuit
router.post('/free', voteLimiter, castFreeVote);

// Vote payant — FedaPay
router.post('/paid/mobile',  voteLimiter, initMobileMoneyVote);
router.post('/paid/card',    voteLimiter, initCardVote);
router.post('/paid/init',    voteLimiter, initPaidVote);

// Callback FedaPay
router.post('/fedapay/callback',     fedapayCallback);
router.get('/fedapay/callback',      fedapayCallback);
router.get('/fedapay/mock-redirect', fedapayMockRedirect);
router.get('/fedapay/mock',          fedapayMock);
router.get('/fedapay/verify',        verifyPayment);

// ── Admin ──────────────────────────────────────────────────────────────────────
router.post('/jury',    protect, authorize('admin', 'super_admin'), castJuryVote);
router.get('/history',  protect, authorize('admin', 'super_admin'), getVoteHistory);

export default router;
