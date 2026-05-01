// models/Partner.js
import mongoose from 'mongoose';

const partnerSchema = new mongoose.Schema({
  name:        { type: String, required: true, trim: true },
  tier:        {
    type:    String,
    enum:    ['officiel', 'platine', 'or', 'argent', 'media'],
    default: 'argent',
  },
  logoUrl:     { type: String, default: '' },          // URL Cloudinary
  logoPublicId:{ type: String, default: '' },          // Cloudinary public_id
  website:     { type: String, default: '' },
  tagline:     { type: String, default: '' },
  color:       { type: String, default: '#C9A84C' },   // couleur de la marque
  isActive:    { type: Boolean, default: true },
  displayOrder:{ type: Number, default: 0 },
}, { timestamps: true });

partnerSchema.index({ isActive: 1, displayOrder: 1 });
partnerSchema.index({ tier: 1 });

export default mongoose.model('Partner', partnerSchema);
