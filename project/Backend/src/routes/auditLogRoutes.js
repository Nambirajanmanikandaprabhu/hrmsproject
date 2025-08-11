import express from 'express';
import { z } from 'zod';
import {
  authenticate as authMiddleware,
  authorize as roleMiddleware
} from '../middleware/auth.js';

const router = express.Router();

// Validation schema
const auditLogSchema = z.object({
  userId: z.string().uuid('Invalid user ID').optional(),
  action: z.enum(['CREATE', 'UPDATE', 'DELETE', 'VIEW']).optional(),
  resource: z.string().optional(),
  page: z.string().optional().transform((val) => (val ? Math.max(1, parseInt(val)) : 1)),
  limit: z.string().optional().transform((val) => (val ? Math.min(parseInt(val), 100) : 10)),
});

// Middleware
const validateAuditLog = (req, res, next) => {
  const result = auditLogSchema.safeParse(req.query);
  if (!result.success) {
    return res.status(400).json({ error: result.error.format() });
  }
  req.validatedData = result.data;
  next();
};

// GET / - List audit logs
router.get('/', authMiddleware, roleMiddleware('ADMIN', 'HR'), validateAuditLog, async (req, res) => {
  const { page, limit, userId, action, resource } = req.validatedData;
  const filters = {};
  if (userId) filters.userId = userId;
  if (action) filters.action = action;
  if (resource) filters.resource = resource;

  try {
    const logs = [];
    const total = 0;

    res.json({
      success: true,
      data: { logs, total, page, limit },
    });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /:id - Get single audit log
router.get('/:id', authMiddleware, roleMiddleware('ADMIN', 'HR'), async (req, res) => {
  const { id } = req.params;
  try {
    const log = { id, userId: 'uuid', action: 'CREATE', resource: 'department' };
    if (!log) {
      return res.status(404).json({ error: 'Log not found' });
    }
    res.json({ success: true, data: log });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
