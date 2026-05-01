// controllers/artistController.js — Cloudinary pour les photos
import mongoose from 'mongoose';
import Artist   from '../models/Artist.js';
import Category from '../models/Category.js';
import Vote     from '../models/Vote.js';
import { asyncHandler }                          from '../middlewares/authMiddleware.js';
import { uploadToCloudinary, deleteFromCloudinary, extractPublicId } from '../services/cloudinaryService.js';

const toObjectId = (id) => new mongoose.Types.ObjectId(String(id));

const getCategoryVoteTotal = async (categoryId) => {
  try {
    const agg = await Vote.aggregate([
      { $match: { category: toObjectId(categoryId), status: 'confirmed' } },
      { $group: { _id: null, total: { $sum: '$voteCount' } } },
    ]);
    return agg[0]?.total || 0;
  } catch { return 0; }
};

// Photo = URL Cloudinary complète (https://res.cloudinary.com/...)
// On la stocke telle quelle en base et on la retourne directement
const buildPhotoUrl = (photo) => photo || '';

const formatArtist = (artist, categoryTotalVotes = 0) => ({
  id:             artist._id.toString(),
  _id:            artist._id.toString(),
  name:           artist.name,
  realName:       artist.realName || '',
  categoryId:     (artist.category?._id || artist.category).toString(),
  photo:          buildPhotoUrl(artist.photo),
  bio:            artist.bio    || '',
  genre:          artist.genre  || '',
  nationality:    artist.nationality || '',
  votes:          artist.votes  || 0,
  votesGratuit:   artist.votesGratuit || 0,
  votesPay:       artist.votesPay    || 0,
  scoreTotal:     artist.scoreTotal  || 0,
  featured:       artist.featured    || false,
  votePercentage: categoryTotalVotes > 0
    ? Math.round(((artist.votes || 0) / categoryTotalVotes) * 100) : 0,
});

// ─── GET ALL ──────────────────────────────────────────────────────────────────
export const getArtists = asyncHandler(async (req, res) => {
  const filter = { isActive: true };
  if (req.query.category)            filter.category = req.query.category;
  if (req.query.featured === 'true') filter.featured = true;

  const artists = await Artist.find(filter)
    .populate('category', 'name slug icon color status')
    .sort({ scoreTotal: -1, votes: -1 }).lean();

  const catIds = [...new Set(artists.map(a => a.category?._id?.toString()).filter(Boolean))];
  const totals = {};
  await Promise.all(catIds.map(async id => { totals[id] = await getCategoryVoteTotal(id); }));

  const data = artists.map(a => ({
    ...formatArtist(a, totals[a.category?._id?.toString()] || 0),
    category: a.category ? {
      id: a.category._id.toString(), _id: a.category._id.toString(),
      name: a.category.name, slug: a.category.slug,
      icon: a.category.icon, color: a.category.color, status: a.category.status,
    } : null,
  }));

  res.json({ success: true, data, count: data.length });
});

// ─── GET ONE ──────────────────────────────────────────────────────────────────
export const getArtist = asyncHandler(async (req, res) => {
  const artist = await Artist.findOne({ _id: req.params.id, isActive: true })
    .populate('category', 'name slug icon color status');
  if (!artist) return res.status(404).json({ success: false, message: 'Artiste introuvable.' });

  const catTotal = await getCategoryVoteTotal(artist.category._id);
  const rank     = await Artist.countDocuments({
    category: artist.category._id, votes: { $gt: artist.votes || 0 }, isActive: true,
  }) + 1;

  res.json({ success: true, data: { ...formatArtist(artist, catTotal), rank, categoryTotalVotes: catTotal } });
});

// ─── CREATE ───────────────────────────────────────────────────────────────────
export const createArtist = asyncHandler(async (req, res) => {
  const { name, realName, categoryId, bio, genre, nationality, votes, featured } = req.body;

  if (!name?.trim())  return res.status(400).json({ success: false, message: 'Le nom est requis.' });
  if (!categoryId)    return res.status(400).json({ success: false, message: 'La catégorie est requise.' });

  const category = await Category.findById(categoryId);
  if (!category)      return res.status(404).json({ success: false, message: 'Catégorie introuvable.' });

  // Upload photo vers Cloudinary si présente
  let photoUrl = '';
  if (req.file?.buffer) {
    const result = await uploadToCloudinary(req.file.buffer, {
      folder:    'ima-awards/artists',
      public_id: `artist-${Date.now()}`,
    });
    photoUrl = result.url;
  }

  const artist = await Artist.create({
    name: name.trim(),
    realName:    realName?.trim()    || '',
    category:    categoryId,
    photo:       photoUrl,
    bio:         bio?.trim()         || '',
    genre:       genre?.trim()       || '',
    nationality: nationality?.trim() || '',
    votes:       parseInt(votes)     || 0,
    featured:    featured === true || featured === 'true',
  });

  await artist.populate('category', 'name slug icon color status');
  const catTotal = await getCategoryVoteTotal(categoryId);
  res.status(201).json({ success: true, data: formatArtist(artist, catTotal) });
});

// ─── UPDATE ───────────────────────────────────────────────────────────────────
export const updateArtist = asyncHandler(async (req, res) => {
  const artist = await Artist.findById(req.params.id);
  if (!artist) return res.status(404).json({ success: false, message: 'Artiste introuvable.' });

  const { name, realName, categoryId, bio, genre, nationality, featured, isActive } = req.body;

  // Nouvelle photo → supprimer l'ancienne sur Cloudinary, uploader la nouvelle
  if (req.file?.buffer) {
    const oldId = extractPublicId(artist.photo);
    if (oldId) await deleteFromCloudinary(oldId);
    const result = await uploadToCloudinary(req.file.buffer, {
      folder:    'ima-awards/artists',
      public_id: `artist-${artist._id}-${Date.now()}`,
    });
    artist.photo = result.url;
  }

  if (name)        artist.name        = name.trim();
  if (realName    !== undefined) artist.realName    = realName.trim();
  if (categoryId)  artist.category    = categoryId;
  if (bio         !== undefined) artist.bio         = bio.trim();
  if (genre       !== undefined) artist.genre       = genre.trim();
  if (nationality !== undefined) artist.nationality = nationality.trim();
  if (featured    !== undefined) artist.featured    = featured === true || featured === 'true';
  if (isActive    !== undefined) artist.isActive    = isActive === true || isActive === 'true';

  await artist.save();
  await artist.populate('category', 'name slug icon color status');
  const catTotal = await getCategoryVoteTotal(artist.category._id);
  res.json({ success: true, data: formatArtist(artist, catTotal) });
});

// ─── DELETE ───────────────────────────────────────────────────────────────────
export const deleteArtist = asyncHandler(async (req, res) => {
  const artist = await Artist.findById(req.params.id);
  if (!artist) return res.status(404).json({ success: false, message: 'Artiste introuvable.' });

  const oldId = extractPublicId(artist.photo);
  if (oldId) await deleteFromCloudinary(oldId);

  await artist.deleteOne();
  res.json({ success: true, message: 'Artiste supprimé.' });
});

// ─── RESET VOTES ──────────────────────────────────────────────────────────────
export const resetArtistVotes = asyncHandler(async (req, res) => {
  const artist = await Artist.findByIdAndUpdate(req.params.id,
    { votes: 0, votesGratuit: 0, votesPay: 0, votesJury: 0, scoreTotal: 0 },
    { new: true }
  );
  if (!artist) return res.status(404).json({ success: false, message: 'Artiste introuvable.' });
  res.json({ success: true, message: 'Votes réinitialisés.', data: formatArtist(artist) });
});
