import express from 'express';
import { z } from 'zod';
import { authenticate, authorize } from '../middleware/auth.js';
import { validate } from '../middleware/validation.js';
import { createAuditLog } from '../middleware/auditMiddleware.js';
import { AppError, ValidationError } from '../utils/errors.js';
import prisma from '../config/prisma.js';

const router = express.Router();

// Validation schema
const leavePolicySchemas = {
  create: z.object({
    body: z.object({
      name: z.string().min(1, 'Name is required'),
      leaveType: z.enum(['ANNUAL', 'SICK', 'MATERNITY', 'PATERNITY', 'EMERGENCY', 'UNPAID', 'SABBATICAL']),
      daysAllowed: z.number().min(0, 'Days allowed must be non-negative'),
      carryForward: z.boolean().optional().default(false),
      maxCarryForward: z.number().min(0).optional(),
      isActive: z.boolean().optional().default(true),
    }),
  }),
  update: z.object({
    params: z.object({ id: z.string().uuid('Invalid policy ID') }),
    body: z.object({
      name: z.string().min(1, 'Name is required').optional(),
      leaveType: z.enum(['ANNUAL', 'SICK', 'MATERNITY', 'PATERNITY', 'EMERGENCY', 'UNPAID', 'SABBATICAL']).optional(),
      daysAllowed: z.number().min(0, 'Days allowed must be non-negative').optional(),
      carryForward: z.boolean().optional(),
      maxCarryForward: z.number().min(0).optional(),
      isActive: z.boolean().optional(),
    }),
  }),
  getAll: z.object({
    query: z.object({
      page: z.string().regex(/^\d+$/).optional().default('1'),
      limit: z.string().regex(/^\d+$/).optional().default('10'),
      leaveType: z.enum(['ANNUAL', 'SICK', 'MATERNITY', 'PATERNITY', 'EMERGENCY', 'UNPAID', 'SABBATICAL']).optional(),
      isActive: z.enum(['true', 'false']).optional(),
    }),
  }),
};

// GET / - List policies
router.get(
  '/',
  authenticate,
  authorize('ADMIN', 'HR', 'MANAGER', 'EMPLOYEE'),
  validate(leavePolicySchemas.getAll),
  async (req, res, next) => {
    try {
      const { page, limit, leaveType, isActive } = req.validatedData.query;
      const skip = (parseInt(page) - 1) * parseInt(limit);
      
      const where = {};
      if (leaveType) where.leaveType = leaveType;
      if (isActive !== undefined) where.isActive = isActive === 'true';

      const [policies, total] = await Promise.all([
        prisma.leavePolicy.findMany({
          where,
          skip,
          take: parseInt(limit),
          orderBy: { name: 'asc' },
        }),
        prisma.leavePolicy.count({ where }),
      ]);

      await createAuditLog(req.user.id, 'READ', 'leave_policies', null, null, null, req);

      res.json({
        success: true,
        data: {
          policies,
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

// GET /:id - Get policy details
router.get(
  '/:id',
  authenticate,
  authorize('ADMIN', 'HR', 'MANAGER', 'EMPLOYEE'),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      
      const policy = await prisma.leavePolicy.findUnique({
        where: { id },
        include: {
          leaveBalances: {
            include: {
              employee: {
                select: { id: true, firstName: true, lastName: true, employeeId: true },
              },
            },
          },
          leaveRequests: {
            include: {
              employee: {
                select: { id: true, firstName: true, lastName: true, employeeId: true },
              },
            },
            orderBy: { appliedAt: 'desc' },
            take: 10,
          },
        },
      });

      if (!policy) throw new AppError('Leave policy not found', 404);

      await createAuditLog(req.user.id, 'READ', 'leave_policies', id, null, null, req);

      res.json({ success: true, data: { policy } });
    } catch (error) {
      next(error);
    }
  }
);

// POST / - Create policy
router.post(
  '/',
  authenticate,
  authorize('ADMIN', 'HR'),
  validate(leavePolicySchemas.create),
  async (req, res, next) => {
    try {
      const { name, leaveType, daysAllowed, carryForward, maxCarryForward, isActive } = req.validatedData.body;

      // Check if policy name already exists
      const existingPolicy = await prisma.leavePolicy.findFirst({
        where: { name },
      });
      if (existingPolicy) {
        throw new ValidationError('Leave policy name already exists');
      }

      const policy = await prisma.leavePolicy.create({
        data: {
          name,
          leaveType,
          daysAllowed,
          carryForward,
          maxCarryForward,
          isActive,
        },
      });

      await createAuditLog(req.user.id, 'CREATE', 'leave_policies', policy.id, null, policy, req);

      res.status(201).json({
        success: true,
        message: 'Leave policy created successfully',
        data: { policy },
      });
    } catch (error) {
      next(error);
    }
  }
);

// PUT /:id - Update policy
router.put(
  '/:id',
  authenticate,
  authorize('ADMIN', 'HR'),
  validate(leavePolicySchemas.update),
  async (req, res, next) => {
    try {
      const { id } = req.validatedData.params;
      const updateData = req.validatedData.body;

      const existingPolicy = await prisma.leavePolicy.findUnique({ where: { id } });
      if (!existingPolicy) throw new AppError('Leave policy not found', 404);

      // Check name uniqueness if name is being updated
      if (updateData.name && updateData.name !== existingPolicy.name) {
        const nameConflict = await prisma.leavePolicy.findFirst({
          where: { name: updateData.name },
        });
        if (nameConflict) throw new ValidationError('Leave policy name already exists');
      }

      const policy = await prisma.leavePolicy.update({
        where: { id },
        data: updateData,
      });

      await createAuditLog(req.user.id, 'UPDATE', 'leave_policies', id, existingPolicy, policy, req);

      res.json({
        success: true,
        message: 'Leave policy updated successfully',
        data: { policy },
      });
    } catch (error) {
      next(error);
    }
  }
);

// DELETE /:id - Soft delete policy
router.delete(
  '/:id',
  authenticate,
  authorize('ADMIN', 'HR'),
  async (req, res, next) => {
    try {
      const { id } = req.params;

      const existingPolicy = await prisma.leavePolicy.findUnique({
        where: { id },
        include: {
          leaveBalances: true,
          leaveRequests: { where: { status: { in: ['PENDING', 'APPROVED'] } } },
        },
      });

      if (!existingPolicy) throw new AppError('Leave policy not found', 404);

      // Check if policy has active leave requests
      if (existingPolicy.leaveRequests.length > 0) {
        throw new ValidationError('Cannot delete policy with active leave requests');
      }

      const policy = await prisma.leavePolicy.update({
        where: { id },
        data: { isActive: false },
      });

      await createAuditLog(req.user.id, 'DELETE', 'leave_policies', id, existingPolicy, policy, req);

      res.json({
        success: true,
        message: 'Leave policy deleted successfully',
        data: { policy },
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
