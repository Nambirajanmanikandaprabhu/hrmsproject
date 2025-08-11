import express from 'express';
import { z } from 'zod';
import { authenticate, authorize } from '../middleware/auth.js';
import { validate } from '../middleware/validation.js';
import { createAuditLog } from '../middleware/auditMiddleware.js';
import { AppError, ValidationError } from '../utils/errors.js';
import prisma from '../config/prisma.js';

const router = express.Router();

// Validation schema
const trainingRecordSchemas = {
  create: z.object({
    body: z.object({
      employeeId: z.string().uuid('Invalid employee ID'),
      programId: z.string().uuid('Invalid program ID'),
    }),
  }),
  update: z.object({
    params: z.object({ id: z.string().uuid('Invalid record ID') }),
    body: z.object({
      startedAt: z.string().datetime().optional(),
      completedAt: z.string().datetime().optional(),
      score: z.number().min(0).max(100).optional(),
      certificate: z.string().optional(),
      notes: z.string().optional(),
    }),
  }),
  getAll: z.object({
    query: z.object({
      page: z.string().regex(/^\d+$/).optional().default('1'),
      limit: z.string().regex(/^\d+$/).optional().default('10'),
      employeeId: z.string().uuid('Invalid employee ID').optional(),
      programId: z.string().uuid('Invalid program ID').optional(),
    }),
  }),
};

// GET / - List records
router.get(
  '/',
  authenticate,
  authorize('ADMIN', 'HR', 'EMPLOYEE'),
  validate(trainingRecordSchemas.getAll),
  async (req, res, next) => {
    try {
      const { page, limit, employeeId, programId } = req.validatedData.query;
      const skip = (parseInt(page) - 1) * parseInt(limit);
      
      const where = {};
      if (employeeId) where.employeeId = employeeId;
      if (programId) where.programId = programId;
      
      // Apply role-based filtering
      if (req.user.role === 'EMPLOYEE' && req.user.employee) {
        where.employeeId = req.user.employee.id;
      }

      const [records, total] = await Promise.all([
        prisma.trainingRecord.findMany({
          where,
          skip,
          take: parseInt(limit),
          include: {
            employee: {
              select: { id: true, firstName: true, lastName: true, employeeId: true },
            },
            program: {
              select: { id: true, name: true, description: true, duration: true, isActive: true },
            },
          },
          orderBy: { enrolledAt: 'desc' },
        }),
        prisma.trainingRecord.count({ where }),
      ]);

      await createAuditLog(req.user.id, 'READ', 'training_records', null, null, null, req);

      res.json({
        success: true,
        data: {
          records,
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

// GET /:id - Get record details
router.get(
  '/:id',
  authenticate,
  authorize('ADMIN', 'HR', 'EMPLOYEE'),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      
      const record = await prisma.trainingRecord.findUnique({
        where: { id },
        include: {
          employee: {
            select: { id: true, firstName: true, lastName: true, employeeId: true },
          },
          program: {
            select: { id: true, name: true, description: true, duration: true },
          },
        },
      });

      if (!record) throw new AppError('Training record not found', 404);

      // Check access permissions for employees
      if (req.user.role === 'EMPLOYEE' && req.user.employee?.id !== record.employeeId) {
        throw new AppError('Access denied', 403);
      }

      await createAuditLog(req.user.id, 'READ', 'training_records', id, null, null, req);

      res.json({ success: true, data: { record } });
    } catch (error) {
      next(error);
    }
  }
);

// POST / - Create record
router.post(
  '/',
  authenticate,
  authorize('ADMIN', 'HR'),
  validate(trainingRecordSchemas.create),
  async (req, res, next) => {
    try {
      const { employeeId, programId } = req.validatedData.body;

      // Validate employee exists
      const employee = await prisma.employee.findUnique({
        where: { id: employeeId, employmentStatus: 'ACTIVE' },
      });
      if (!employee) throw new ValidationError('Employee not found or inactive');

      // Validate program exists
      const program = await prisma.trainingProgram.findUnique({
        where: { id: programId, isActive: true },
      });
      if (!program) throw new ValidationError('Training program not found or inactive');

      // Check if record already exists
      const existingRecord = await prisma.trainingRecord.findFirst({
        where: { employeeId, programId },
      });
      if (existingRecord) {
        throw new ValidationError('Employee is already enrolled in this training program');
      }

      const record = await prisma.trainingRecord.create({
        data: {
          employeeId,
          programId,
        },
        include: {
          employee: {
            select: { id: true, firstName: true, lastName: true, employeeId: true },
          },
          program: {
            select: { id: true, name: true, description: true },
          },
        },
      });

      await createAuditLog(req.user.id, 'CREATE', 'training_records', record.id, null, record, req);

      res.status(201).json({
        success: true,
        message: 'Training record created successfully',
        data: { record },
      });
    } catch (error) {
      next(error);
    }
  }
);

// PUT /:id - Update record
router.put(
  '/:id',
  authenticate,
  authorize('ADMIN', 'HR'),
  validate(trainingRecordSchemas.update),
  async (req, res, next) => {
    try {
      const { id } = req.validatedData.params;
      const updateData = req.validatedData.body;

      const existingRecord = await prisma.trainingRecord.findUnique({ where: { id } });
      if (!existingRecord) throw new AppError('Training record not found', 404);

      const formattedData = {
        ...updateData,
        startedAt: updateData.startedAt ? new Date(updateData.startedAt) : undefined,
        completedAt: updateData.completedAt ? new Date(updateData.completedAt) : undefined,
      };

      const record = await prisma.trainingRecord.update({
        where: { id },
        data: formattedData,
        include: {
          employee: {
            select: { id: true, firstName: true, lastName: true, employeeId: true },
          },
          program: {
            select: { id: true, name: true, description: true },
          },
        },
      });

      await createAuditLog(req.user.id, 'UPDATE', 'training_records', id, existingRecord, record, req);

      res.json({
        success: true,
        message: 'Training record updated successfully',
        data: { record },
      });
    } catch (error) {
      next(error);
    }
  }
);

// DELETE /:id - Delete record
router.delete(
  '/:id',
  authenticate,
  authorize('ADMIN', 'HR'),
  async (req, res, next) => {
    try {
      const { id } = req.params;

      const existingRecord = await prisma.trainingRecord.findUnique({ where: { id } });
      if (!existingRecord) throw new AppError('Training record not found', 404);

      await prisma.trainingRecord.delete({ where: { id } });

      await createAuditLog(req.user.id, 'DELETE', 'training_records', id, existingRecord, null, req);

      res.json({
        success: true,
        message: 'Training record deleted successfully',
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
