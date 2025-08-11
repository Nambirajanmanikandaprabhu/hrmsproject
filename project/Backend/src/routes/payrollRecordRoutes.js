import express from 'express';
import { z } from 'zod';
import { authenticate, authorize } from '../middleware/auth.js';
import { validate } from '../middleware/validation.js';
import { PrismaClient } from '@prisma/client';
import { AppError, NotFoundError, ValidationError } from '../utils/errors.js';
import { createAuditLog } from '../middleware/auditMiddleware.js';

const prisma = new PrismaClient();
const router = express.Router();

// Validation schemas
const payrollRecordSchema = z.object({
  body: z.object({
    employeeId: z.string().uuid('Invalid employee ID'),
    payPeriodStart: z.string().datetime('Invalid date format'),
    payPeriodEnd: z.string().datetime('Invalid date format'),
    baseSalary: z.number().min(0, 'Base salary must be non-negative'),
    overtime: z.number().min(0).optional().default(0),
    bonuses: z.number().min(0).optional().default(0),
    allowances: z.number().min(0).optional().default(0),
    deductions: z.number().min(0).optional().default(0),
    tax: z.number().min(0).optional().default(0),
    status: z.enum(['DRAFT', 'PROCESSED', 'PAID', 'CANCELLED']).optional().default('DRAFT'),
    notes: z.string().optional(),
  }),
});

const updatePayrollRecordSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid payroll record ID'),
  }),
  body: z.object({
    employeeId: z.string().uuid('Invalid employee ID').optional(),
    payPeriodStart: z.string().datetime('Invalid date format').optional(),
    payPeriodEnd: z.string().datetime('Invalid date format').optional(),
    baseSalary: z.number().min(0, 'Base salary must be non-negative').optional(),
    overtime: z.number().min(0).optional(),
    bonuses: z.number().min(0).optional(),
    allowances: z.number().min(0).optional(),
    deductions: z.number().min(0).optional(),
    tax: z.number().min(0).optional(),
    status: z.enum(['DRAFT', 'PROCESSED', 'PAID', 'CANCELLED']).optional(),
    notes: z.string().optional(),
  }),
});

const listPayrollRecordsSchema = z.object({
  query: z.object({
    page: z.string().regex(/^\d+$/).optional().default('1'),
    limit: z.string().regex(/^\d+$/).optional().default('10'),
    employeeId: z.string().uuid().optional(),
    status: z.enum(['DRAFT', 'PROCESSED', 'PAID', 'CANCELLED']).optional(),
    startDate: z.string().datetime().optional(),
    endDate: z.string().datetime().optional(),
  }),
});

