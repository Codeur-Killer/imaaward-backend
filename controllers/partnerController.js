// controllers/partnerController.js
import Partner from '../models/Partner.js';
import { asyncHandler }                          from '../middlewares/authMiddleware.js';
import { uploadToCloudinary, deleteFromCloudinary } from '../services/cloudinaryService.js';

const formatPartner = (p) => ({
  id:           p._id.toString(),
  _id:          p._id.toString(),
  name:         p.name,
  tier:         p.tier,
  logoUrl:      p.logoUrl   || '',
  website:      p.website   || '',
  tagline:      p.tagline   || '',
  color:        p.color     || '#C9A84C',
  isActive:     p.isActive,
  displayOrder: p.displayOrder,
  createdAt:    p.createdAt,
});

// ─── GET ALL (public) ─────────────────────────────────────────────────────────
export const getPartners = asyncHandler(async (req, res) => {
  const filter = { isActive: true };
  const partners = await Partner.find(filter)
    .sort({ displayOrder: 1, createdAt: 1 }).lean();
  res.json({ success: true, data: partners.map(formatPartner), count: partners.length });
});

// ─── GET ALL (admin — inclut inactifs) ────────────────────────────────────────
export const getAllPartners = asyncHandler(async (req, res) => {
  const partners = await Partner.find().sort({ displayOrder: 1, createdAt: 1 }).lean();
  res.json({ success: true, data: partners.map(formatPartner), count: partners.length });
});

// ─── CREATE ───────────────────────────────────────────────────────────────────
export const createPartner = asyncHandler(async (req, res) => {
  const { name, tier, website, tagline, color, displayOrder } = req.body;
  if (!name?.trim()) return res.status(400).json({ success: false, message: 'Nom requis.' });

  let logoUrl = '', logoPublicId = '';
  if (req.file?.buffer) {
    const result = await uploadToCloudinary(req.file.buffer, {
      folder:    'ima-awards/partners',
      public_id: `partner-${Date.now()}`,
    });
    logoUrl      = result.url;
    logoPublicId = result.publicId;
  }

  const partner = await Partner.create({
    name:         name.trim(),
    tier:         tier         || 'argent',
    logoUrl,
    logoPublicId,
    website:      website      || '',
    tagline:      tagline      || '',
    color:        color        || '#C9A84C',
    displayOrder: parseInt(displayOrder) || 0,
  });

  res.status(201).json({ success: true, data: formatPartner(partner) });
});

// ─── UPDATE ───────────────────────────────────────────────────────────────────
export const updatePartner = asyncHandler(async (req, res) => {
  const partner = await Partner.findById(req.params.id);
  if (!partner) return res.status(404).json({ success: false, message: 'Partenaire introuvable.' });

  // Nouveau logo
  if (req.file?.buffer) {
    if (partner.logoPublicId) await deleteFromCloudinary(partner.logoPublicId);
    const result     = await uploadToCloudinary(req.file.buffer, {
      folder:    'ima-awards/partners',
      public_id: `partner-${partner._id}-${Date.now()}`,
    });
    partner.logoUrl      = result.url;
    partner.logoPublicId = result.publicId;
  }

  const { name, tier, website, tagline, color, isActive, displayOrder } = req.body;
  if (name         !== undefined) partner.name         = name.trim();
  if (tier         !== undefined) partner.tier         = tier;
  if (website      !== undefined) partner.website      = website;
  if (tagline      !== undefined) partner.tagline      = tagline;
  if (color        !== undefined) partner.color        = color;
  if (isActive     !== undefined) partner.isActive     = isActive === true || isActive === 'true';
  if (displayOrder !== undefined) partner.displayOrder = parseInt(displayOrder);

  await partner.save();
  res.json({ success: true, data: formatPartner(partner) });
});

// ─── DELETE ───────────────────────────────────────────────────────────────────
export const deletePartner = asyncHandler(async (req, res) => {
  const partner = await Partner.findById(req.params.id);
  if (!partner) return res.status(404).json({ success: false, message: 'Partenaire introuvable.' });

  if (partner.logoPublicId) await deleteFromCloudinary(partner.logoPublicId);
  await partner.deleteOne();
  res.json({ success: true, message: 'Partenaire supprimé.' });
});
