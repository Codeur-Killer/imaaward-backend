// routes/partnerRoutes.js
import express from 'express';
import {
  getPartners, getAllPartners,
  createPartner, updatePartner, deletePartner,
} from '../controllers/partnerController.js';
import { protect, authorize } from '../middlewares/authMiddleware.js';
import upload from '../middlewares/upload.js';

const router = express.Router();

// ── Public ────────────────────────────────────────────────────────────────────
router.get('/', getPartners);  // retourne seulement les actifs

// ── Admin ─────────────────────────────────────────────────────────────────────
router.get   ('/admin/all',  protect, authorize('admin','super_admin'), getAllPartners);
router.post  ('/',           protect, authorize('admin','super_admin'), upload.single('logo'), createPartner);
router.put   ('/:id',        protect, authorize('admin','super_admin'), upload.single('logo'), updatePartner);
router.delete('/:id',        protect, authorize('admin','super_admin'), deletePartner);

export default router;
