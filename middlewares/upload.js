// middlewares/upload.js
// Multer avec stockage en mémoire → upload vers Cloudinary
import multer from 'multer';

// Stockage en mémoire : le buffer est transmis à Cloudinary
const storage = multer.memoryStorage();

const fileFilter = (_req, file, cb) => {
  const allowed = ['image/jpeg','image/jpg','image/png','image/webp','image/gif'];
  if (allowed.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Format non supporté. Utilisez JPG, PNG, WEBP ou GIF.'), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 8 * 1024 * 1024, // 8 MB max
    files:    1,
  },
});

export default upload;
