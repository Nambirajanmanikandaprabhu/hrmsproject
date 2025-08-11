import express from 'express';
import { z } from 'zod';
import { authenticate, authorize } from '../middleware/auth.js';
import { validate } from '../middleware/validation.js';
import { createAuditLog } from '../middleware/auditMiddleware.js';
import { AppError, ValidationError } from '../utils/errors.js';
import prisma from '../config/prisma.js';

const router = express.Router();

// Validation schema
const settingSchemas = {
  create: z.object({
    body: z.object({
      key: z.string().min(1, 'Key is required'),
      value: z.string().min(1, 'Value is required'),
      description: z.string().optional(),
      category: z.string().optional(),
      isPublic: z.boolean().optional().default(false),
    }),
  }),
  update: z.object({
    params: z.object({ id: z.string().uuid('Invalid setting ID') }),
    body: z.object({
      key: z.string().min(1, 'Key is required').optional(),
      value: z.string().min(1, 'Value is required').optional(),
      description: z.string().optional(),
      category: z.string().optional(),
      isPublic: z.boolean().optional(),
    }),
  }),
  getAll: z.object({
    query: z.object({
      page: z.string().regex(/^\d+$/).optional().default('1'),
      limit: z.string().regex(/^\d+$/).optional().default('10'),
      category: z.string().optional(),
      isPublic: z.enum(['true', 'false']).optional(),
    }),
  }),
};

// GET / - List settings
router.get('/', authenticate, authorize('ADMIN'), validate(settingSchemas.getAll), async (req, res, next) => {
  try {
    const { page, limit, category, isPublic } = req.validatedData.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const where = {};
    if (category) where.category = category;
    if (isPublic !== undefined) where.isPublic = isPublic === 'true';

    const [settings, total] = await Promise.all([
      prisma.setting.findMany({
        where,
        skip,
        take: parseInt(limit),
        orderBy: { key: 'asc' },
      }),
      prisma.setting.count({ where }),
    ]);

    await createAuditLog(req.user.id, 'READ', 'settings', null, null, null, req);

    res.json({
      success: true,
      data: {
        settings,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          pages: Math.ceil(total / parseInt(limit)),
        },
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /:id - Get setting details
router.get('/:id', authenticate, authorize('ADMIN'), async (req, res, next) => {
  try {
    const { id } = req.params;
    
    const setting = await prisma.setting.findUnique({
      where: { id },
    });

    if (!setting) throw new AppError('Setting not found', 404);

    await createAuditLog(req.user.id, 'READ', 'settings', id, null, null, req);

    res.json({ success: true, data: { setting } });
  } catch (error) {
    next(error);
  }
});

// POST / - Create setting
router.post('/', authenticate, authorize('ADMIN'), validate(settingSchemas.create), async (req, res, next) => {
  try {
    const { key, value, description, category, isPublic } = req.validatedData.body;

    // Check if setting key already exists
    const existingSetting = await prisma.setting.findFirst({
      where: { key },
    });
    if (existingSetting) {
      throw new ValidationError('Setting key already exists');
    }

    const setting = await prisma.setting.create({
      data: {
        key,
        value,
        description,
        category,
        isPublic,
      },
    });

    await createAuditLog(req.user.id, 'CREATE', 'settings', setting.id, null, setting, req);

    res.status(201).json({
      success: true,
      message: 'Setting created successfully',
      data: { setting },
    });
  } catch (error) {
    next(error);
  }
});

// PUT /:id - Update setting
router.put('/:id', authenticate, authorize('ADMIN'), validate(settingSchemas.update), async (req, res, next) => {
  try {
    const { id } = req.validatedData.params;
    const updateData = req.validatedData.body;

    const existingSetting = await prisma.setting.findUnique({ where: { id } });
    if (!existingSetting) throw new AppError('Setting not found', 404);

    // Check key uniqueness if key is being updated
    if (updateData.key && updateData.key !== existingSetting.key) {
      const keyConflict = await prisma.setting.findFirst({
        where: { key: updateData.key },
      });
      if (keyConflict) throw new ValidationError('Setting key already exists');
    }

    const setting = await prisma.setting.update({
      where: { id },
      data: updateData,
    });

    await createAuditLog(req.user.id, 'UPDATE', 'settings', id, existingSetting, setting, req);

    res.json({
      success: true,
      message: 'Setting updated successfully',
      data: { setting },
    });
  } catch (error) {
    next(error);
  }
});

// DELETE /:id - Delete setting
router.delete('/:id', authenticate, authorize('ADMIN'), async (req, res, next) => {
  try {
    const { id } = req.params;

    const existingSetting = await prisma.setting.findUnique({ where: { id } });
    if (!existingSetting) throw new AppError('Setting not found', 404);

    await prisma.setting.delete({ where: { id } });

    await createAuditLog(req.user.id, 'DELETE', 'settings', id, existingSetting, null, req);

    res.json({
      success: true,
      message: 'Setting deleted successfully',
    });
  } catch (error) {
    next(error);
  }
});

export default router;
