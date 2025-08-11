import express from 'express';
import { z } from 'zod';
import { authenticate, authorize, authorizeEmployee } from '../middleware/auth.js';
import { validate } from '../middleware/validation.js';
import { createAuditLog } from '../middleware/auditMiddleware.js';
import { AppError, ValidationError } from '../utils/errors.js';
import prisma from '../config/prisma.js';

const router = express.Router();

// Validation schema
const leaveBalanceSchemas = {
  create: z.object({
    body: z.object({
      employeeId: z.string().uuid('Invalid employee ID'),
      policyId: z.string().uuid('Invalid policy ID'),
      year: z.number().min(2000, 'Invalid year'),
      allocated: z.number().min(0, 'Allocated days must be non-negative'),
      carryForward: z.number().min(0).optional().default(0),
    }),
  }),
  update: z.object({
    params: z.object({ id: z.string().uuid('Invalid balance ID') }),
    body: z.object({
      allocated: z.number().min(0, 'Allocated days must be non-negative').optional(),
      used: z.number().min(0, 'Used days must be non-negative').optional(),
      carryForward: z.number().min(0).optional(),
    }),
  }),
  getAll: z.object({
    query: z.object({
      page: z.string().regex(/^\d+$/).optional().default('1'),
      limit: z.string().regex(/^\d+$/).optional().default('10'),
      employeeId: z.string().uuid('Invalid employee ID').optional(),
      year: z.string().regex(/^\d{4}$/).optional(),
    }),
  }),
};

