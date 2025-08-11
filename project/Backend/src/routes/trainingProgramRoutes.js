import express from 'express';
import { z } from 'zod';
import { authenticate, authorize } from '../middleware/auth.js';
import { validate } from '../middleware/validation.js';
import { createAuditLog } from '../middleware/auditMiddleware.js';
import { AppError, ValidationError } from '../utils/errors.js';
import prisma from '../config/prisma.js';

const router = express.Router();

// Validation schema
const trainingProgramSchemas = {
  create: z.object({
    body: z.object({
      name: z.string().min(1, 'Name is required'),
      description: z.string().optional(),
      duration: z.number().min(1, 'Duration must be at least 1 minute').optional(),
      isActive: z.boolean().optional().default(true),
    }),
  }),
  update: z.object({
    params: z.object({ id: z.string().uuid('Invalid program ID') }),
    body: z.object({
      name: z.string().min(1, 'Name is required').optional(),
      description: z.string().optional(),
      duration: z.number().min(1, 'Duration must be at least 1 minute').optional(),
      isActive: z.boolean().optional(),
    }),
  }),
  getAll: z.object({
    query: z.object({
      page: z.string().regex(/^\d+$/).optional().default('1'),
      limit: z.string().regex(/^\d+$/).optional().default('10'),
      isActive: z.enum(['true', 'false']).optional(),
    }),
  }),
};

// GET / - List programs
router.get(
  '/',
  authenticate,
  authorize('ADMIN', 'HR', 'MANAGER', 'EMPLOYEE'),
  validate(trainingProgramSchemas.getAll),
  async (req, res, next) => {
    try {
      const { page, limit, isActive } = req.validatedData.query;
      const skip = (parseInt(page) - 1) * parseInt(limit);
      
      const where = {};
      if (isActive !== undefined) where.isActive = isActive === 'true';

      const [programs, total] = await Promise.all([
        prisma.trainingProgram.findMany({
          where,
          skip,
          take: parseInt(limit),
          include: {
            trainingRecords: {
              select: { id: true, employeeId: true, enrolledAt: true, completedAt: true },
            },
            _count: {
              select: { trainingRecords: true },
            },
          },
          orderBy: { name: 'asc' },
        }),
        prisma.trainingProgram.count({ where }),
      ]);

      await createAuditLog(req.user.id, 'READ', 'training_programs', null, null, null, req);

      res.json({
        success: true,
        data: {
          programs,
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
  }
);

// GET /:id - Get program details
router.get(
  '/:id',
  authenticate,
  authorize('ADMIN', 'HR', 'MANAGER', 'EMPLOYEE'),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      
      const program = await prisma.trainingProgram.findUnique({
        where: { id },
        include: {
          trainingRecords: {
            include: {
              employee: {
                select: { id: true, firstName: true, lastName: true, employeeId: true },
              },
            },
            orderBy: { enrolledAt: 'desc' },
          },
        },
      });

      if (!program) throw new AppError('Training program not found', 404);

      await createAuditLog(req.user.id, 'READ', 'training_programs', id, null, null, req);

      res.json({ success: true, data: { program } });
    } catch (error) {
      next(error);
    }
  }
);

// POST / - Create program
router.post(
  '/',
  authenticate,
  authorize('ADMIN', 'HR'),
  validate(trainingProgramSchemas.create),
  async (req, res, next) => {
    try {
      const { name, description, duration, isActive } = req.validatedData.body;

      // Check if program name already exists
      const existingProgram = await prisma.trainingProgram.findFirst({
        where: { name },
      });
      if (existingProgram) {
        throw new ValidationError('Training program name already exists');
      }

      const program = await prisma.trainingProgram.create({
        data: {
          name,
          description,
          duration,
          isActive,
        },
      });

      await createAuditLog(req.user.id, 'CREATE', 'training_programs', program.id, null, program, req);

      res.status(201).json({
        success: true,
        message: 'Training program created successfully',
        data: { program },
      });
    } catch (error) {
      next(error);
    }
  }
);

// PUT /:id - Update program
router.put(
  '/:id',
  authenticate,
  authorize('ADMIN', 'HR'),
  validate(trainingProgramSchemas.update),
  async (req, res, next) => {
    try {
      const { id } = req.validatedData.params;
      const updateData = req.validatedData.body;

      const existingProgram = await prisma.trainingProgram.findUnique({ where: { id } });
      if (!existingProgram) throw new AppError('Training program not found', 404);

      // Check name uniqueness if name is being updated
      if (updateData.name && updateData.name !== existingProgram.name) {
        const nameConflict = await prisma.trainingProgram.findFirst({
          where: { name: updateData.name },
        });
        if (nameConflict) throw new ValidationError('Training program name already exists');
      }

      const program = await prisma.trainingProgram.update({
        where: { id },
        data: updateData,
      });

      await createAuditLog(req.user.id, 'UPDATE', 'training_programs', id, existingProgram, program, req);

      res.json({
        success: true,
        message: 'Training program updated successfully',
        data: { program },
      });
    } catch (error) {
      next(error);
    }
  }
);

// DELETE /:id - Soft delete program
router.delete(
  '/:id',
  authenticate,
  authorize('ADMIN', 'HR'),
  async (req, res, next) => {
    try {
      const { id } = req.params;

      const existingProgram = await prisma.trainingProgram.findUnique({
        where: { id },
        include: {
          trainingRecords: {
            where: { completedAt: null },
          },
        },
      });

      if (!existingProgram) throw new AppError('Training program not found', 404);

      // Check if program has active training records
      if (existingProgram.trainingRecords.length > 0) {
        throw new ValidationError('Cannot delete program with active training records');
      }

      const program = await prisma.trainingProgram.update({
        where: { id },
        data: { isActive: false },
      });

      await createAuditLog(req.user.id, 'DELETE', 'training_programs', id, existingProgram, program, req);

      res.json({
        success: true,
        message: 'Training program deleted successfully',
        data: { program },
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