// GET /: List payroll records
router.get('/', authenticate, authorize('ADMIN', 'HR', 'EMPLOYEE'), validate(listPayrollRecordsSchema), async (req, res, next) => {
  try {
    const { page, limit, employeeId, status, startDate, endDate } = req.validatedData.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const where = {};
    if (employeeId) where.employeeId = employeeId;
    if (status) where.status = status;
    if (startDate || endDate) {
      where.payPeriodStart = {};
      if (startDate) where.payPeriodStart.gte = new Date(startDate);
      if (endDate) where.payPeriodStart.lte = new Date(endDate);
    }

    if (req.user.role === 'EMPLOYEE' && req.user.employee) {
      where.employeeId = req.user.employee.id;
    }

    const [records, total] = await Promise.all([
      prisma.payrollRecord.findMany({
        where,
        skip,
        take: parseInt(limit),
        include: {
          employee: {
            select: {
              id: true,
              employeeId: true,
              firstName: true,
              lastName: true,
              email: true,
            },
          },
        },
        orderBy: { payPeriodStart: 'desc' },
      }),
      prisma.payrollRecord.count({ where }),
    ]);

    await createAuditLog(req.user.id, 'READ', 'payroll_records', null, null, null, req);

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
});

// GET /:id
router.get('/:id', authenticate, authorize('ADMIN', 'HR', 'EMPLOYEE'), async (req, res, next) => {
  try {
    const { id } = req.params;

    const record = await prisma.payrollRecord.findUnique({
      where: { id },
      include: {
        employee: {
          select: {
            id: true,
            employeeId: true,
            firstName: true,
            lastName: true,
            email: true,
            department: { select: { id: true, name: true } },
            position: { select: { id: true, title: true } },
          },
        },
      },
    });

    if (!record) throw new NotFoundError('Payroll record not found');

    if (req.user.role === 'EMPLOYEE' && req.user.employee?.id !== record.employeeId) {
      throw new AppError('Access denied', 403);
    }

    await createAuditLog(req.user.id, 'READ', 'payroll_records', id, null, null, req);

    res.json({ success: true, data: { record } });
  } catch (error) {
    next(error);
  }
});

// POST /: Create payroll record
router.post('/', authenticate, authorize('ADMIN', 'HR'), validate(payrollRecordSchema), async (req, res, next) => {
  try {
    const { employeeId, payPeriodStart, payPeriodEnd, baseSalary, overtime, bonuses, allowances, deductions, tax, status, notes } = req.validatedData.body;

    const employee = await prisma.employee.findUnique({ where: { id: employeeId } });
    if (!employee) throw new ValidationError('Employee not found');

    const grossPay = baseSalary + overtime + bonuses + allowances;
    const netPay = grossPay - deductions - tax;

    const record = await prisma.payrollRecord.create({
      data: {
        employeeId,
        payPeriodStart: new Date(payPeriodStart),
        payPeriodEnd: new Date(payPeriodEnd),
        baseSalary,
        overtime,
        bonuses,
        allowances,
        deductions,
        tax,
        netPay,
        status,
        notes,
      },
      include: {
        employee: {
          select: {
            id: true,
            employeeId: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
      },
    });

    await createAuditLog(req.user.id, 'CREATE', 'payroll_records', record.id, null, record, req);

    res.status(201).json({ success: true, message: 'Payroll record created successfully', data: { record } });
  } catch (error) {
    next(error);
  }
});

// PUT /:id
router.put('/:id', authenticate, authorize('ADMIN', 'HR'), validate(updatePayrollRecordSchema), async (req, res, next) => {
  try {
    const { id } = req.validatedData.params;
    const updateData = req.validatedData.body;

    const existingRecord = await prisma.payrollRecord.findUnique({ where: { id } });
    if (!existingRecord) throw new NotFoundError('Payroll record not found');

    if (updateData.employeeId) {
      const employee = await prisma.employee.findUnique({ where: { id: updateData.employeeId } });
      if (!employee) throw new ValidationError('Employee not found');
    }

    if (['baseSalary', 'overtime', 'bonuses', 'allowances', 'deductions', 'tax'].some((key) => updateData[key] !== undefined)) {
      const baseSalary = updateData.baseSalary ?? existingRecord.baseSalary;
      const overtime = updateData.overtime ?? existingRecord.overtime;
      const bonuses = updateData.bonuses ?? existingRecord.bonuses;
      const allowances = updateData.allowances ?? existingRecord.allowances;
      const deductions = updateData.deductions ?? existingRecord.deductions;
      const tax = updateData.tax ?? existingRecord.tax;

      const grossPay = baseSalary + overtime + bonuses + allowances;
      updateData.netPay = grossPay - deductions - tax;
    }

    if (updateData.payPeriodStart) updateData.payPeriodStart = new Date(updateData.payPeriodStart);
    if (updateData.payPeriodEnd) updateData.payPeriodEnd = new Date(updateData.payPeriodEnd);

    const record = await prisma.payrollRecord.update({
      where: { id },
      data: updateData,
      include: {
        employee: {
          select: {
            id: true,
            employeeId: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
      },
    });

    await createAuditLog(req.user.id, 'UPDATE', 'payroll_records', id, existingRecord, record, req);

    res.json({ success: true, message: 'Payroll record updated successfully', data: { record } });
  } catch (error) {
    next(error);
  }
});

// DELETE /:id
router.delete('/:id', authenticate, authorize('ADMIN', 'HR'), async (req, res, next) => {
  try {
    const { id } = req.params;

    const existingRecord = await prisma.payrollRecord.findUnique({ where: { id } });
    if (!existingRecord) throw new NotFoundError('Payroll record not found');

    if (['PROCESSED', 'PAID'].includes(existingRecord.status)) {
      throw new ValidationError('Cannot delete processed or paid payroll records');
    }

    await prisma.payrollRecord.delete({ where: { id } });

    await createAuditLog(req.user.id, 'DELETE', 'payroll_records', id, existingRecord, null, req);

    res.json({ success: true, message: 'Payroll record deleted successfully' });
  } catch (error) {
    next(error);
  }
});

export default router;
