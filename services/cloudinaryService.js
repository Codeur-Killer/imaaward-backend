// services/cloudinaryService.js
// Upload, suppression et gestion des images via Cloudinary
import { v2 as cloudinary } from 'cloudinary';

// Configuration (appelée une seule fois au démarrage)
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure:     true,
});

/**
 * Upload un fichier buffer vers Cloudinary
 * @param {Buffer} buffer  — données du fichier
 * @param {Object} options — folder, public_id, transformation...
 * @returns {Promise<{ url, publicId }>}
 */
export const uploadToCloudinary = (buffer, options = {}) =>
  new Promise((resolve, reject) => {
    const defaults = {
      folder:         options.folder || 'ima-awards',
      resource_type:  'image',
      quality:        'auto:good',
      fetch_format:   'auto',
      // Optimisation auto : WebP/AVIF selon le navigateur
      transformation: [{ quality: 'auto', fetch_format: 'auto' }],
      ...options,
    };

    const stream = cloudinary.uploader.upload_stream(defaults, (err, result) => {
      if (err) return reject(new Error(`Cloudinary upload failed: ${err.message}`));
      resolve({ url: result.secure_url, publicId: result.public_id });
    });

    stream.end(buffer);
  });

/**
 * Supprime une image sur Cloudinary via son publicId
 * Silencieux si l'image n'existe pas
 */
export const deleteFromCloudinary = async (publicId) => {
  if (!publicId) return;
  try {
    await cloudinary.uploader.destroy(publicId);
  } catch (e) {
    console.warn('⚠️  Cloudinary delete failed:', e.message);
  }
};

/**
 * Extrait le publicId depuis une URL Cloudinary
 * Ex: "https://res.cloudinary.com/dux7jctns/image/upload/v123/ima-awards/artist-abc.jpg"
 *     → "ima-awards/artist-abc"
 */
export const extractPublicId = (url) => {
  if (!url || !url.includes('cloudinary.com')) return null;
  try {
    const parts  = url.split('/upload/');
    if (parts.length < 2) return null;
    const after  = parts[1];                  // "v123/ima-awards/artist-abc.jpg"
    const noVer  = after.replace(/^v\d+\//, ''); // retirer la version
    const noExt  = noVer.replace(/\.[^.]+$/, ''); // retirer l'extension
    return noExt;
  } catch { return null; }
};

export default cloudinary;