// GET / - List balances
router.get(
  '/',
  authenticate,
  authorize('ADMIN', 'HR', 'MANAGER', 'EMPLOYEE'),
  validate(leaveBalanceSchemas.getAll),
  async (req, res, next) => {
    try {
      const { page, limit, employeeId, year } = req.validatedData.query;
      const skip = (parseInt(page) - 1) * parseInt(limit);
      
      const where = {};
      if (employeeId) where.employeeId = employeeId;
      if (year) where.year = parseInt(year);
      
      // Apply role-based filtering
      if (req.user.role === 'EMPLOYEE' && req.user.employee) {
        where.employeeId = req.user.employee.id;
      } else if (req.user.role === 'MANAGER' && req.user.employee) {
        // Manager can see balances for their subordinates
        const subordinates = await prisma.employee.findMany({
          where: { managerId: req.user.employee.id },
          select: { id: true },
        });
        const subordinateIds = subordinates.map(sub => sub.id);
        subordinateIds.push(req.user.employee.id); // Include self
        
        if (where.employeeId) {
          // Check if requested employee is accessible
          if (!subordinateIds.includes(where.employeeId)) {
            throw new AppError('Access denied', 403);
          }
        } else {
          where.employeeId = { in: subordinateIds };
        }
      }

      const [balances, total] = await Promise.all([
        prisma.leaveBalance.findMany({
          where,
          skip,
          take: parseInt(limit),
          include: {
            employee: {
              select: { id: true, firstName: true, lastName: true, employeeId: true },
            },
            policy: {
              select: { id: true, name: true, leaveType: true, daysAllowed: true },
            },
          },
          orderBy: [{ year: 'desc' }, { employee: { firstName: 'asc' } }],
        }),
        prisma.leaveBalance.count({ where }),
      ]);

      await createAuditLog(req.user.id, 'READ', 'leave_balances', null, null, null, req);

      res.json({
        success: true,
        data: {
          balances,
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

// GET /:id - Get balance details
router.get(
  '/:id',
  authenticate,
  authorize('ADMIN', 'HR', 'MANAGER', 'EMPLOYEE'),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      
      const balance = await prisma.leaveBalance.findUnique({
        where: { id },
        include: {
          employee: {
            select: { id: true, firstName: true, lastName: true, employeeId: true },
          },
          policy: {
            select: { id: true, name: true, leaveType: true, daysAllowed: true },
          },
        },
      });

      if (!balance) throw new AppError('Leave balance not found', 404);

      // Check access permissions
      if (req.user.role === 'EMPLOYEE' && req.user.employee?.id !== balance.employeeId) {
        throw new AppError('Access denied', 403);
      }

      await createAuditLog(req.user.id, 'READ', 'leave_balances', id, null, null, req);

      res.json({ success: true, data: { balance } });
    } catch (error) {
      next(error);
    }
  }
);

// POST / - Create balance
router.post(
  '/',
  authenticate,
  authorize('ADMIN', 'HR'),
  validate(leaveBalanceSchemas.create),
  async (req, res, next) => {
    try {
      const { employeeId, policyId, year, allocated, carryForward } = req.validatedData.body;

      // Validate employee exists
      const employee = await prisma.employee.findUnique({ where: { id: employeeId } });
      if (!employee) throw new ValidationError('Employee not found');

      // Validate policy exists
      const policy = await prisma.leavePolicy.findUnique({ where: { id: policyId } });
      if (!policy) throw new ValidationError('Leave policy not found');

      // Check if balance already exists for this employee, policy, and year
      const existingBalance = await prisma.leaveBalance.findFirst({
        where: { employeeId, policyId, year },
      });
      if (existingBalance) {
        throw new ValidationError('Leave balance already exists for this employee, policy, and year');
      }

      const remaining = allocated + carryForward;

      const balance = await prisma.leaveBalance.create({
        data: {
          employeeId,
          policyId,
          year,
          allocated,
          used: 0,
          remaining,
          carryForward,
        },
        include: {
          employee: {
            select: { id: true, firstName: true, lastName: true, employeeId: true },
          },
          policy: {
            select: { id: true, name: true, leaveType: true },
          },
        },
      });

      await createAuditLog(req.user.id, 'CREATE', 'leave_balances', balance.id, null, balance, req);

      res.status(201).json({
        success: true,
        message: 'Leave balance created successfully',
        data: { balance },
      });
    } catch (error) {
      next(error);
    }
  }
);

// PUT /:id - Update balance
router.put(
  '/:id',
  authenticate,
  authorize('ADMIN', 'HR'),
  validate(leaveBalanceSchemas.update),
  async (req, res, next) => {
    try {
      const { id } = req.validatedData.params;
      const { allocated, used, carryForward } = req.validatedData.body;

      const existingBalance = await prisma.leaveBalance.findUnique({ where: { id } });
      if (!existingBalance) throw new AppError('Leave balance not found', 404);

      const updateData = {};
      if (allocated !== undefined) updateData.allocated = allocated;
      if (used !== undefined) updateData.used = used;
      if (carryForward !== undefined) updateData.carryForward = carryForward;

      // Recalculate remaining if allocated, used, or carryForward changed
      if (allocated !== undefined || used !== undefined || carryForward !== undefined) {
        const newAllocated = allocated !== undefined ? allocated : existingBalance.allocated;
        const newUsed = used !== undefined ? used : existingBalance.used;
        const newCarryForward = carryForward !== undefined ? carryForward : existingBalance.carryForward;
        updateData.remaining = newAllocated + newCarryForward - newUsed;
      }

      const balance = await prisma.leaveBalance.update({
        where: { id },
        data: updateData,
        include: {
          employee: {
            select: { id: true, firstName: true, lastName: true, employeeId: true },
          },
          policy: {
            select: { id: true, name: true, leaveType: true },
          },
        },
      });

      await createAuditLog(req.user.id, 'UPDATE', 'leave_balances', id, existingBalance, balance, req);

      res.json({
        success: true,
        message: 'Leave balance updated successfully',
        data: { balance },
      });
    } catch (error) {
      next(error);
    }
  }
);

// DELETE /:id - Delete balance
router.delete(
  '/:id',
  authenticate,
  authorize('ADMIN', 'HR'),
  async (req, res, next) => {
    try {
      const { id } = req.params;

      const existingBalance = await prisma.leaveBalance.findUnique({
        where: { id },
        include: {
          employee: {
            include: {
              leaveRequests: {
                where: {
                  policyId: { equals: prisma.leaveBalance.findUnique({ where: { id } }).then(b => b?.policyId) },
                  status: { in: ['PENDING', 'APPROVED'] },
                },
              },
            },
          },
        },
      });

      if (!existingBalance) throw new AppError('Leave balance not found', 404);

      // Check if there are active leave requests for this balance
      const activeRequests = await prisma.leaveRequest.findMany({
        where: {
          employeeId: existingBalance.employeeId,
          policyId: existingBalance.policyId,
          status: { in: ['PENDING', 'APPROVED'] },
        },
      });

      if (activeRequests.length > 0) {
        throw new ValidationError('Cannot delete balance with active leave requests');
      }

      await prisma.leaveBalance.delete({ where: { id } });

      await createAuditLog(req.user.id, 'DELETE', 'leave_balances', id, existingBalance, null, req);

      res.json({
        success: true,
        message: 'Leave balance deleted successfully',
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
