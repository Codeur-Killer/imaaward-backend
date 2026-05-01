// services/flutterwaveService.js
// Passerelle de paiement Flutterwave — Mobile Money + Carte bancaire
// Documentation : https://developer.flutterwave.com/docs
import crypto from 'crypto';

const FLW_SECRET_KEY     = process.env.FLW_SECRET_KEY     || '';
const FLW_BASE_URL       = 'https://api.flutterwave.com/v3';

// ─── Appel API interne ────────────────────────────────────────────────────────
const flwFetch = async (endpoint, method = 'GET', body = null) => {
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${FLW_SECRET_KEY}`,
      'Content-Type':  'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const res  = await fetch(`${FLW_BASE_URL}${endpoint}`, opts);
  const data = await res.json();

  if (!res.ok || data.status === 'error') {
    throw new Error(`Flutterwave: ${data.message || data.error || `HTTP ${res.status}`}`);
  }
  return data;
};

// ─── Options de paiement selon la méthode choisie ────────────────────────────
const getPaymentOptions = (method) => {
  if (method === 'mobile_money') return 'mobilemoney';
  if (method === 'card')         return 'card';
  return 'card,mobilemoney';  // toutes méthodes par défaut
};

// ─── Init paiement Standard Checkout ─────────────────────────────────────────
/**
 * Crée une session de paiement Flutterwave
 * Retourne { checkoutUrl, txRef }
 */
export const initFlutterwavePayment = async ({
  txRef,
  amount,
  currency = 'XOF',
  customerEmail,
  customerName,
  customerPhone = '',
  description,
  redirectUrl,
  paymentMethod = 'all',
  meta = {},
}) => {
  const payload = {
    tx_ref:          txRef,
    amount:          String(amount),
    currency,
    redirect_url:    redirectUrl,
    payment_options: getPaymentOptions(paymentMethod),
    customer: {
      email:       customerEmail,
      name:        customerName,
      phonenumber: customerPhone,
    },
    customizations: {
      title:       'IMA Awards — Vote',
      description,
      logo:        `${process.env.BASE_URL || 'http://localhost:5000'}/logo.png`,
    },
    meta: {
      source:         'IMA-Awards',
      transactionRef: txRef,
      ...meta,
    },
  };

  const data = await flwFetch('/payments', 'POST', payload);

  if (!data?.data?.link) {
    throw new Error('Flutterwave: lien de paiement non reçu dans la réponse');
  }

  return { checkoutUrl: data.data.link, txRef };
};

// ─── Vérification de transaction ──────────────────────────────────────────────
/**
 * Vérifie le statut d'une transaction par son ID Flutterwave
 * Retourne { status, amount, currency, txRef, flwRef }
 */
export const verifyFlutterwaveTransaction = async (transactionId) => {
  const data = await flwFetch(`/transactions/${transactionId}/verify`);
  return {
    status:   data.data?.status,   // 'successful' | 'failed' | 'pending'
    amount:   data.data?.amount,
    currency: data.data?.currency,
    txRef:    data.data?.tx_ref,
    flwRef:   data.data?.flw_ref,
    raw:      data.data,
  };
};

// ─── Vérification webhook ─────────────────────────────────────────────────────
/**
 * Vérifie la signature du webhook Flutterwave (header: verif-hash)
 */
export const verifyWebhookSignature = (req) => {
  const expectedHash = process.env.FLW_WEBHOOK_HASH || FLW_SECRET_KEY;
  const receivedHash = req.headers['verif-hash'];
  if (!receivedHash) return false;
  return receivedHash === expectedHash;
};

export default { initFlutterwavePayment, verifyFlutterwaveTransaction, verifyWebhookSignature };
