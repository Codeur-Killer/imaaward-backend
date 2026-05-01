// controllers/voteController.js
// Système pondéré : Gratuit 20% | Jury 20% | Payant 60%
// Passerelle paiement : FedaPay Sandbox (Mobile Money + Carte bancaire)
import crypto   from 'crypto';
import mongoose from 'mongoose';
import Vote     from '../models/Vote.js';
import Payment  from '../models/Payment.js';
import Artist   from '../models/Artist.js';
import Category from '../models/Category.js';
import { asyncHandler }                   from '../middlewares/authMiddleware.js';
import { emitVoteUpdate, emitAdminStats } from '../socket/socket.js';

// ─── Config ───────────────────────────────────────────────────────────────────
const WEIGHTS        = { gratuit: 0.20, payant: 0.60, jury: 0.20 };
const PRICE_PER_VOTE = parseInt(process.env.PRICE_PER_VOTE) || 200;
const CURRENCY       = process.env.VOTE_CURRENCY  || 'XOF';
const FEDAPAY_ENV    = process.env.FEDAPAY_ENV    || 'sandbox';
const FRONT_URL      = process.env.FEDAPAY_REDIRECT_URL || 'http://localhost:5173';

const CHECKOUT_BASE = FEDAPAY_ENV === 'sandbox'
  ? 'https://sandbox-checkout.fedapay.com'
  : 'https://checkout.fedapay.com';

// ─── URLs de retour ───────────────────────────────────────────────────────────
const getCelebrationUrl = (ref, artistId, qty) =>
  `${FRONT_URL}/paiement-succes?ref=${ref}&artistId=${artistId}&votes=${qty}`;

const getErrorUrl = (ref) =>
  `${FRONT_URL}/paiement-erreur?ref=${ref}`;

