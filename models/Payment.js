// models/Payment.js
import mongoose from 'mongoose';

const paymentSchema = new mongoose.Schema({
  // Référence interne + FedaPay
  transactionRef:  { type: String, unique: true, required: true },
  // Flutterwave transaction ID
  flwTransactionId: { type: String, default: '' },
  flwRef:           { type: String, default: '' },

  // Relations
  artist:   { type: mongoose.Schema.Types.ObjectId, ref: 'Artist',   required: true },
  category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', required: true },
  vote:     { type: mongoose.Schema.Types.ObjectId, ref: 'Vote',     default: null },

  // Vote
  voteCount: { type: Number, required: true, min: 1 },
  amount:    { type: Number, required: true },
  currency:  { type: String, default: 'XOF' },

  // Méthode de paiement choisie par l'utilisateur
  paymentMethod: {
    type: String,
    enum: ['mobile_money', 'card', 'unknown'],
    default: 'unknown',
  },
  // Opérateur Mobile Money si applicable
  mobileOperator: { type: String, default: '' }, // 'mtn' | 'moov' | 'orange' | 'wave'
  // Numéro de téléphone (Mobile Money)
  phoneNumber: { type: String, default: '' },

  // Client
  customerEmail: { type: String, required: true, lowercase: true, trim: true },
  customerName:  { type: String, default: '' },
  customerIp:    { type: String, default: '' },
  // Pays du votant (pour message localisé)
  voterCountry:  { type: String, default: '' },

  // Statut
  status: {
    type: String,
    enum: ['pending', 'approved', 'declined', 'cancelled', 'refunded'],
    default: 'pending',
  },

  // URLs
  checkoutUrl: { type: String, default: '' },
  callbackUrl: { type: String, default: '' },

  // Timestamps
  paidAt:       { type: Date, default: null },
  failedAt:     { type: Date, default: null },
  failureReason:{ type: String, default: '' },

}, { timestamps: true, toJSON: { virtuals: true } });

paymentSchema.index({ status: 1, createdAt: -1 });
paymentSchema.index({ customerEmail: 1 });
paymentSchema.index({ artist: 1 });
paymentSchema.index({ transactionRef: 1 });
paymentSchema.index({ paymentMethod: 1 });

export default mongoose.model('Payment', paymentSchema);