// ─── Helpers ──────────────────────────────────────────────────────────────────
const getIp = (req) =>
  (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
  req.socket?.remoteAddress || req.ip || '0.0.0.0';

const makeFreeFingerprint = (ip, artistId) =>
  crypto.createHash('sha256').update(`ima::free::${ip}::${String(artistId)}`).digest('hex');

const makeTransactionRef = () =>
  `IMA-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

const oid = (id) => new mongoose.Types.ObjectId(String(id));

// ─── FedaPay SDK (lazy init) ──────────────────────────────────────────────────
let _fedaReady = false;
const initFedaPay = async () => {
  if (_fedaReady) return;
  const { FedaPay } = await import('fedapay');
  FedaPay.setApiKey(process.env.FEDAPAY_SECRET_KEY);
  FedaPay.setEnvironment(FEDAPAY_ENV);
  _fedaReady = true;
  console.log(`🔑 FedaPay initialisé [${FEDAPAY_ENV}]`);
};

// ─── Calcul du score pondéré ──────────────────────────────────────────────────
const recalcScore = async (artistId) => {
  const agg = await Vote.aggregate([
    { $match: { artist: oid(artistId), status: 'confirmed' } },
    { $group: { _id: '$type', total: { $sum: '$voteCount' } } },
  ]);
  const by = { gratuit: 0, payant: 0, jury: 0 };
  agg.forEach(r => { by[r._id] = r.total; });
  const score = by.gratuit * WEIGHTS.gratuit + by.payant * WEIGHTS.payant + by.jury * WEIGHTS.jury;
  await Artist.findByIdAndUpdate(artistId, {
    votesGratuit: by.gratuit, votesPay: by.payant, votesJury: by.jury,
    votes: by.gratuit + by.payant,
    scoreTotal: Math.round(score * 100) / 100,
  });
  return { ...by, scoreTotal: Math.round(score * 100) / 100 };
};

const buildCategoryStats = async (catId) => {
  const artists = await Artist.find({ category: catId, isActive: true }).sort({ scoreTotal: -1 }).lean();
  const total   = artists.reduce((s, a) => s + (a.votes || 0), 0);
  return {
    categoryId: String(catId), totalVotes: total,
    artists: artists.map((a, i) => ({
      id: String(a._id), name: a.name, photo: a.photo,
      votes: a.votes || 0, scoreTotal: a.scoreTotal || 0, rank: i + 1,
      votePercentage: total > 0 ? Math.round(((a.votes || 0) / total) * 100) : 0,
    })),
  };
};

const getGlobalStats = async () => {
  const [fA, pA, jA, totalArtists, openCats, revA] = await Promise.all([
    Vote.aggregate([{ $match:{ type:'gratuit', status:'confirmed' } }, { $group:{ _id:null, t:{ $sum:'$voteCount' } } }]),
    Vote.aggregate([{ $match:{ type:'payant',  status:'confirmed' } }, { $group:{ _id:null, t:{ $sum:'$voteCount' } } }]),
    Vote.aggregate([{ $match:{ type:'jury',    status:'confirmed' } }, { $group:{ _id:null, t:{ $sum:'$voteCount' } } }]),
    Artist.countDocuments({ isActive: true }),
    Category.countDocuments({ status: 'open' }),
    Payment.aggregate([{ $match:{ status:'approved' } }, { $group:{ _id:null, t:{ $sum:'$amount' } } }]),
  ]);
  const free = fA[0]?.t || 0, paid = pA[0]?.t || 0, jury = jA[0]?.t || 0;
  return {
    totalVotesFree: free, totalVotesPaid: paid, totalVotesJury: jury,
    totalVotes: free + paid, totalRevenue: revA[0]?.t || 0,
    totalArtists, openCategories: openCats,
  };
};

const emitRealtime = async (artistId, artistName, catId, catName) => {
  const u = await Artist.findById(artistId).lean();
  const c = await buildCategoryStats(catId);
  const g = await getGlobalStats();
  emitVoteUpdate({ artistId: String(artistId), categoryId: String(catId), artist: { id: String(u._id), name: u.name, photo: u.photo, votes: u.votes }, categoryStats: c, globalStats: g });
  emitAdminStats({ ...g, recentVote: { artistName, categoryName: catName, timestamp: new Date() } });
};

// ─── Création transaction FedaPay ─────────────────────────────────────────────
const createFedaTransaction = async ({ qty, artist, amount, callbackUrl, redirectUrl, customerName, customerEmail, phoneNumber }) => {
  await initFedaPay();
  const { Transaction } = await import('fedapay');

  const payload = {
    description:  `${qty} vote(s) pour ${artist.name} — IMA Awards`,
    amount,
    currency:     { iso: CURRENCY },
    callback_url: callbackUrl,
    redirect_url: redirectUrl,
    customer: {
      firstname: customerName.split(' ')[0]                || 'Fan',
      lastname:  customerName.split(' ').slice(1).join(' ') || 'IMA',
      email:     customerEmail.trim(),
    },
  };

  if (phoneNumber) {
    payload.customer.phone_number = {
      number:  phoneNumber.replace(/\s+/g, ''),
      country: 'BJ',
    };
  }

  const transaction  = await Transaction.create(payload);
  const tokenObj     = await transaction.generateToken();
  const rawToken     = tokenObj?.token ?? tokenObj;
  const checkoutUrl  = tokenObj?.url
    ?? (typeof rawToken === 'string' ? `${CHECKOUT_BASE}/payment-pages/${rawToken}` : null);

  if (!checkoutUrl) throw new Error('FedaPay: impossible de construire checkoutUrl');

  return { transaction, checkoutUrl };
};

// ─── Confirme paiement → crée les votes → redirige ───────────────────────────
const _confirm = async (payment, res) => {
  const artistId   = payment.artist?._id   ?? payment.artist;
  const categoryId = payment.category?._id ?? payment.category;

  payment.status = 'approved';
  payment.paidAt = new Date();
  await payment.save();

  const artist = await Artist.findById(artistId).populate('category');

  await Vote.create({
    artist: artistId, category: categoryId,
    ipAddress: payment.customerIp || '0.0.0.0',
    voterFingerprint: null,
    voteCount: payment.voteCount, type: 'payant',
    amount: payment.amount, customerEmail: payment.customerEmail,
    payment: payment._id, status: 'confirmed',
  });

  if (artist) {
    await recalcScore(artistId);
    await emitRealtime(artistId, artist.name, categoryId, artist.category?.name);
  }

  res.redirect(302, getCelebrationUrl(payment.transactionRef, String(artistId), payment.voteCount));
};

// ══════════════════════════════════════════════════════════════════════════════
// VOTE GRATUIT
// ══════════════════════════════════════════════════════════════════════════════
export const castFreeVote = asyncHandler(async (req, res) => {
  const { artistId } = req.body;
  if (!artistId) return res.status(400).json({ success: false, message: 'artistId requis.' });

  const artist = await Artist.findOne({ _id: artistId, isActive: true }).populate('category');
  if (!artist)                            return res.status(404).json({ success: false, message: 'Artiste introuvable.' });
  if (artist.category?.status !== 'open') return res.status(403).json({ success: false, message: 'Votes fermés.' });

  const fp = makeFreeFingerprint(getIp(req), artistId);
  if (await Vote.findOne({ voterFingerprint: fp, type: 'gratuit' })) {
    return res.status(409).json({ success: false, message: 'Vote gratuit déjà utilisé.', data: { alreadyVoted: true, artistId } });
  }

  await Vote.create({ artist: artistId, category: artist.category._id, ipAddress: getIp(req), voterFingerprint: fp, voteCount: 1, type: 'gratuit', status: 'confirmed' });
  await recalcScore(artistId);
  const u = await Artist.findById(artistId).lean();
  const c = await buildCategoryStats(artist.category._id);
  const g = await getGlobalStats();
  emitVoteUpdate({ artistId: String(artistId), categoryId: String(artist.category._id), artist: { id: String(u._id), name: u.name, photo: u.photo, votes: u.votes }, categoryStats: c, globalStats: g });
  emitAdminStats({ ...g, recentVote: { artistName: artist.name, categoryName: artist.category.name, timestamp: new Date() } });
  return res.status(201).json({ success: true, message: '✅ Vote gratuit enregistré !', data: { artistId: String(artistId), artistName: artist.name, newVoteCount: u.votes, categoryStats: c, globalStats: g } });
});

// ══════════════════════════════════════════════════════════════════════════════
// VOTE PAYANT — MOBILE MONEY
// ══════════════════════════════════════════════════════════════════════════════
export const initMobileMoneyVote = asyncHandler(async (req, res) => {
  const { artistId, voteCount = 1, customerEmail, customerName = '', phoneNumber = '', operator = '', voterCountry = '' } = req.body;

  if (!artistId)      return res.status(400).json({ success: false, message: 'artistId requis.' });
  if (!customerEmail) return res.status(400).json({ success: false, message: 'Email requis.' });
  if (!phoneNumber)   return res.status(400).json({ success: false, message: 'Numéro de téléphone requis.' });

  const qty    = Math.max(1, Math.min(999, parseInt(voteCount) || 1));
  const artist = await Artist.findOne({ _id: artistId, isActive: true }).populate('category');
  if (!artist)                            return res.status(404).json({ success: false, message: 'Artiste introuvable.' });
  if (artist.category?.status !== 'open') return res.status(403).json({ success: false, message: 'Votes fermés.' });

  const amount         = qty * PRICE_PER_VOTE;
  const transactionRef = makeTransactionRef();
  const callbackUrl    = `${process.env.FEDAPAY_CALLBACK_URL}?ref=${transactionRef}`;
  const redirectUrl    = getCelebrationUrl(transactionRef, String(artistId), qty);

  const payment = await Payment.create({
    transactionRef, artist: artistId, category: artist.category._id,
    voteCount: qty, amount, currency: CURRENCY,
    paymentMethod: 'mobile_money', mobileOperator: operator, phoneNumber,
    customerEmail: customerEmail.toLowerCase().trim(), customerName: customerName.trim(),
    customerIp: getIp(req), callbackUrl, voterCountry, status: 'pending',
  });

  try {
    const { transaction, checkoutUrl } = await createFedaTransaction({ qty, artist, amount, callbackUrl, redirectUrl, customerName: customerName.trim(), customerEmail: customerEmail.trim(), phoneNumber });
    payment.fedapayId   = String(transaction.id);
    payment.checkoutUrl = checkoutUrl;
    await payment.save();
    console.log(`✅ FedaPay Mobile Money txn=${transaction.id}`);
    return res.status(201).json({ success: true, data: { transactionRef, paymentId: String(payment._id), checkoutUrl, amount, voteCount: qty, pricePerVote: PRICE_PER_VOTE, currency: CURRENCY, paymentMethod: 'mobile_money', artist: { id: String(artist._id), name: artist.name } } });
  } catch (e) {
    console.error('❌ FedaPay Mobile Money:', e.message);
    const mockUrl = `${FRONT_URL}/paiement-mock?ref=${transactionRef}&artistId=${artistId}&votes=${qty}&amount=${amount}&method=mobile`;
    payment.checkoutUrl = mockUrl; await payment.save();
    return res.status(201).json({ success: true, isMock: true, data: { transactionRef, paymentId: String(payment._id), checkoutUrl: mockUrl, amount, voteCount: qty, pricePerVote: PRICE_PER_VOTE, currency: CURRENCY, paymentMethod: 'mobile_money', isMock: true, fedapayError: e.message, artist: { id: String(artist._id), name: artist.name } } });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// VOTE PAYANT — CARTE BANCAIRE
// ══════════════════════════════════════════════════════════════════════════════
export const initCardVote = asyncHandler(async (req, res) => {
  const { artistId, voteCount = 1, customerEmail, customerName = '', voterCountry = '' } = req.body;

  if (!artistId)      return res.status(400).json({ success: false, message: 'artistId requis.' });
  if (!customerEmail) return res.status(400).json({ success: false, message: 'Email requis.' });

  const qty    = Math.max(1, Math.min(999, parseInt(voteCount) || 1));
  const artist = await Artist.findOne({ _id: artistId, isActive: true }).populate('category');
  if (!artist)                            return res.status(404).json({ success: false, message: 'Artiste introuvable.' });
  if (artist.category?.status !== 'open') return res.status(403).json({ success: false, message: 'Votes fermés.' });

  const amount         = qty * PRICE_PER_VOTE;
  const transactionRef = makeTransactionRef();
  const callbackUrl    = `${process.env.FEDAPAY_CALLBACK_URL}?ref=${transactionRef}`;
  const redirectUrl    = getCelebrationUrl(transactionRef, String(artistId), qty);

  const payment = await Payment.create({
    transactionRef, artist: artistId, category: artist.category._id,
    voteCount: qty, amount, currency: CURRENCY,
    paymentMethod: 'card',
    customerEmail: customerEmail.toLowerCase().trim(), customerName: customerName.trim(),
    customerIp: getIp(req), callbackUrl, voterCountry, status: 'pending',
  });

  try {
    const { transaction, checkoutUrl } = await createFedaTransaction({ qty, artist, amount, callbackUrl, redirectUrl, customerName: customerName.trim(), customerEmail: customerEmail.trim() });
    payment.fedapayId   = String(transaction.id);
    payment.checkoutUrl = checkoutUrl;
    await payment.save();
    console.log(`✅ FedaPay Card txn=${transaction.id}`);
    return res.status(201).json({ success: true, data: { transactionRef, paymentId: String(payment._id), checkoutUrl, amount, voteCount: qty, pricePerVote: PRICE_PER_VOTE, currency: CURRENCY, paymentMethod: 'card', artist: { id: String(artist._id), name: artist.name } } });
  } catch (e) {
    console.error('❌ FedaPay Card:', e.message);
    const mockUrl = `${FRONT_URL}/paiement-mock?ref=${transactionRef}&artistId=${artistId}&votes=${qty}&amount=${amount}&method=card`;
    payment.checkoutUrl = mockUrl; await payment.save();
    return res.status(201).json({ success: true, isMock: true, data: { transactionRef, paymentId: String(payment._id), checkoutUrl: mockUrl, amount, voteCount: qty, pricePerVote: PRICE_PER_VOTE, currency: CURRENCY, paymentMethod: 'card', isMock: true, fedapayError: e.message, artist: { id: String(artist._id), name: artist.name } } });
  }
});

export const initPaidVote = initCardVote;

// ══════════════════════════════════════════════════════════════════════════════
// CALLBACK FEDAPAY
// ══════════════════════════════════════════════════════════════════════════════
export const fedapayCallback = asyncHandler(async (req, res) => {
  const transactionRef = req.query.ref || req.body?.metadata?.transactionRef || req.body?.custom_metadata?.transactionRef;
  if (!transactionRef) return res.status(400).json({ success: false, message: 'ref manquante.' });

  const payment = await Payment.findOne({ transactionRef }).populate('artist');
  if (!payment)  return res.status(404).json({ success: false, message: 'Paiement introuvable.' });

  const aid = payment.artist?._id ?? payment.artist;
  if (payment.status === 'approved') return res.redirect(302, getCelebrationUrl(transactionRef, String(aid), payment.voteCount));
  if (payment.status !== 'pending')  return res.redirect(302, getErrorUrl(transactionRef));

  let approved = false;
  try {
    await initFedaPay();
    const { Transaction } = await import('fedapay');
    if (payment.fedapayId) {
      const txn = await Transaction.retrieve(parseInt(payment.fedapayId));
      approved  = txn.status === 'approved';
    } else {
      approved = (req.body?.status || '') === 'approved';
    }
  } catch { approved = (req.body?.status || '') === 'approved'; }

  if (approved) {
    await _confirm(payment, res);
  } else {
    payment.status   = (req.body?.status || req.query?.status || 'declined') === 'cancelled' ? 'cancelled' : 'declined';
    payment.failedAt = new Date();
    await payment.save();
    res.redirect(302, getErrorUrl(transactionRef));
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// MOCK REDIRECT (dev/sandbox)
// ══════════════════════════════════════════════════════════════════════════════
export const fedapayMockRedirect = asyncHandler(async (req, res) => {
  const { ref } = req.query;
  if (!ref) return res.redirect(302, FRONT_URL);
  const payment = await Payment.findOne({ transactionRef: ref });
  if (!payment) return res.redirect(302, getErrorUrl(ref));
  const aid = payment.artist?._id ?? payment.artist;
  if (payment.status === 'approved') return res.redirect(302, getCelebrationUrl(ref, String(aid), payment.voteCount));
  if (payment.status !== 'pending')  return res.redirect(302, getErrorUrl(ref));
  await _confirm(payment, res);
});
export const fedapayMock = fedapayMockRedirect;

// ══════════════════════════════════════════════════════════════════════════════
// VERIFY PAYMENT
// ══════════════════════════════════════════════════════════════════════════════
export const verifyPayment = asyncHandler(async (req, res) => {
  const { ref } = req.query;
  if (!ref) return res.status(400).json({ success: false, message: 'ref manquante.' });
  const payment = await Payment.findOne({ transactionRef: ref })
    .populate('artist', 'name photo votes nationality')
    .populate('vote',   'voteCount status');
  if (!payment) return res.status(404).json({ success: false, message: 'Paiement introuvable.' });
  return res.json({ success: true, data: { status: payment.status, transactionRef: payment.transactionRef, artistName: payment.artist?.name || '', artistPhoto: payment.artist?.photo || '', artistVotes: payment.artist?.votes || 0, artistNationality: payment.artist?.nationality || '', voteCount: payment.voteCount, amount: payment.amount, currency: payment.currency, paymentMethod: payment.paymentMethod, paidAt: payment.paidAt } });
});

// ══════════════════════════════════════════════════════════════════════════════
// VOTE JURY, RÉSULTATS, STATS, etc. — inchangés
// ══════════════════════════════════════════════════════════════════════════════
export const castJuryVote = asyncHandler(async (req, res) => {
  const { artistId, voteCount = 1 } = req.body;
  if (!artistId) return res.status(400).json({ success: false, message: 'artistId requis.' });
  const qty    = Math.max(1, Math.min(100, parseInt(voteCount) || 1));
  const artist = await Artist.findById(artistId).populate('category');
  if (!artist)  return res.status(404).json({ success: false, message: 'Artiste introuvable.' });
  await Vote.create({ artist: artistId, category: artist.category._id, ipAddress: `jury::${req.user._id}`, voterFingerprint: null, voteCount: qty, type: 'jury', status: 'confirmed' });
  const scores = await recalcScore(artistId);
  await emitRealtime(artistId, artist.name, artist.category._id, artist.category.name);
  return res.status(201).json({ success: true, message: `✅ ${qty} vote(s) jury enregistré(s).`, data: { artistId: String(artistId), artistName: artist.name, scores } });
});

export const getLiveResults = asyncHandler(async (req, res) => {
  const categories = await Category.find().sort({ displayOrder: 1, createdAt: 1 }).lean();
  const results = await Promise.all(categories.map(async (cat) => {
    const artists = await Artist.find({ category: cat._id, isActive: true }).sort({ scoreTotal: -1 }).lean();
    const total   = artists.reduce((s, a) => s + (a.votes || 0), 0);
    const ranked  = artists.map((a, i) => ({ id: String(a._id), _id: String(a._id), name: a.name, realName: a.realName || '', categoryId: String(cat._id), photo: a.photo || '', bio: a.bio || '', genre: a.genre || '', nationality: a.nationality || '', votes: a.votes || 0, votesGratuit: a.votesGratuit || 0, votesPay: a.votesPay || 0, scoreTotal: a.scoreTotal || 0, featured: a.featured, rank: i + 1, votePercentage: total > 0 ? Math.round(((a.votes || 0) / total) * 100) : 0 }));
    return { category: { id: String(cat._id), _id: String(cat._id), slug: cat.slug, name: cat.name, description: cat.description || '', icon: cat.icon, color: cat.color, status: cat.status, artistCount: artists.length, totalVotes: total }, artists: ranked, totalVotes: total, podium: ranked.slice(0, 3) };
  }));
  return res.json({ success: true, data: results, timestamp: new Date().toISOString() });
});

export const getStats = asyncHandler(async (req, res) => {
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const [globalStats, byTypeAndCategory, last7Days, topArtists, recentVotes, scoresByCategory] = await Promise.all([
    getGlobalStats(),
    Vote.aggregate([{ $match:{ status:'confirmed' } }, { $group:{ _id:{ category:'$category', type:'$type' }, total:{ $sum:'$voteCount' } } }, { $lookup:{ from:'categories', localField:'_id.category', foreignField:'_id', as:'cat' } }, { $unwind:'$cat' }, { $project:{ categoryName:'$cat.name', icon:'$cat.icon', color:'$cat.color', type:'$_id.type', total:1 } }]),
    Vote.aggregate([{ $match:{ status:'confirmed', createdAt:{ $gte:weekAgo } } }, { $group:{ _id:{ date:{ $dateToString:{ format:'%Y-%m-%d', date:'$createdAt' } }, type:'$type' }, votes:{ $sum:'$voteCount' }, revenue:{ $sum:'$amount' } } }, { $sort:{ '_id.date':1 } }]),
    Artist.find({ isActive:true }).sort({ scoreTotal:-1 }).limit(10).populate('category','name icon color').lean(),
    Vote.find({ status:'confirmed' }).sort({ createdAt:-1 }).limit(50).populate('artist','name photo').populate('category','name icon').lean(),
    Artist.aggregate([{ $match:{ isActive:true } }, { $group:{ _id:'$category', totalScore:{ $sum:'$scoreTotal' }, totalPublicVotes:{ $sum:'$votes' }, totalFree:{ $sum:'$votesGratuit' }, totalPaid:{ $sum:'$votesPay' }, totalJury:{ $sum:'$votesJury' } } }, { $lookup:{ from:'categories', localField:'_id', foreignField:'_id', as:'cat' } }, { $unwind:'$cat' }, { $sort:{ totalScore:-1 } }]),
  ]);
  const chartMap = {};
  last7Days.forEach(d => { const date = d._id.date; if (!chartMap[date]) chartMap[date] = { name: new Date(date + 'T12:00:00').toLocaleDateString('fr-FR', { weekday: 'short' }), gratuit: 0, payant: 0, jury: 0, revenue: 0 }; chartMap[date][d._id.type] += d.votes; chartMap[date].revenue += d.revenue || 0; });
  return res.json({ success: true, data: { ...globalStats, weights: WEIGHTS, byTypeAndCategory, chartData: Object.values(chartMap), scoresByCategory, topArtists: topArtists.map(a => ({ id: String(a._id), name: a.name, photo: a.photo, votes: a.votes, votesGratuit: a.votesGratuit || 0, votesPay: a.votesPay || 0, votesJury: a.votesJury || 0, scoreTotal: a.scoreTotal || 0, categoryId: String(a.category?._id), categoryName: a.category?.name, categoryIcon: a.category?.icon })), recentVotes: recentVotes.map(v => ({ id: String(v._id), artistName: v.artist?.name || 'Inconnu', categoryName: v.category?.name || 'Inconnue', votes: v.voteCount, type: v.type, amount: v.amount || 0, timestamp: v.createdAt, ip: v.ipAddress })) } });
});

export const checkVoted = asyncHandler(async (req, res) => {
  const fp = makeFreeFingerprint(getIp(req), req.params.artistId);
  const ex = await Vote.findOne({ voterFingerprint: fp, type: 'gratuit' });
  return res.json({ success: true, data: { hasVoted: !!ex, artistId: req.params.artistId } });
});

export const getVoteHistory = asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1), limit = Math.min(100, parseInt(req.query.limit) || 20), skip = (page - 1) * limit;
  const filter = { status: 'confirmed' };
  if (req.query.type)   filter.type   = req.query.type;
  if (req.query.artist) filter.artist = req.query.artist;
  const [votes, total] = await Promise.all([Vote.find(filter).populate('artist','name photo').populate('category','name icon').sort({ createdAt:-1 }).skip(skip).limit(limit).lean(), Vote.countDocuments(filter)]);
  return res.json({ success: true, data: votes.map(v => ({ id: String(v._id), artistName: v.artist?.name || 'Inconnu', categoryName: v.category?.name || 'Inconnue', votes: v.voteCount, type: v.type, amount: v.amount || 0, timestamp: v.createdAt, ip: v.ipAddress })), pagination: { total, page, limit, totalPages: Math.ceil(total / limit) } });
});
